/**
 * Browser-only inspection store for NyayaPack (GitHub issue #4:
 * "Save multiple package photographs locally").
 *
 * One inspection covers one physical package and holds several photographs.
 * Image BYTES are persisted in IndexedDB (never `blob:` URLs, never
 * localStorage), so reopening an inspection after a reload shows the same
 * photographs. There is no server database and no sync.
 *
 * Intended owner/integrator: the scan-page agent renders add / preview /
 * remove UI on top of this module. This module performs no network or DOM
 * rendering; the only DOM-adjacent helper is {@link createPhotoObjectUrl},
 * which turns a stored Blob into a preview URL the UI must revoke.
 *
 * Storage schema (IndexedDB database `nyayapack`, version 1):
 * - store `inspections` (keyPath `inspectionId`): inspection metadata plus
 *   per-photo metadata ({photoId, name, type, size, addedAt}). No bytes here,
 *   so listing inspections stays cheap.
 * - store `photo-bytes` (keyPath `photoId`, index `by-inspection` on
 *   `inspectionId`): one record per photo, `{photoId, inspectionId, blob}`.
 *   The Blob holds the original image bytes.
 *
 * Legacy data: old reports live in localStorage under `lm_reports` with
 * short-lived `blob:` image URLs that cannot be restored after reload. This
 * module NEVER writes to or erases `lm_reports`; {@link listLegacyReports}
 * is a read-only lens that flags unrestorable images via
 * `evidenceUnavailable` instead of inventing an image.
 */

import { log } from "./log";

/** Lifecycle of one inspection. */
export type InspectionStatus = "draft" | "analyzed" | "confirmed";

/**
 * Broad retail category hint. `"auto"` lets the model suggest a category;
 * a manual choice wins over model inference (PRD user stories 4-6).
 */
export type CategoryHint =
  | "auto"
  | "food-beverages"
  | "personal-care"
  | "household"
  | "other"
  | (string & {});

export const CATEGORY_HINTS: readonly CategoryHint[] = [
  "auto",
  "food-beverages",
  "personal-care",
  "household",
  "other",
] as const;

export const DEFAULT_CATEGORY_HINT: CategoryHint = "auto";

/** One photograph belonging to an inspection, with its image bytes. */
export interface InspectionPhoto {
  /** Stable ID (`crypto.randomUUID()`), used by model observations/exports. */
  photoId: string;
  /** Original file name (falls back to `photo-<n>` for nameless Blobs). */
  name: string;
  /** MIME type as supplied by the uploader (may be empty). */
  type: string;
  /** Byte size of `blob`. */
  size: number;
  /** ISO timestamp of when the photo was added. */
  addedAt: string;
  /** Original image bytes. Preview via `URL.createObjectURL(photo.blob)`. */
  blob: Blob;
}

/** A persisted inspection: one physical package, many photographs. */
export interface InspectionRecord {
  inspectionId: string;
  createdAt: string;
  updatedAt: string;
  categoryHint: CategoryHint;
  status: InspectionStatus;
  photos: InspectionPhoto[];
}

/**
 * Read-only view of an old `lm_reports` (localStorage) entry. `raw` is the
 * untouched legacy object; the store never migrates or fabricates bytes.
 */
export interface LegacyReportRef {
  id: string;
  productName: string;
  brand: string;
  scannedAt: string;
  imageUrl: string;
  /**
   * True when the image cannot be restored (a `blob:` URL that died on
   * reload, or no image reference at all). The UI must show "evidence
   * unavailable" rather than inventing an image.
   */
  evidenceUnavailable: boolean;
  raw: unknown;
}

/** Machine-readable storage failure codes. Thrown, never swallowed. */
export type StorageErrorCode =
  | "unavailable"
  | "quota-exceeded"
  | "not-found"
  | "photo-not-found"
  | "invalid-argument";

/**
 * Typed storage error. Every write failure rejects with this (or a subclass
 * instance of it) so callers can distinguish "not saved" from success and
 * must never claim evidence was saved when it was not.
 */
export class InspectionStoreError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "InspectionStoreError";
    this.code = code;
  }
}

/** Short copy for inspect/dashboard/repository banners. Raw causes stay in the log. */
export function describeStoreError(err: unknown): { title: string; detail: string } {
  if (err instanceof InspectionStoreError) {
    switch (err.code) {
      case "unavailable":
        return {
          title: "Browser storage is unavailable",
          detail: "Photos and inspections cannot be saved in this browser.",
        };
      case "quota-exceeded":
        return {
          title: "This browser is out of storage",
          detail: "Remove old inspections, then try again. Nothing new was saved.",
        };
      case "not-found":
        return {
          title: "That inspection was not found",
          detail: "It may have been deleted in this browser.",
        };
      case "photo-not-found":
        return {
          title: "That photograph was not found",
          detail: "It may already have been removed.",
        };
      case "invalid-argument":
        return {
          title: "That could not be saved",
          detail: "Try again with a photograph of the package.",
        };
    }
  }
  return {
    title: "Browser storage failed",
    detail: "Nothing new was saved. Try again.",
  };
}

// ---------------------------------------------------------------------------
// Internal schema / IndexedDB plumbing (no external dependencies).
// ---------------------------------------------------------------------------

const DB_NAME = "nyayapack";
const DB_VERSION = 1;
const INSPECTIONS_STORE = "inspections";
const PHOTO_BYTES_STORE = "photo-bytes";
const PHOTO_INSPECTION_INDEX = "by-inspection";
const LEGACY_REPORTS_KEY = "lm_reports";

/** What `inspections` store rows look like (metadata only, no bytes). */
interface StoredInspection {
  inspectionId: string;
  createdAt: string;
  updatedAt: string;
  categoryHint: CategoryHint;
  status: InspectionStatus;
  photos: Array<{
    photoId: string;
    name: string;
    type: string;
    size: number;
    addedAt: string;
  }>;
}

/** What `photo-bytes` store rows look like (the actual image bytes). */
interface StoredPhotoBytes {
  photoId: string;
  inspectionId: string;
  blob: Blob;
}

/** Describes the IndexedDB layout for tests/debug tooling. */
export const storageSchema = {
  dbName: DB_NAME,
  version: DB_VERSION,
  inspectionsStore: INSPECTIONS_STORE,
  photoBytesStore: PHOTO_BYTES_STORE,
  photoInspectionIndex: PHOTO_INSPECTION_INDEX,
  legacyReportsKey: LEGACY_REPORTS_KEY,
} as const;

let openPromise: Promise<IDBDatabase> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function noop(): void {
  // Intentionally empty: absorbs a duplicate transaction rejection that is
  // already surfaced through the failed request promise.
}

/** Stable IDs via `crypto.randomUUID()` with a non-crypto fallback. */
function randomId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new DOMException("IndexedDB request failed", "UnknownError"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new DOMException("IndexedDB transaction failed", "UnknownError"));
    tx.onabort = () =>
      reject(tx.error ?? new DOMException("IndexedDB transaction aborted", "AbortError"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(INSPECTIONS_STORE)) {
        db.createObjectStore(INSPECTIONS_STORE, { keyPath: "inspectionId" });
      }
      if (!db.objectStoreNames.contains(PHOTO_BYTES_STORE)) {
        const bytes = db.createObjectStore(PHOTO_BYTES_STORE, { keyPath: "photoId" });
        bytes.createIndex(PHOTO_INSPECTION_INDEX, "inspectionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      openPromise = null;
      reject(request.error ?? new DOMException("Could not open IndexedDB", "UnknownError"));
    };
  });
  return openPromise;
}

function toStoreError(err: unknown, op: string): InspectionStoreError {
  if (err instanceof InspectionStoreError) return err;
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "";
  const detail = err instanceof Error ? err.message : String(err);
  if (name === "QuotaExceededError" || /quota/i.test(detail)) {
    const quota = new InspectionStoreError(
      "quota-exceeded",
      `Cannot ${op}: browser storage is full. No data was saved; free space or remove old inspections and retry.`,
      { cause: err },
    );
    log.error("store", "quota_exceeded", quota.message, {
      code: quota.code,
      data: { op, cause: detail },
    });
    return quota;
  }
  const unavailable = new InspectionStoreError(
    "unavailable",
    `Cannot ${op}: browser storage is unavailable (${detail || name || "unknown error"}). No data was saved.`,
    { cause: err },
  );
  log.error("store", "unavailable", unavailable.message, {
    code: unavailable.code,
    data: { op, cause: detail, name },
  });
  return unavailable;
}

function assertAvailable(): void {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    throw new InspectionStoreError(
      "unavailable",
      "IndexedDB is not available in this environment (SSR or storage blocked). No data was saved.",
    );
  }
}

/** Join stored metadata with byte rows; throws honestly on missing bytes. */
function joinInspection(
  stored: StoredInspection,
  blobsByPhotoId: Map<string, Blob>,
): InspectionRecord {
  const photos: InspectionPhoto[] = stored.photos.map((meta) => {
    const blob = blobsByPhotoId.get(meta.photoId);
    if (!blob) {
      throw new InspectionStoreError(
        "unavailable",
        `Photo bytes are missing for photo "${meta.photoId}" in inspection "${stored.inspectionId}". ` +
          `Storage may be corrupted; the photo was not restored and no image was invented.`,
      );
    }
    return { ...meta, blob };
  });
  return {
    inspectionId: stored.inspectionId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    categoryHint: stored.categoryHint,
    status: stored.status,
    photos,
  };
}

async function readPhotoBlobs(
  db: IDBDatabase,
  inspectionId: string,
): Promise<Map<string, Blob>> {
  const tx = db.transaction(PHOTO_BYTES_STORE, "readonly");
  const index = tx.objectStore(PHOTO_BYTES_STORE).index(PHOTO_INSPECTION_INDEX);
  const rows = (await requestToPromise(index.getAll(inspectionId))) as StoredPhotoBytes[];
  const map = new Map<string, Blob>();
  for (const row of rows) {
    if (row && typeof row.photoId === "string" && row.blob instanceof Blob) {
      map.set(row.photoId, row.blob);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * True when IndexedDB can be used (false during SSR or when storage is
 * blocked). The scan UI can use this to show an "evidence cannot be saved"
 * state before the operator starts photographing.
 */
export function isStorageAvailable(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

/**
 * Create a new draft inspection for one physical package.
 * Call this when the first photograph is saved, not on a bare page visit.
 */
export async function createInspection(input?: {
  categoryHint?: CategoryHint;
}): Promise<InspectionRecord> {
  assertAvailable();
  const now = nowIso();
  const stored: StoredInspection = {
    inspectionId: randomId("insp"),
    createdAt: now,
    updatedAt: now,
    categoryHint: input?.categoryHint ?? DEFAULT_CATEGORY_HINT,
    status: "draft",
    photos: [],
  };
  try {
    const db = await openDatabase();
    const tx = db.transaction(INSPECTIONS_STORE, "readwrite");
    const done = transactionDone(tx);
    done.catch(noop);
    await requestToPromise(tx.objectStore(INSPECTIONS_STORE).put(stored));
    await done;
    return { ...stored, photos: [] };
  } catch (err) {
    throw toStoreError(err, "create inspection");
  }
}

/**
 * Append photo files to an inspection. Each file gets a stable
 * `crypto.randomUUID()` photoId. Bytes and metadata are committed in one
 * transaction: on quota/full-storage failure the promise rejects with
 * `code: "quota-exceeded"` and the caller must NOT claim the photos saved.
 */
export async function addPhotos(
  inspectionId: string,
  files: File[],
): Promise<InspectionRecord> {
  assertAvailable();
  if (!inspectionId || typeof inspectionId !== "string") {
    throw new InspectionStoreError("invalid-argument", "addPhotos requires an inspectionId.");
  }
  if (!Array.isArray(files)) {
    throw new InspectionStoreError("invalid-argument", "addPhotos requires a File array.");
  }
  for (const file of files) {
    if (!(file instanceof Blob) || file.size === 0) {
      throw new InspectionStoreError(
        "invalid-argument",
        "addPhotos received an empty or invalid file; nothing was saved.",
      );
    }
  }
  try {
    const db = await openDatabase();
    // Fast path: no-op read so an empty drop never touches storage.
    if (files.length === 0) {
      const current = await getInspection(inspectionId);
      if (!current) {
        throw new InspectionStoreError("not-found", `Inspection not found: ${inspectionId}`);
      }
      return current;
    }
    const tx = db.transaction([INSPECTIONS_STORE, PHOTO_BYTES_STORE], "readwrite");
    const done = transactionDone(tx);
    done.catch(noop);
    const inspections = tx.objectStore(INSPECTIONS_STORE);
    const bytes = tx.objectStore(PHOTO_BYTES_STORE);
    const existing = (await requestToPromise(
      inspections.get(inspectionId),
    )) as StoredInspection | undefined;
    if (!existing) {
      throw new InspectionStoreError("not-found", `Inspection not found: ${inspectionId}`);
    }
    const now = nowIso();
    const metas: StoredInspection["photos"] = files.map((file, i) => {
      const f = file as File;
      const fallbackName = `photo-${existing.photos.length + i + 1}`;
      return {
        photoId: randomId("photo"),
        name:
          typeof f.name === "string" && f.name.length > 0 ? f.name : fallbackName,
        type: typeof file.type === "string" ? file.type : "",
        size: file.size,
        addedAt: now,
      };
    });
    for (let i = 0; i < metas.length; i++) {
      const row: StoredPhotoBytes = {
        photoId: metas[i].photoId,
        inspectionId,
        blob: files[i],
      };
      await requestToPromise(bytes.put(row));
    }
    const updated: StoredInspection = {
      ...existing,
      updatedAt: now,
      photos: [...existing.photos, ...metas],
    };
    await requestToPromise(inspections.put(updated));
    await done;
    return {
      inspectionId: updated.inspectionId,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      categoryHint: updated.categoryHint,
      status: updated.status,
      photos: metas.map((meta, i) => ({ ...meta, blob: files[i] })),
    };
  } catch (err) {
    throw toStoreError(err, "add photos");
  }
}

/**
 * Remove one photo (metadata + bytes) from an inspection. Rejects with
 * `code: "photo-not-found"` when the photo is not part of the inspection,
 * or `"not-found"` when the inspection does not exist.
 */
export async function removePhoto(
  inspectionId: string,
  photoId: string,
): Promise<InspectionRecord> {
  assertAvailable();
  if (!inspectionId || !photoId) {
    throw new InspectionStoreError(
      "invalid-argument",
      "removePhoto requires an inspectionId and a photoId.",
    );
  }
  try {
    const db = await openDatabase();
    const tx = db.transaction([INSPECTIONS_STORE, PHOTO_BYTES_STORE], "readwrite");
    const done = transactionDone(tx);
    done.catch(noop);
    const inspections = tx.objectStore(INSPECTIONS_STORE);
    const bytes = tx.objectStore(PHOTO_BYTES_STORE);
    const existing = (await requestToPromise(
      inspections.get(inspectionId),
    )) as StoredInspection | undefined;
    if (!existing) {
      throw new InspectionStoreError("not-found", `Inspection not found: ${inspectionId}`);
    }
    if (!existing.photos.some((p) => p.photoId === photoId)) {
      throw new InspectionStoreError(
        "photo-not-found",
        `Photo "${photoId}" is not part of inspection "${inspectionId}".`,
      );
    }
    const index = bytes.index(PHOTO_INSPECTION_INDEX);
    const rows = (await requestToPromise(
      index.getAll(inspectionId),
    )) as StoredPhotoBytes[];
    const remaining = new Map<string, Blob>();
    for (const row of rows) {
      if (row && row.photoId !== photoId && row.blob instanceof Blob) {
        remaining.set(row.photoId, row.blob);
      }
    }
    await requestToPromise(bytes.delete(photoId));
    const updated: StoredInspection = {
      ...existing,
      updatedAt: nowIso(),
      photos: existing.photos.filter((p) => p.photoId !== photoId),
    };
    await requestToPromise(inspections.put(updated));
    await done;
    return joinInspection(updated, remaining);
  } catch (err) {
    throw toStoreError(err, "remove photo");
  }
}

/**
 * Load one inspection with its photo bytes. Returns `null` when the id is
 * unknown. Photo bytes come from IndexedDB, so they survive a reload.
 */
export async function getInspection(inspectionId: string): Promise<InspectionRecord | null> {
  assertAvailable();
  if (!inspectionId) return null;
  try {
    const db = await openDatabase();
    const tx = db.transaction(INSPECTIONS_STORE, "readonly");
    const stored = (await requestToPromise(
      tx.objectStore(INSPECTIONS_STORE).get(inspectionId),
    )) as StoredInspection | undefined;
    if (!stored) return null;
    const blobs = await readPhotoBlobs(db, inspectionId);
    return joinInspection(stored, blobs);
  } catch (err) {
    throw toStoreError(err, "load inspection");
  }
}

/**
 * List all inspections, newest first, each with its photo bytes so the UI
 * can render previews directly. (Demo-scale choice: for very large
 * libraries a metadata-only list can be added later.)
 */
export async function listInspections(): Promise<InspectionRecord[]> {
  assertAvailable();
  try {
    const db = await openDatabase();
    const tx = db.transaction([INSPECTIONS_STORE, PHOTO_BYTES_STORE], "readonly");
    const storedList = (await requestToPromise(
      tx.objectStore(INSPECTIONS_STORE).getAll(),
    )) as StoredInspection[];
    const byteRows = (await requestToPromise(
      tx.objectStore(PHOTO_BYTES_STORE).getAll(),
    )) as StoredPhotoBytes[];
    const blobsByInspection = new Map<string, Map<string, Blob>>();
    for (const row of byteRows) {
      if (!row || typeof row.photoId !== "string" || !(row.blob instanceof Blob)) continue;
      let per = blobsByInspection.get(row.inspectionId);
      if (!per) {
        per = new Map<string, Blob>();
        blobsByInspection.set(row.inspectionId, per);
      }
      per.set(row.photoId, row.blob);
    }
    const sorted = [...storedList].sort((a, b) =>
      b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0,
    );
    return sorted.map((stored) =>
      joinInspection(stored, blobsByInspection.get(stored.inspectionId) ?? new Map()),
    );
  } catch (err) {
    throw toStoreError(err, "list inspections");
  }
}

/**
 * Upsert a full inspection record (e.g. after the reviewer changes the
 * category hint or status, or after analysis attaches results elsewhere).
 * All photo blobs in `record` are written; byte rows left over from photos
 * removed from `record.photos` are deleted so storage does not leak.
 * `updatedAt` is always set to now; `createdAt` is preserved. Every photo
 * must carry its Blob — a photo without bytes is rejected with
 * `"invalid-argument"` rather than silently saved imageless.
 */
export async function saveInspection(record: InspectionRecord): Promise<InspectionRecord> {
  assertAvailable();
  if (!record || typeof record.inspectionId !== "string" || record.inspectionId.length === 0) {
    throw new InspectionStoreError(
      "invalid-argument",
      "saveInspection requires a record with an inspectionId.",
    );
  }
  if (!Array.isArray(record.photos)) {
    throw new InspectionStoreError(
      "invalid-argument",
      "saveInspection requires record.photos to be an array.",
    );
  }
  for (const photo of record.photos) {
    if (
      !photo ||
      typeof photo.photoId !== "string" ||
      photo.photoId.length === 0 ||
      !(photo.blob instanceof Blob) ||
      photo.blob.size === 0
    ) {
      throw new InspectionStoreError(
        "invalid-argument",
        `Photo "${photo?.photoId ?? "?"}" has no image bytes; nothing was saved. Re-add the photo instead of saving it imageless.`,
      );
    }
  }
  try {
    const db = await openDatabase();
    const tx = db.transaction([INSPECTIONS_STORE, PHOTO_BYTES_STORE], "readwrite");
    const done = transactionDone(tx);
    done.catch(noop);
    const inspections = tx.objectStore(INSPECTIONS_STORE);
    const bytes = tx.objectStore(PHOTO_BYTES_STORE);
    const existing = (await requestToPromise(
      inspections.get(record.inspectionId),
    )) as StoredInspection | undefined;
    const now = nowIso();
    const metas: StoredInspection["photos"] = record.photos.map((photo, i) => ({
      photoId: photo.photoId,
      name:
        typeof photo.name === "string" && photo.name.length > 0
          ? photo.name
          : `photo-${i + 1}`,
      type: typeof photo.type === "string" ? photo.type : "",
      size: photo.blob.size,
      addedAt: typeof photo.addedAt === "string" ? photo.addedAt : now,
    }));
    const index = bytes.index(PHOTO_INSPECTION_INDEX);
    const staleKeys = (await requestToPromise(
      index.getAllKeys(record.inspectionId),
    )) as unknown as IDBValidKey[];
    const wanted = new Set(metas.map((m) => m.photoId));
    for (const key of staleKeys) {
      if (!wanted.has(String(key))) {
        await requestToPromise(bytes.delete(key));
      }
    }
    for (const photo of record.photos) {
      const row: StoredPhotoBytes = {
        photoId: photo.photoId,
        inspectionId: record.inspectionId,
        blob: photo.blob,
      };
      await requestToPromise(bytes.put(row));
    }
    const stored: StoredInspection = {
      inspectionId: record.inspectionId,
      createdAt:
        existing?.createdAt ??
        (typeof record.createdAt === "string" ? record.createdAt : now),
      updatedAt: now,
      categoryHint: record.categoryHint ?? DEFAULT_CATEGORY_HINT,
      status: record.status ?? "draft",
      photos: metas,
    };
    await requestToPromise(inspections.put(stored));
    await done;
    return {
      inspectionId: stored.inspectionId,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      categoryHint: stored.categoryHint,
      status: stored.status,
      photos: record.photos.map((photo, i) => ({ ...photo, ...metas[i], blob: photo.blob })),
    };
  } catch (err) {
    throw toStoreError(err, "save inspection");
  }
}

/**
 * Remove draft inspections that never received a photograph. Visiting /scan
 * used to persist an empty shell on every load, which filled the repository
 * with "insufficient evidence" cards and no pictures.
 */
export async function deleteEmptyDrafts(): Promise<number> {
  const records = await listInspections();
  const empty = records.filter(
    (record) => record.status === "draft" && record.photos.length === 0,
  );
  for (const record of empty) {
    await deleteInspection(record.inspectionId);
  }
  return empty.length;
}

/**
 * Delete an inspection and all of its photo bytes. Idempotent: deleting an
 * unknown id resolves without error.
 */
export async function deleteInspection(inspectionId: string): Promise<void> {
  assertAvailable();
  if (!inspectionId) return;
  try {
    const db = await openDatabase();
    const tx = db.transaction([INSPECTIONS_STORE, PHOTO_BYTES_STORE], "readwrite");
    const done = transactionDone(tx);
    done.catch(noop);
    const bytes = tx.objectStore(PHOTO_BYTES_STORE);
    const keys = (await requestToPromise(
      bytes.index(PHOTO_INSPECTION_INDEX).getAllKeys(inspectionId),
    )) as unknown as IDBValidKey[];
    for (const key of keys) {
      await requestToPromise(bytes.delete(key));
    }
    await requestToPromise(tx.objectStore(INSPECTIONS_STORE).delete(inspectionId));
    await done;
  } catch (err) {
    throw toStoreError(err, "delete inspection");
  }
}

/**
 * Read-only lens over legacy `lm_reports` (localStorage) entries created by
 * the old single-photo scan page. NEVER writes, migrates, or erases: old
 * user-created reports are preserved untouched for the repository/dashboard
 * agent to display. Entries whose `imageUrl` is a `blob:` URL (dead after
 * reload) or missing get `evidenceUnavailable: true` so the UI shows
 * "evidence unavailable" instead of inventing an image. Never throws:
 * corrupt or absent storage yields `[]`.
 */
export function listLegacyReports(): LegacyReportRef[] {
  try {
    if (typeof window === "undefined" || !("localStorage" in window)) return [];
    const raw = window.localStorage.getItem(LEGACY_REPORTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, i) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      const imageUrl = typeof rec.imageUrl === "string" ? rec.imageUrl : "";
      return {
        id: typeof rec.id === "string" && rec.id.length > 0 ? rec.id : `legacy-${i}`,
        productName: typeof rec.productName === "string" ? rec.productName : "Unknown product",
        brand: typeof rec.brand === "string" ? rec.brand : "Unknown brand",
        scannedAt: typeof rec.scannedAt === "string" ? rec.scannedAt : "",
        imageUrl,
        evidenceUnavailable:
          imageUrl.length === 0 || imageUrl.startsWith("blob:"),
        raw: item,
      } satisfies LegacyReportRef;
    });
  } catch {
    return [];
  }
}

/**
 * Create a preview URL for a stored photo. The caller owns the URL and must
 * call `URL.revokeObjectURL(url)` when the preview unmounts (same discipline
 * as the current scan page's `blob:` preview handling).
 */
export function createPhotoObjectUrl(photo: Pick<InspectionPhoto, "blob">): string {
  return URL.createObjectURL(photo.blob);
}
