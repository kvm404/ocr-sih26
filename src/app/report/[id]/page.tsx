"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  Download,
  FileText,
  LayoutDashboard,
  Loader2,
  Pencil,
} from "lucide-react";
import {
  buildReportModel,
  emptyReviewOverlay,
  exportDocx,
  exportPdf,
  reportFileBase,
  type FindingDecision,
  type ReportModel,
  type ReviewOverlay,
} from "@/lib/export";
import type { ObservedDeclaration } from "@/lib/observations";
import { FIELD_MAP } from "@/lib/observations";
import {
  describeReviewError,
  loadReview,
  saveReview,
  type ReviewPayload,
} from "@/lib/review-store";
import {
  createPhotoObjectUrl,
  describeStoreError,
  getInspection,
  listLegacyReports,
  saveInspection,
  type InspectionRecord,
  type LegacyReportRef,
} from "@/lib/store";
import type { ImportStatus, ObservedField } from "@/lib/types";
import { Notice, type NoticeCopy } from "@/components/Notice";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; notice: NoticeCopy }
  | { kind: "not-found" }
  | { kind: "legacy"; entry: LegacyReportRef }
  | { kind: "ready" };

function hintToDisplayCategory(hint: string | null): string {
  if (hint === null) return "";
  const n = hint.trim().toLowerCase();
  if (n === "" || n === "unknown" || n === "auto") return "";
  if (n === "food-beverages" || n === "food and beverages" || n === "food") {
    return "Food and beverages";
  }
  if (n === "personal-care" || n === "personal care") return "Personal care";
  if (n === "household" || n === "household products") return "Household products";
  if (n === "other") return "Other";
  return hint;
}

function displayToHintCategory(display: string): string | null {
  const t = (display ?? "").trim();
  if (t.length === 0) return null;
  const n = t.toLowerCase();
  if (n === "food and beverages" || n === "food-beverages") return "food-beverages";
  if (n === "personal care" || n === "personal-care") return "personal-care";
  if (n === "household products" || n === "household") return "household";
  if (n === "other") return "other";
  if (n === "unknown" || n === "auto") return null;
  return t;
}

/**
 * Unified payload -> report overlay. obsId-keyed corrections map back to
 * field edits via their source observation; `field:<ObservedField>` keys
 * (written when the reviewer edits a field with no model observation)
 * map directly. Product name/brand are not part of the unified payload
 * and start empty; they stay editable until confirmation for this session.
 */
function payloadToOverlay(
  payload: ReviewPayload,
  observations: ObservedDeclaration[],
): ReviewOverlay {
  const obsFieldById = new Map<string, ObservedField>();
  for (const observation of observations) {
    const canonical = FIELD_MAP[observation.field];
    if (canonical) obsFieldById.set(observation.obsId, canonical);
  }
  const reviewedValues: ReviewOverlay["reviewedValues"] = {};
  for (const [key, text] of Object.entries(payload.correctedTexts)) {
    if (key.startsWith("field:")) {
      const field = key.slice("field:".length) as ObservedField;
      reviewedValues[field] = text.trim().length === 0 ? null : text;
      continue;
    }
    const field = obsFieldById.get(key);
    if (field) reviewedValues[field] = text.trim().length === 0 ? null : text;
  }
  const findingDecisions: ReviewOverlay["findingDecisions"] = {};
  for (const [ruleId, decision] of Object.entries(payload.decisions)) {
    if (decision === "accepted" || decision === "rejected") {
      findingDecisions[ruleId as ObservedField] = decision;
    }
  }
  return {
    productName: payload.productName?.trim() ?? "",
    brand: payload.brand?.trim() ?? "",
    category: hintToDisplayCategory(payload.reviewedCategory),
    importStatus: payload.reviewedImport,
    coverageConfirmed: payload.coverageConfirmed,
    reviewedValues,
    findingDecisions,
    confirmedAt: payload.confirmedAt,
  };
}

/**
 * Report overlay -> unified payload. Field edits with a matching model
 * observation are stored under that observation's obsId (scan semantics:
 * empty string means "confirmed missing"); fields without an observation
 * use a `field:<ObservedField>` key so no reviewer text is dropped.
 */
function overlayToPayload(
  overlay: ReviewOverlay,
  observations: ObservedDeclaration[],
  extras?: Pick<ReviewPayload, "photoFaces" | "samePackage" | "mismatchNote">,
): ReviewPayload {
  const obsIdByField = new Map<string, string>();
  for (const observation of observations) {
    const canonical = FIELD_MAP[observation.field];
    if (canonical && !obsIdByField.has(canonical)) {
      obsIdByField.set(canonical, observation.obsId);
    }
  }
  const correctedTexts: Record<string, string> = {};
  for (const [field, text] of Object.entries(overlay.reviewedValues) as Array<
    [ObservedField, string | null | undefined]
  >) {
    if (text === undefined) continue;
    const value = text ?? "";
    const obsId = obsIdByField.get(field);
    correctedTexts[obsId ?? `field:${field}`] = value;
  }
  const decisions: Record<string, "accepted" | "rejected"> = {};
  for (const [ruleId, decision] of Object.entries(overlay.findingDecisions) as Array<
    [string, FindingDecision | undefined]
  >) {
    if (decision === "accepted" || decision === "rejected") decisions[ruleId] = decision;
  }
  return {
    observations,
    correctedTexts,
    reviewedCategory: displayToHintCategory(overlay.category),
    reviewedImport: overlay.importStatus,
    coverageConfirmed: overlay.coverageConfirmed,
    decisions,
    confirmedAt: overlay.confirmedAt,
    productName: overlay.productName.trim() || null,
    brand: overlay.brand.trim() || null,
    photoFaces: extras?.photoFaces ?? [],
    samePackage: extras?.samePackage ?? null,
    mismatchNote: extras?.mismatchNote ?? null,
  };
}

function hasReviewedKey(
  overlay: ReviewOverlay,
  field: ObservedField,
): boolean {
  return Object.prototype.hasOwnProperty.call(overlay.reviewedValues, field);
}

const CATEGORY_OPTIONS = [
  { value: "", label: "Undecided (date rule stays not assessed)" },
  { value: "Food and beverages", label: "Food and beverages" },
  { value: "Personal care", label: "Personal care" },
  { value: "Household products", label: "Household products" },
  { value: "Other", label: "Other" },
];

const IMPORT_OPTIONS: { value: ImportStatus; label: string }[] = [
  { value: "unknown", label: "Unknown (reviewer has not confirmed)" },
  { value: "domestic", label: "Domestic" },
  { value: "imported", label: "Imported" },
];

export default function ReportPage() {
  const rawParams = useParams() as unknown as Record<string, string | string[]> | null;
  const id = useMemo(() => {
    const value = rawParams?.id;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0] ?? "";
    return "";
  }, [rawParams]);

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [inspection, setInspection] = useState<InspectionRecord | null>(null);
  const [overlay, setOverlay] = useState<ReviewOverlay>(() => emptyReviewOverlay());
  const [observations, setObservations] = useState<ObservedDeclaration[]>([]);
  const [identityExtras, setIdentityExtras] = useState<
    Pick<ReviewPayload, "photoFaces" | "samePackage" | "mismatchNote">
  >({ photoFaces: [], samePackage: null, mismatchNote: null });
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [confirmError, setConfirmError] = useState<NoticeCopy | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [exportingDocx, setExportingDocx] = useState(false);

  // Load the inspection (with photo bytes) plus the unified review payload
  // written by the scan flow. loadReview migrates the old per-id
  // `nyayapack-review-<id>` key once, then deletes it.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!id) {
        setPhase({ kind: "not-found" });
        return;
      }
      try {
        const record = await getInspection(id);
        if (cancelled) return;
        if (!record) {
          const legacy = listLegacyReports().find((entry) => entry.id === id);
          setPhase(legacy ? { kind: "legacy", entry: legacy } : { kind: "not-found" });
          return;
        }
        const stored = loadReview(id);
        setInspection(record);
        if (stored) {
          setObservations(stored.observations);
          setOverlay(payloadToOverlay(stored, stored.observations));
          setIdentityExtras({
            photoFaces: stored.photoFaces ?? [],
            samePackage: stored.samePackage ?? null,
            mismatchNote: stored.mismatchNote ?? null,
          });
        } else {
          setObservations([]);
          setOverlay(emptyReviewOverlay());
          setIdentityExtras({ photoFaces: [], samePackage: null, mismatchNote: null });
        }
        setPhase({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          notice: describeStoreError(error),
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Keep the unified review in browser storage so Scan → Confirm → /report
  // (and a reload) reopens the same corrections/decisions/confirmed state.
  useEffect(() => {
    if (phase.kind !== "ready" || !inspection) return;
    try {
      saveReview(
        inspection.inspectionId,
        overlayToPayload(overlay, observations, identityExtras),
      );
    } catch (err) {
      const copy = describeReviewError(err);
      queueMicrotask(() => {
        setConfirmError({ title: copy.title, detail: copy.detail });
      });
    }
  }, [phase.kind, inspection, observations, overlay, identityExtras]);

  // Object URLs for stored photo bytes; revoked when photos change/unmount.
  useEffect(() => {
    if (!inspection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- revoke/replace object URLs when the inspection is gone
      setPhotoUrls({});
      return;
    }
    const entries = inspection.photos.map(
      (photo) => [photo.photoId, createPhotoObjectUrl(photo)] as const,
    );
    setPhotoUrls(Object.fromEntries(entries));
    return () => {
      for (const [, url] of entries) URL.revokeObjectURL(url);
    };
  }, [inspection]);

  const model: ReportModel | null = useMemo(() => {
    if (!inspection) return null;
    return buildReportModel(inspection, observations, overlay);
    // observations is state today (empty until the scan agent writes model
    // readings into the same storage key) and reactive when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection, observations, overlay]);

  function patchOverlay(patch: Partial<ReviewOverlay>): void {
    setConfirmError(null);
    setOverlay((prev) => ({ ...prev, ...patch }));
  }

  function setDeclarationText(field: ObservedField, text: string): void {
    setConfirmError(null);
    setOverlay((prev) => ({
      ...prev,
      reviewedValues: { ...prev.reviewedValues, [field]: text },
    }));
  }

  function markDeclarationMissing(field: ObservedField): void {
    setConfirmError(null);
    setOverlay((prev) => ({
      ...prev,
      reviewedValues: { ...prev.reviewedValues, [field]: null },
    }));
  }

  function restoreModelReading(field: ObservedField): void {
    setConfirmError(null);
    setOverlay((prev) => {
      const reviewedValues = { ...prev.reviewedValues };
      delete reviewedValues[field];
      return { ...prev, reviewedValues };
    });
  }

  function setFindingDecision(field: ObservedField, decision: FindingDecision | null): void {
    setConfirmError(null);
    setOverlay((prev) => {
      const findingDecisions = { ...prev.findingDecisions };
      if (decision === null) {
        delete findingDecisions[field];
      } else {
        findingDecisions[field] = decision;
      }
      return { ...prev, findingDecisions };
    });
  }

  async function confirmReport(): Promise<void> {
    if (!inspection || !model || confirming) return;
    // Confirm gate (same as the scan gate): coverage must be confirmed and
    // every suspected violation must have an accept/reject decision.
    const undecided = model.findings.filter(
      (finding) => finding.result === "suspected_violation" && finding.decision === null,
    ).length;
    if (!overlay.coverageConfirmed || undecided > 0) {
      const reasons: string[] = [];
      if (!overlay.coverageConfirmed) {
        reasons.push("Confirm that the relevant package sides were photographed.");
      }
      if (undecided > 0) {
        reasons.push(
          `Accept or reject each suspected violation (${undecided} undecided).`,
        );
      }
      setConfirmError({
        title: "Cannot confirm yet",
        detail: `${reasons.join(" ")} Nothing was marked final.`,
      });
      return;
    }
    setConfirming(true);
    setConfirmError(null);
    try {
      const confirmedAt = new Date().toISOString();
      const nextOverlay: ReviewOverlay = { ...overlay, confirmedAt };
      const saved = await saveInspection({ ...inspection, status: "confirmed" });
      setInspection(saved);
      setOverlay(nextOverlay);
    } catch (error) {
      setConfirmError({
        title: "Confirmation was not saved",
        detail: describeStoreError(error).detail,
      });
    } finally {
      setConfirming(false);
    }
  }

  function downloadPdf(): void {
    if (!model) return;
    exportPdf(model).save(`${reportFileBase(model)}-report.pdf`);
  }

  async function downloadDocx(): Promise<void> {
    if (!model || exportingDocx) return;
    setExportingDocx(true);
    try {
      const blob = await exportDocx(model);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${reportFileBase(model)}-report.docx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExportingDocx(false);
    }
  }

  if (phase.kind === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading report…
        </div>
        <div className="mt-4 animate-pulse space-y-4">
          <div className="h-32 rounded-xl bg-slate-200" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="h-64 rounded-xl bg-slate-200 lg:col-span-2" />
            <div className="h-64 rounded-xl bg-slate-200" />
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <h1 className="text-xl font-bold text-slate-900">Report cannot be opened</h1>
        <div className="mt-4">
          <Notice {...phase.notice} />
        </div>
        <div className="mt-6">
          <Link
            href="/scan"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E40AF]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to scan
          </Link>
        </div>
      </div>
    );
  }

  if (phase.kind === "not-found") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-xl font-bold text-slate-900">Report not found</h1>
        <p className="mt-2 text-sm text-slate-600">
          No report with id &ldquo;{id || "unknown"}&rdquo; exists in this browser.
        </p>
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <Link
            href="/scan"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E40AF]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to scan
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <LayoutDashboard className="h-4 w-4" aria-hidden="true" /> View dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (phase.kind === "legacy") {
    const entry = phase.entry;
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <div className="no-print mb-5 flex flex-wrap items-center gap-2">
          <Link
            href="/scan"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to scan
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <LayoutDashboard className="h-4 w-4" aria-hidden="true" /> View dashboard
          </Link>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <span className="inline-flex items-center rounded-md bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600 ring-1 ring-inset ring-slate-300">
            Older saved entry
          </span>
          <h1 className="mt-2 text-xl font-bold text-slate-900">{entry.productName}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {entry.brand}
            {entry.scannedAt ? ` · Scanned ${new Date(entry.scannedAt).toLocaleString()}` : ""}
          </p>
          {entry.evidenceUnavailable ? (
            <p className="mt-4 flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm leading-relaxed text-amber-900 ring-1 ring-inset ring-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Evidence unavailable: the original photograph was a short-lived browser URL that
              cannot be restored after a reload. No image is shown rather than an invented one.
            </p>
          ) : (
            <img
              src={entry.imageUrl}
              alt={`${entry.productName} label evidence`}
              className="mt-4 max-h-80 w-full rounded-lg border border-slate-200 bg-slate-50 object-contain"
            />
          )}
          <p className="mt-4 text-sm text-slate-600">
            This entry predates restorable photo storage, so it has no reviewed declarations to
            export. Start a new inspection from the scan page for a PDF/DOCX report with full
            evidence.
          </p>
        </div>
      </div>
    );
  }

  if (!inspection || !model) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-xl font-bold text-slate-900">Report not found</h1>
        <p className="mt-2 text-sm text-slate-600">
          No report with id &ldquo;{id || "unknown"}&rdquo; exists in this browser.
        </p>
      </div>
    );
  }

  const isDraft = model.isDraft;
  const pendingDecisions = model.findings.filter(
    (finding) => finding.result === "suspected_violation" && finding.decision === null,
  ).length;
  // Same gate as the scan page: coverage + zero pending decisions.
  const confirmBlockers: string[] =
    phase.kind === "ready"
      ? [
          ...(!overlay.coverageConfirmed
            ? ["Confirm that the relevant package sides were photographed."]
            : []),
          ...(pendingDecisions > 0
            ? [
                `Accept or reject each suspected violation (${pendingDecisions} undecided).`,
              ]
            : []),
        ]
      : [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      {/* Nav */}
      <div className="no-print mb-5 flex flex-wrap items-center gap-2">
        <Link
          href="/scan"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to scan
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <LayoutDashboard className="h-4 w-4" aria-hidden="true" /> View dashboard
        </Link>
      </div>

      {/* Draft / confirmed status */}
      {isDraft ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 ring-1 ring-inset ring-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-bold">DRAFT — pending reviewer confirmation.</span> Details
            stay editable until you confirm. PDF and DOCX exports are stamped DRAFT and are not
            final.
          </p>
        </div>
      ) : (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-xl bg-green-50 p-4 text-sm leading-relaxed text-green-900 ring-1 ring-inset ring-green-300"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-bold">Confirmed by the reviewer</span>
            {model.confirmedAt ? ` at ${new Date(model.confirmedAt).toLocaleString()}` : ""}.
            Exports below carry these reviewed values.
          </p>
        </div>
      )}

      {/* Identity */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-md bg-slate-800 px-3 py-1 text-xs font-bold text-white">
            {model.headline}
          </span>
          <span className="text-xs text-slate-500">Inspection aid — not legal certification</span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
              <Pencil className="h-3 w-3" aria-hidden="true" /> Product name
              {isDraft ? " (editable until confirmed)" : ""}
            </span>
            <input
              value={overlay.productName}
              onChange={(e) => patchOverlay({ productName: e.target.value })}
              disabled={!isDraft}
              placeholder="Untitled package"
              className="mt-0.5 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-lg font-bold text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
            />
          </label>
          <label className="block">
            <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
              <Pencil className="h-3 w-3" aria-hidden="true" /> Brand
              {isDraft ? " (editable until confirmed)" : ""}
            </span>
            <input
              value={overlay.brand}
              onChange={(e) => patchOverlay({ brand: e.target.value })}
              disabled={!isDraft}
              placeholder="Not recorded"
              className="mt-0.5 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-500">
              Category (reviewed){isDraft ? " — editable" : ""}
            </span>
            <select
              value={overlay.category}
              onChange={(e) => patchOverlay({ category: e.target.value })}
              disabled={!isDraft}
              className="mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-500">
              Import status (reviewed){isDraft ? " — editable" : ""}
            </span>
            <select
              value={overlay.importStatus}
              onChange={(e) => patchOverlay({ importStatus: e.target.value as ImportStatus })}
              disabled={!isDraft}
              className="mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
            >
              {IMPORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={overlay.coverageConfirmed}
            onChange={(e) => patchOverlay({ coverageConfirmed: e.target.checked })}
            disabled={!isDraft}
            className="mt-1 h-4 w-4 accent-blue-700"
          />
          <span>
            I confirm the relevant package sides were photographed. Until this is checked, an
            unseen declaration cannot be called missing — checks stay not assessed.
          </span>
        </label>
        {identityExtras.samePackage === true ? (
          <p className="mt-2 text-xs text-slate-600">
            Photographs appear to be the same package
            {overlay.brand ? ` (${overlay.brand})` : ""}.
          </p>
        ) : identityExtras.samePackage === false ? (
          <p className="mt-2 text-xs text-amber-800">
            {identityExtras.mismatchNote ??
              "Photographs may show different products. Review identity before treating this as one inspection."}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-slate-500">
          Inspected {new Date(model.inspectionDate).toLocaleString()} · ID{" "}
          <span className="font-mono">{model.inspectionId.slice(0, 8)}</span> ·{" "}
          {model.photoRefs.length} photo{model.photoRefs.length === 1 ? "" : "s"}
        </p>

        {/* Actions */}
        <div className="no-print mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={downloadPdf}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E40AF]"
          >
            <Download className="h-4 w-4" aria-hidden="true" /> Download PDF{isDraft ? " (DRAFT)" : ""}
          </button>
          <button
            type="button"
            onClick={() => void downloadDocx()}
            disabled={exportingDocx}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {exportingDocx ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileText className="h-4 w-4" aria-hidden="true" />
            )}
            Download DOCX{isDraft ? " (DRAFT)" : ""}
          </button>
          {isDraft && (
            <>
              {confirmBlockers.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600 sm:basis-full">
                  {confirmBlockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                onClick={() => void confirmReport()}
                disabled={confirming || confirmBlockers.length > 0}
                title={
                  confirmBlockers.length > 0
                    ? confirmBlockers.join(" ")
                    : "Record the reviewed result and lock this report"
                }
                className="inline-flex items-center justify-center gap-2 rounded-md bg-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {confirming ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                )}
                {pendingDecisions > 0
                  ? `Confirm report (${pendingDecisions} finding${pendingDecisions === 1 ? "" : "s"} awaiting decision)`
                  : !overlay.coverageConfirmed
                    ? "Confirm report (photo coverage unconfirmed)"
                    : "Confirm report"}
              </button>
            </>
          )}
        </div>
        {confirmError ? (
          <div className="mt-3">
            <Notice {...confirmError} />
          </div>
        ) : null}
      </div>

      {/* Main grid */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* Reviewed declarations */}
          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              Reviewed declarations ({model.declarations.length})
            </h2>
            <ul className="space-y-3">
              {model.declarations.map((declaration) => {
                const touched = hasReviewedKey(overlay, declaration.field);
                return (
                  <li
                    key={declaration.field}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{declaration.label}</span>
                      {declaration.needsReview && (
                        <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800 ring-1 ring-inset ring-amber-300">
                          Needs review
                        </span>
                      )}
                      {declaration.corrected && (
                        <span className="rounded-md bg-blue-100 px-2 py-0.5 text-[11px] font-bold text-blue-800 ring-1 ring-inset ring-blue-300">
                          Corrected by reviewer
                        </span>
                      )}
                    </div>
                    {isDraft ? (
                      <textarea
                        value={declaration.reviewedValue ?? ""}
                        onChange={(e) => setDeclarationText(declaration.field, e.target.value)}
                        rows={2}
                        placeholder="Not observed — leave empty when the declaration is not visible"
                        aria-label={`Reviewed value for ${declaration.label}`}
                        className="mt-2 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    ) : (
                      <p className="mt-2 text-sm text-slate-900">
                        {declaration.reviewedValue === null ? (
                          <span className="italic text-slate-500">
                          {declaration.corrected ? "Confirmed missing by reviewer." : "Not observed."}
                          </span>
                        ) : (
                          `“${declaration.reviewedValue}”`
                        )}
                      </p>
                    )}
                    <div className="mt-1.5 space-y-1 text-xs text-slate-500">
                      {declaration.hasObservation ? (
                        <p>
                          Model originally read:{" "}
                          {declaration.originalValue === null ? (
                            <span className="italic">nothing (null)</span>
                          ) : (
                            <span className="font-mono">“{declaration.originalValue}”</span>
                          )}
                        </p>
                      ) : (
                        <p>No model observation recorded for this declaration.</p>
                      )}
                      {declaration.auditNote && <p>{declaration.auditNote}</p>}
                      <p>
                        Evidence:{" "}
                        {declaration.photoName ? (
                          <>
                            photo <span className="font-medium">“{declaration.photoName}”</span>{" "}
                            <span className="font-mono">({declaration.photoId})</span>
                          </>
                        ) : (
                          "no source photograph recorded for this declaration."
                        )}
                      </p>
                    </div>
                    {isDraft && (
                      <div className="no-print mt-2 flex flex-wrap gap-2">
                        {declaration.reviewedValue === null && (
                          <span className="text-xs italic text-slate-400">
                            {touched ? "Marked missing by reviewer." : "Currently missing / not observed."}
                          </span>
                        )}
                        {(declaration.reviewedValue !== null || touched) && (
                          <button
                            type="button"
                            onClick={() => markDeclarationMissing(declaration.field)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            Mark as missing
                          </button>
                        )}
                        {declaration.corrected && (
                          <button
                            type="button"
                            onClick={() => restoreModelReading(declaration.field)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            Restore model reading
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Assessed findings */}
          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              Assessed findings ({model.findings.length})
            </h2>
            {model.findings.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
                No check could be assessed from the available evidence yet.
              </p>
            ) : (
              <ul className="space-y-3">
                {model.findings.map((finding) => (
                  <li
                    key={finding.ruleId}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{finding.label}</span>
                      <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-[11px] font-medium text-white">
                        {finding.legalCitation}
                      </span>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[11px] font-bold ring-1 ring-inset ${
                          finding.result === "no_issue_found"
                            ? "bg-green-100 text-green-800 ring-green-300"
                            : finding.decision === "accepted"
                              ? "bg-red-100 text-red-800 ring-red-300"
                              : finding.decision === "rejected"
                                ? "bg-slate-100 text-slate-600 ring-slate-300"
                                : "bg-amber-100 text-amber-800 ring-amber-300"
                        }`}
                      >
                        {finding.result === "no_issue_found"
                          ? "No issue found"
                          : finding.decision === "accepted"
                            ? "Suspected violation — accepted"
                            : finding.decision === "rejected"
                              ? "Suspected violation — rejected"
                              : "Suspected violation — awaiting decision"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">{finding.message}</p>
                    {finding.evidenceValue !== null && (
                      <p className="mt-1.5 text-xs text-slate-600">
                        Evidence text: <span className="font-mono">“{finding.evidenceValue}”</span>
                        {finding.evidencePhotoName
                          ? ` (photo “${finding.evidencePhotoName}”)`
                          : " (no source photograph recorded)"}
                      </p>
                    )}
                    <p className="mt-1.5 text-xs text-slate-500">
                      Effective {finding.effectiveFrom} · {finding.gazetteNumber} ·{" "}
                      <a
                        href={finding.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-700 underline hover:text-blue-800"
                      >
                        Source
                      </a>
                    </p>
                    {isDraft && finding.result === "suspected_violation" && (
                      <div className="no-print mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setFindingDecision(finding.ruleId, "accepted")}
                          aria-pressed={finding.decision === "accepted"}
                          className={`rounded-md px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${
                            finding.decision === "accepted"
                              ? "bg-red-700 text-white ring-red-700"
                              : "bg-white text-red-700 ring-red-300 hover:bg-red-50"
                          }`}
                        >
                          Accept violation
                        </button>
                        <button
                          type="button"
                          onClick={() => setFindingDecision(finding.ruleId, "rejected")}
                          aria-pressed={finding.decision === "rejected"}
                          className={`rounded-md px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${
                            finding.decision === "rejected"
                              ? "bg-slate-700 text-white ring-slate-700"
                              : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
                          }`}
                        >
                          Reject violation
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Not assessed */}
          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              Not assessed ({model.notAssessed.length})
            </h2>
            {model.notAssessed.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
                Every supported check was assessed.
              </p>
            ) : (
              <ul className="space-y-3">
                {model.notAssessed.map((item) => (
                  <li
                    key={item.ruleId}
                    className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{item.label}</span>
                      <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-[11px] font-medium text-white">
                        {item.legalCitation}
                      </span>
                      <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800 ring-1 ring-inset ring-amber-300">
                        Not assessed
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">{item.message}</p>
                    <p className="mt-1.5 text-xs text-slate-500">
                      Effective {item.effectiveFrom} · {item.gazetteNumber} ·{" "}
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-700 underline hover:text-blue-800"
                      >
                        Source
                      </a>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Sidebar: evidence */}
        <div className="space-y-5">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Camera className="h-4 w-4 text-slate-500" aria-hidden="true" />
              Evidence photos ({inspection.photos.length})
            </h2>
            {inspection.photos.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-xs text-slate-400">
                No photographs stored in this inspection.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {inspection.photos.map((photo) => {
                  const face = identityExtras.photoFaces.find(
                    (item) => item.photoId === photo.photoId,
                  );
                  const faceLabel =
                    face && face.face !== "unknown" ? ` · ${face.face} face` : "";
                  return (
                  <li key={photo.photoId}>
                    {photoUrls[photo.photoId] ? (
                      <img
                        src={photoUrls[photo.photoId]}
                        alt={`${model.productName} evidence: ${photo.name}${faceLabel}`}
                        className="max-h-64 w-full rounded-lg border border-slate-200 bg-slate-50 object-contain"
                      />
                    ) : (
                      <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-400">
                        Loading preview…
                      </div>
                    )}
                    <p className="mt-1 truncate text-xs text-slate-500" title={photo.photoId}>
                      {photo.name}
                      {faceLabel}{" "}
                      · <span className="font-mono">{photo.photoId.slice(0, 8)}</span>
                    </p>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
