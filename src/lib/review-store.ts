/**
 * Unified reviewer sidecar (Wave 3 fix #1).
 *
 * ONE key (`nyayapack.reviews.v1`, a single JSON map) and ONE payload shape
 * shared by the scan flow (ReviewPanel) and the report page, so
 * Scan → Confirm → /report shows the same corrections/decisions/confirmed
 * state after a reload.
 *
 * Payload shape:
 * {
 *   observations: ObservedDeclaration[],
 *   correctedTexts: Record<obsId, string>,
 *   reviewedCategory: string | null,
 *   reviewedImport: 'imported' | 'domestic' | 'unknown',
 *   coverageConfirmed: boolean,
 *   decisions: Record<ruleId, 'accepted' | 'rejected'>,
 *   confirmedAt: string | null
 * }
 *
 * Migration: the pre-fix report page used a per-id key
 * `nyayapack-review-<id>` holding `{ observations, overlay }` (a
 * field-keyed ReviewOverlay). `loadReview` reads that old key once as a
 * fallback, converts it, saves into the unified map, and deletes the old
 * key. Entries written by the pre-fix scan sidecar into the same unified
 * key (with extra headline/ruleResults/qualityFlags fields) are accepted
 * by extracting the seven canonical fields.
 *
 * `loadReview` never throws (missing or corrupt data is null). `saveReview`
 * throws {@link ReviewStoreError} on quota or private-mode failures so
 * callers cannot treat a no-op persist as success.
 */

import { FIELD_MAP } from "./observations";
import type { ObservedDeclaration, PackageIdentity, PhotoFace } from "./observations";
import type { ImportStatus } from "./types";
import { log } from "./log";

export const REVIEW_STORE_KEY = "nyayapack.reviews.v1";

export type ReviewStoreErrorCode = "unavailable" | "quota-exceeded";

/** Typed sidecar persist failure. Thrown by `saveReview`; never swallowed. */
export class ReviewStoreError extends Error {
  readonly code: ReviewStoreErrorCode;

  constructor(code: ReviewStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "ReviewStoreError";
    this.code = code;
  }
}

/** Short copy for scan/report banners when the sidecar cannot be written. */
export function describeReviewError(err: unknown): { title: string; detail: string } {
  if (err instanceof ReviewStoreError) {
    if (err.code === "quota-exceeded") {
      return {
        title: "This browser is out of storage",
        detail: "The review was not saved. Remove old inspections, then try again.",
      };
    }
    return {
      title: "Browser storage is unavailable",
      detail: "The review cannot be saved in this browser.",
    };
  }
  return {
    title: "The review was not saved",
    detail: "Nothing new was saved. Try again.",
  };
}

function toReviewStoreError(err: unknown, op: string): ReviewStoreError {
  if (err instanceof ReviewStoreError) return err;
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "";
  const detail = err instanceof Error ? err.message : String(err);
  if (name === "QuotaExceededError" || /quota/i.test(detail)) {
    const quota = new ReviewStoreError(
      "quota-exceeded",
      `Cannot ${op}: browser storage is full. The review was not saved.`,
      { cause: err },
    );
    log.error("review-store", "quota_exceeded", quota.message, {
      code: quota.code,
      data: { op, cause: detail },
    });
    return quota;
  }
  const unavailable = new ReviewStoreError(
    "unavailable",
    `Cannot ${op}: browser storage is unavailable. The review was not saved.`,
    { cause: err },
  );
  log.error("review-store", "unavailable", unavailable.message, {
    code: unavailable.code,
    data: { op, cause: detail, name },
  });
  return unavailable;
}

export type ReviewedImport = "imported" | "domestic" | "unknown";

export interface ReviewPayload {
  observations: ObservedDeclaration[];
  correctedTexts: Record<string, string>;
  reviewedCategory: string | null;
  reviewedImport: ReviewedImport;
  coverageConfirmed: boolean;
  decisions: Record<string, "accepted" | "rejected">;
  confirmedAt: string | null;
  /** Model-proposed product/commodity name; reviewer may overwrite on the report. */
  productName: string | null;
  /** Model-proposed brand; reviewer may overwrite on the report. */
  brand: string | null;
  photoFaces: PhotoFace[];
  samePackage: PackageIdentity["samePackage"];
  mismatchNote: string | null;
}

function legacyPerIdKey(inspectionId: string): string {
  return `nyayapack-review-${inspectionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeImport(value: unknown): ReviewedImport {
  if (value === "imported" || value === "domestic" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function normalizeCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return value;
}

function normalizeConfirmedAt(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function normalizeCorrectedTexts(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function normalizeDecisions(value: unknown): Record<string, "accepted" | "rejected"> {
  if (!isRecord(value)) return {};
  const out: Record<string, "accepted" | "rejected"> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === "accepted" || entry === "rejected") out[key] = entry;
  }
  return out;
}

function normalizeObservations(value: unknown): ObservedDeclaration[] {
  return Array.isArray(value) ? (value as ObservedDeclaration[]) : [];
}

/** Extract the canonical seven fields from any map entry (new or pre-fix). */
function normalizePayload(value: unknown): ReviewPayload | null {
  if (!isRecord(value)) return null;
  // Pre-fix scan sidecar stored the same seven fields plus headline,
  // ruleResults, qualityFlags, inspectionId, updatedAt — accept it by
  // extracting the canonical subset. A completely unrelated object (no
  // recognized keys) is not a review.
  const hasAnyReviewKey =
    "observations" in value ||
    "correctedTexts" in value ||
    "reviewedCategory" in value ||
    "reviewedImport" in value ||
    "coverageConfirmed" in value ||
    "decisions" in value ||
    "confirmedAt" in value;
  if (!hasAnyReviewKey) return null;
  const reviewedImport = normalizeImport(
    (value as Record<string, unknown>)["reviewedImport"],
  );
  return {
    observations: normalizeObservations(value["observations"]),
    correctedTexts: normalizeCorrectedTexts(value["correctedTexts"]),
    reviewedCategory: normalizeCategory(value["reviewedCategory"]),
    reviewedImport,
    coverageConfirmed: value["coverageConfirmed"] === true,
    decisions: normalizeDecisions(value["decisions"]),
    confirmedAt: normalizeConfirmedAt(value["confirmedAt"]),
    productName: normalizeCategory(value["productName"]),
    brand: normalizeCategory(value["brand"]),
    photoFaces: Array.isArray(value["photoFaces"]) ? (value["photoFaces"] as PhotoFace[]) : [],
    samePackage:
      value["samePackage"] === true ? true : value["samePackage"] === false ? false : null,
    mismatchNote: normalizeCategory(value["mismatchNote"]),
  };
}

function readUnifiedMap(): Record<string, unknown> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(REVIEW_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeUnifiedMap(map: Record<string, unknown>): void {
  if (typeof window === "undefined") {
    throw new ReviewStoreError(
      "unavailable",
      "Cannot save review: browser storage is unavailable. The review was not saved.",
    );
  }
  try {
    window.localStorage.setItem(REVIEW_STORE_KEY, JSON.stringify(map));
  } catch (err) {
    throw toReviewStoreError(err, "save review");
  }
}

/**
 * Convert a pre-fix per-id `{ observations, overlay }` payload (field-keyed
 * ReviewOverlay) into the unified obsId-keyed shape. Field edits without a
 * matching observation are preserved under a `field:<ObservedField>` key so
 * no reviewer text is silently dropped; the report page maps those back to
 * field edits.
 */
function migrateLegacyPerId(parsed: unknown): ReviewPayload | null {
  if (!isRecord(parsed)) return null;
  const overlayUnknown = parsed["overlay"];
  if (!isRecord(overlayUnknown)) return null;
  const overlay = overlayUnknown as Record<string, unknown>;
  const observations = normalizeObservations(parsed["observations"]);

  // obsId lookup: ObservedField -> first obsId with that field.
  const obsIdByField = new Map<string, string>();
  try {
    for (const observation of observations) {
      if (!observation || typeof observation !== "object") continue;
      const obs = observation as unknown as Record<string, unknown>;
      const obsId = obs["obsId"];
      const field = obs["field"];
      if (typeof obsId !== "string" || typeof field !== "string") continue;
      const canonical = (FIELD_MAP as Record<string, string>)[field];
      if (typeof canonical !== "string") continue;
      if (!obsIdByField.has(canonical)) obsIdByField.set(canonical, obsId);
    }
  } catch {
    // Mapping is best-effort; fall back to field: keys below.
  }

  const correctedTexts: Record<string, string> = {};
  const reviewedValues = overlay["reviewedValues"];
  if (isRecord(reviewedValues)) {
    for (const [field, text] of Object.entries(reviewedValues)) {
      const obsId = obsIdByField.get(field);
      if (typeof text === "string") {
        correctedTexts[obsId ?? `field:${field}`] = text;
      } else if (text === null) {
        // Scan semantics: empty string means "reviewer confirms absent".
        correctedTexts[obsId ?? `field:${field}`] = "";
      }
    }
  }

  const rawCategory = overlay["category"];
  let reviewedCategory: string | null = null;
  if (typeof rawCategory === "string" && rawCategory.trim().length > 0) {
    reviewedCategory = rawCategory;
  }

  const rawImport = overlay["importStatus"] as ImportStatus | unknown;
  const importStatus: ImportStatus =
    rawImport === "imported" || rawImport === "domestic" || rawImport === "unknown"
      ? rawImport
      : "unknown";

  const findingDecisions = overlay["findingDecisions"];
  const decisions: Record<string, "accepted" | "rejected"> = {};
  if (isRecord(findingDecisions)) {
    for (const [ruleId, decision] of Object.entries(findingDecisions)) {
      if (decision === "accepted" || decision === "rejected") {
        decisions[ruleId] = decision;
      }
    }
  }

  return {
    observations,
    correctedTexts,
    reviewedCategory,
    reviewedImport: importStatus,
    coverageConfirmed: overlay["coverageConfirmed"] === true,
    decisions,
    confirmedAt: normalizeConfirmedAt(overlay["confirmedAt"]),
    productName: typeof overlay["productName"] === "string" ? overlay["productName"] : null,
    brand: typeof overlay["brand"] === "string" ? overlay["brand"] : null,
    photoFaces: [],
    samePackage: null,
    mismatchNote: null,
  };
}

function removeLegacyPerIdKey(inspectionId: string): void {
  try {
    if (typeof window === "undefined") return;
    if (!inspectionId) return;
    window.localStorage.removeItem(legacyPerIdKey(inspectionId));
  } catch {
    // Best-effort cleanup.
  }
}

/** Load the unified review payload, migrating the old per-id key once. */
export function loadReview(inspectionId: string): ReviewPayload | null {
  try {
    if (typeof window === "undefined") return null;
    if (!inspectionId) return null;
    const map = readUnifiedMap();
    const normalized = normalizePayload(map[inspectionId]);
    if (normalized) return normalized;

    // Fallback: pre-fix report key. Read once, migrate into the unified
    // map, then delete the old key so the two stores cannot diverge again.
    let legacyRaw: string | null = null;
    try {
      legacyRaw = window.localStorage.getItem(legacyPerIdKey(inspectionId));
    } catch {
      legacyRaw = null;
    }
    if (!legacyRaw) return null;
    try {
      const parsed: unknown = JSON.parse(legacyRaw);
      const migrated = migrateLegacyPerId(parsed);
      if (migrated) {
        try {
          const next = readUnifiedMap();
          next[inspectionId] = migrated;
          writeUnifiedMap(next);
        } catch {
          // Best-effort: still return the migrated payload for this session.
        }
        removeLegacyPerIdKey(inspectionId);
        return migrated;
      }
    } catch {
      // Corrupt legacy payload: drop it so it cannot shadow the unified store.
    }
    removeLegacyPerIdKey(inspectionId);
    return null;
  } catch {
    return null;
  }
}

/** Persist the unified review payload (draft or confirmed). Throws on quota/unavailable. */
export function saveReview(inspectionId: string, payload: ReviewPayload): void {
  if (typeof window === "undefined") {
    throw new ReviewStoreError(
      "unavailable",
      "Cannot save review: browser storage is unavailable. The review was not saved.",
    );
  }
  if (!inspectionId) {
    throw new ReviewStoreError(
      "unavailable",
      "Cannot save review: missing inspection id. The review was not saved.",
    );
  }
  const map = readUnifiedMap();
  map[inspectionId] = {
    observations: Array.isArray(payload.observations) ? payload.observations : [],
    correctedTexts: normalizeCorrectedTexts(payload.correctedTexts),
    reviewedCategory: normalizeCategory(payload.reviewedCategory),
    reviewedImport: normalizeImport(payload.reviewedImport),
    coverageConfirmed: payload.coverageConfirmed === true,
    decisions: normalizeDecisions(payload.decisions),
    confirmedAt: normalizeConfirmedAt(payload.confirmedAt),
    productName: normalizeCategory(payload.productName),
    brand: normalizeCategory(payload.brand),
    photoFaces: Array.isArray(payload.photoFaces) ? payload.photoFaces : [],
    samePackage:
      payload.samePackage === true ? true : payload.samePackage === false ? false : null,
    mismatchNote: normalizeCategory(payload.mismatchNote),
  } satisfies ReviewPayload;
  writeUnifiedMap(map);
  // The unified key is now canonical; remove any stale per-id copy.
  removeLegacyPerIdKey(inspectionId);
}

/** Remove the unified review payload (and any stale per-id copy). */
export function clearReview(inspectionId: string): void {
  try {
    if (typeof window === "undefined") return;
    if (!inspectionId) return;
    const map = readUnifiedMap();
    if (Object.prototype.hasOwnProperty.call(map, inspectionId)) {
      delete map[inspectionId];
      writeUnifiedMap(map);
    }
    removeLegacyPerIdKey(inspectionId);
  } catch {
    // Best-effort.
  }
}
