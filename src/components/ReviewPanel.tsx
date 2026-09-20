"use client";

import { useMemo, useState } from "react";
import { Camera, Check, Eye, Info, Pencil, X } from "lucide-react";
import {
  FIELD_MAP,
  type ExtractionResult,
  type ObservationField,
  type ObservedDeclaration,
} from "@/lib/observations";
import { gateRegion } from "@/lib/readability";
import { loadReview, saveReview, type ReviewPayload } from "@/lib/review-store";
import type {
  ImportStatus,
  ObservedInput,
  ReportHeadline,
  RuleResult,
} from "@/lib/types";

/** Reviewer decision on one suspected violation. */
export type ViolationDecision = "accepted" | "rejected";

/** Everything the reviewer controls. Owned by the scan page, edited here. */
export interface ReviewState {
  /** obsId -> reviewer-corrected text. Presence of the key means "touched";
   *  an empty value means the reviewer confirms the declaration is absent. */
  correctedTexts: Record<string, string>;
  /** Reviewed category in store-hint form, or "unknown" when undecided. */
  reviewedCategory: string;
  /** Reviewer-confirmed import indication. Never inferred from a photo alone. */
  reviewedImport: ImportStatus;
  /** Reviewer confirms the relevant package sides were photographed. */
  coverageConfirmed: boolean;
  /** ruleId -> decision, only for suspected_violation results. */
  decisions: Record<string, ViolationDecision>;
  /** Reviewer-editable product/commodity name, seeded from the photographs. */
  productName: string;
  /** Reviewer-editable brand, seeded from the photographs. */
  brand: string;
  /**
   * Reviewer confirms mismatched photographs still belong to one package.
   * Ignored unless the model flagged a same-package conflict.
   */
  samePackageConfirmed: boolean;
}

/**
 * Unified review persistence (Wave 3 fix #1). The single source of truth is
 * `src/lib/review-store.ts` (ONE key `nyayapack.reviews.v1`, ONE payload
 * shape). These wrappers exist so existing callers keep a stable import
 * path; they delegate directly to the unified store, including its one-time
 * migration of the old per-id `nyayapack-review-<id>` key.
 */
export function saveReviewSidecar(
  inspectionId: string,
  payload: ReviewPayload,
): void {
  saveReview(inspectionId, payload);
}

/** Load a previously saved unified review payload, or null. Never throws. */
export function loadReviewSidecar(inspectionId: string): ReviewPayload | null {
  return loadReview(inspectionId);
}

function fieldLabel(field: ObservationField): string {
  switch (field) {
    case "manufacturer":
      return "Manufacturer / packer / importer";
    case "netQuantity":
      return "Net quantity";
    case "mrp":
      return "MRP";
    case "dateDeclaration":
      return "Date declaration (as printed)";
    case "consumerCare":
      return "Consumer care";
  }
}

/**
 * Adapt observations to rules-facing inputs, applying reviewer corrections.
 * A touched observation becomes reviewer-confirmed (needsReview false):
 * kept text is the reviewed reading, cleared text means the reviewer
 * confirms the declaration is absent in the photographed views.
 * Untouched observations keep the model's confidence gating.
 */
export function buildReviewedInputs(
  observations: ObservedDeclaration[],
  correctedTexts: Record<string, string>,
): ObservedInput[] {
  return observations.map((observation) => {
    if (Object.prototype.hasOwnProperty.call(correctedTexts, observation.obsId)) {
      const text = correctedTexts[observation.obsId].trim();
      return {
        field: FIELD_MAP[observation.field],
        value: text.length > 0 ? text : null,
        photoId: observation.photoId,
        needsReview: false,
      } satisfies ObservedInput;
    }
    return {
      field: FIELD_MAP[observation.field],
      value: observation.confidence === "ok" ? observation.value : null,
      photoId: observation.photoId,
      needsReview: observation.confidence !== "ok",
    } satisfies ObservedInput;
  });
}

export interface ReviewPhoto {
  photoId: string;
  url: string;
  name: string;
  face?: string;
}

export interface ReviewPanelProps {
  inspectionId: string;
  photos: ReviewPhoto[];
  extraction: ExtractionResult;
  review: ReviewState;
  onReviewChange: (next: ReviewState) => void;
  ruleResults: RuleResult[];
  headline: ReportHeadline;
  confirming: boolean;
  confirmedAt: string | null;
  /** Reasons the Confirm button is currently disabled. Empty = can confirm. */
  confirmBlockers: string[];
  onConfirm: () => void;
}

const REVIEW_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "unknown", label: "Unknown — undecided" },
  { value: "food-beverages", label: "Food and beverages" },
  { value: "personal-care", label: "Personal care" },
  { value: "household", label: "Household products" },
  { value: "other", label: "Other" },
];

const IMPORT_OPTIONS: { value: ImportStatus; label: string }[] = [
  { value: "unknown", label: "Unknown — undecided" },
  { value: "domestic", label: "Domestic (not imported)" },
  { value: "imported", label: "Imported" },
];

function resultBadge(result: RuleResult["result"]): string {
  switch (result) {
    case "no_issue_found":
      return "bg-green-100 text-green-800 ring-green-300";
    case "suspected_violation":
      return "bg-red-100 text-red-800 ring-red-300";
    case "not_assessed":
      return "bg-slate-100 text-slate-600 ring-slate-300";
  }
}

function resultLabel(result: RuleResult["result"]): string {
  switch (result) {
    case "no_issue_found":
      return "No issue found";
    case "suspected_violation":
      return "Suspected violation";
    case "not_assessed":
      return "Not assessed";
  }
}

export default function ReviewPanel({
  inspectionId,
  photos,
  extraction,
  review,
  onReviewChange,
  ruleResults,
  headline,
  confirming,
  confirmedAt,
  confirmBlockers,
  onConfirm,
}: ReviewPanelProps) {
  const [lightboxPhotoId, setLightboxPhotoId] = useState<string | null>(null);

  const photosById = useMemo(() => {
    const map = new Map<string, ReviewPhoto>();
    for (const photo of photos) map.set(photo.photoId, photo);
    return map;
  }, [photos]);

  const lightboxPhoto =
    lightboxPhotoId !== null ? (photosById.get(lightboxPhotoId) ?? null) : null;

  function setCorrection(obsId: string, text: string) {
    onReviewChange({
      ...review,
      correctedTexts: { ...review.correctedTexts, [obsId]: text },
    });
  }

  function setDecision(ruleId: string, decision: ViolationDecision | null) {
    const next = { ...review.decisions };
    if (decision === null) delete next[ruleId];
    else next[ruleId] = decision;
    onReviewChange({ ...review, decisions: next });
  }

  return (
    <section
      aria-label="Review findings"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      {/* Headline + draft/confirmed state. Unconfirmed stays visibly DRAFT. */}
      <div className="flex flex-wrap items-center gap-2">
        {confirmedAt !== null ? (
          <span className="inline-flex items-center rounded-md bg-green-100 px-3 py-1 text-xs font-bold text-green-800 ring-1 ring-inset ring-green-300">
            CONFIRMED · {new Date(confirmedAt).toLocaleString()}
          </span>
        ) : (
          <span className="inline-flex items-center rounded-md bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800 ring-1 ring-inset ring-amber-300">
            DRAFT — awaiting reviewer confirmation
          </span>
        )}
        <span className="text-sm text-slate-600">
          Headline (draft):{" "}
          <strong className="text-slate-900">{headline}</strong>
        </span>
      </div>
      <p className="mt-1 font-mono text-xs text-slate-400">
        Inspection {inspectionId}
      </p>

      {/* Combined photographs with face labels — every side stays visible. */}
      {photos.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Package photographs ({photos.length})
          </h3>
          <ul className="mt-2 grid grid-cols-2 gap-2">
            {photos.map((photo) => {
              const face = extraction.photoFaces.find((item) => item.photoId === photo.photoId);
              const label = face && face.face !== "unknown" ? face.face : photo.face;
              return (
                <li key={photo.photoId}>
                  <button
                    type="button"
                    onClick={() => setLightboxPhotoId(photo.photoId)}
                    className="block w-full overflow-hidden rounded-md border border-slate-200 bg-slate-50"
                  >
                    <img
                      src={photo.url}
                      alt={`${photo.name}${label ? ` (${label} face)` : ""}`}
                      className="h-28 w-full object-contain"
                    />
                  </button>
                  <p className="mt-1 truncate text-[11px] text-slate-500">
                    {photo.name}
                    {label ? ` · ${label} face` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Identity from the photographs (brand / product / same-package). */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">
          Brand
          <input
            value={review.brand}
            onChange={(e) => onReviewChange({ ...review, brand: e.target.value })}
            placeholder="Read from the photographs"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Product
          <input
            value={review.productName}
            onChange={(e) => onReviewChange({ ...review, productName: e.target.value })}
            placeholder="Read from the photographs"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
      </div>
      {extraction.identity.samePackage === true ? (
        <p className="mt-2 text-xs text-slate-600">
          Photographs appear to be the same package
          {extraction.identity.brand ? ` (${extraction.identity.brand})` : ""}.
        </p>
      ) : extraction.identity.samePackage === false ? (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p>
            {extraction.identity.mismatchNote ??
              "Photographs may show different products."}
          </p>
          <label className="mt-2 flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={review.samePackageConfirmed}
              onChange={(e) =>
                onReviewChange({ ...review, samePackageConfirmed: e.target.checked })
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-500"
            />
            <span>I confirm these photographs are the same physical package.</span>
          </label>
        </div>
      ) : extraction.identity.mismatchNote ? (
        <p className="mt-2 text-xs text-slate-500">{extraction.identity.mismatchNote}</p>
      ) : null}

      {/* Category + import correction (story 7). */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="review-category"
            className="block text-sm font-medium text-slate-700"
          >
            Reviewed category
          </label>
          <select
            id="review-category"
            value={review.reviewedCategory}
            onChange={(e) =>
              onReviewChange({ ...review, reviewedCategory: e.target.value })
            }
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {REVIEW_CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Model suggestion: {extraction.categorySuggestion ?? "none"}
            {extraction.categoryUncertain ? " (uncertain)" : ""}. Your choice
            controls which rules apply.
          </p>
        </div>
        <div>
          <label
            htmlFor="review-import"
            className="block text-sm font-medium text-slate-700"
          >
            Import indication
          </label>
          <select
            id="review-import"
            value={review.reviewedImport}
            onChange={(e) =>
              onReviewChange({
                ...review,
                reviewedImport: e.target.value as ImportStatus,
              })
            }
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {IMPORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Model suggestion: {extraction.importSuggestion}. Confirm from the
            package — never inferred from a photo alone.
          </p>
        </div>
      </div>

      {/* Coverage confirmation gates "missing" findings (story 15). */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={review.coverageConfirmed}
            onChange={(e) =>
              onReviewChange({ ...review, coverageConfirmed: e.target.checked })
            }
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-500"
          />
          <span>
            <span className="font-semibold text-slate-900">
              Relevant package sides were photographed
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Only after this is checked can an unseen declaration be called
              missing. Until then, absent declarations stay “not assessed”.
            </span>
          </span>
        </label>
      </div>

      {/* Observations beside their source photos (stories 12-14). */}
      <h3 className="mt-5 text-sm font-semibold text-slate-900">
        Observed declarations ({extraction.observations.length})
      </h3>
      {extraction.observations.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          No observations were extracted.
        </p>
      ) : (
        <ul className="mt-2 space-y-4">
          {extraction.observations.map((observation) => {
            const photo = photosById.get(observation.photoId) ?? null;
            const touched = Object.prototype.hasOwnProperty.call(
              review.correctedTexts,
              observation.obsId,
            );
            const gate = gateRegion({
              photoId: observation.photoId,
              region: observation.region ?? null,
              reason:
                observation.confidence !== "ok"
                  ? `${observation.confidence} reading — location withheld`
                  : undefined,
            });
            return (
              <li
                key={observation.obsId}
                className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2"
              >
                {/* Source photo + gated region. */}
                <div>
                  {photo !== null ? (
                    <button
                      type="button"
                      onClick={() => setLightboxPhotoId(photo.photoId)}
                      className="group relative block w-full overflow-hidden rounded-md border border-slate-200 bg-slate-50"
                      title="Inspect the full photo"
                    >
                      <img
                        src={photo.url}
                        alt={`Source photo ${photo.name}`}
                        className="max-h-48 w-full object-contain"
                      />
                      {gate.show && observation.region !== undefined && (
                        <span
                          aria-hidden="true"
                          className="absolute border-2 border-blue-500 bg-blue-500/10"
                          style={{
                            left: `${observation.region.x * 100}%`,
                            top: `${observation.region.y * 100}%`,
                            width: `${observation.region.w * 100}%`,
                            height: `${observation.region.h * 100}%`,
                          }}
                        />
                      )}
                      <span className="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded bg-slate-900/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
                        <Eye className="h-3 w-3" aria-hidden="true" />
                        {photo.name}
                      </span>
                    </button>
                  ) : (
                    <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 p-2 text-center text-xs text-slate-400">
                      Source photo “{observation.photoId}” is not part of this
                      inspection — evidence cannot be verified.
                    </div>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    {gate.show
                      ? "Region highlighted where the model located the text."
                      : (gate.reviewerNote ??
                        "No reliable location — left to reviewer notes.")}
                  </p>
                  {observation.confidence !== "ok" && (
                    <p className="mt-1 inline-flex items-center rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                      {observation.confidence} — needs review
                      {observation.value ? "" : ", value withheld"}
                    </p>
                  )}
                </div>

                {/* Correction (story 26): original preserved + displayed. */}
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                    {fieldLabel(observation.field)}
                    {touched && (
                      <span className="inline-flex items-center gap-0.5 rounded-md bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        Corrected
                      </span>
                    )}
                  </p>
                  <dl className="mt-1 space-y-1 text-xs">
                    <div>
                      <dt className="font-medium text-slate-500">
                        Original model reading
                      </dt>
                      <dd className="rounded bg-slate-50 px-2 py-1 font-mono text-slate-700">
                        {observation.value ?? "(none — uncertain or unreadable)"}
                      </dd>
                    </div>
                    {observation.rawModelText &&
                      observation.rawModelText !== (observation.value ?? "") && (
                        <div>
                          <dt className="font-medium text-slate-500">
                            Verbatim model text
                          </dt>
                          <dd className="rounded bg-slate-50 px-2 py-1 font-mono text-slate-700">
                            {observation.rawModelText}
                          </dd>
                        </div>
                      )}
                  </dl>
                  <label
                    htmlFor={`correct-${observation.obsId}`}
                    className="mt-2 block text-xs font-medium text-slate-700"
                  >
                    Reviewed text
                  </label>
                  <textarea
                    id={`correct-${observation.obsId}`}
                    rows={2}
                    value={
                      touched
                        ? review.correctedTexts[observation.obsId]
                        : (observation.value ?? "")
                    }
                    onChange={(e) =>
                      setCorrection(observation.obsId, e.target.value)
                    }
                    placeholder="Correct the reading here…"
                    className="mt-0.5 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Clear the text to mark this declaration absent in the
                    photographed views.
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Ignored photos: attested nowhere (pooling guard). */}
      {extraction.unattestedPhotoIds.length > 0 ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900"
        >
          <strong>Ignored by the model:</strong>{" "}
          {extraction.unattestedPhotoIds
            .map((id) => photosById.get(id)?.name ?? id)
            .join(", ")}{" "}
          contributed nothing to this analysis — the model never mentioned
          {extraction.unattestedPhotoIds.length > 1 ? " them" : " it"}. Re-run
          the analysis or remove the ignored photo; confirming is blocked until
          every photo is accounted for.
        </div>
      ) : null}

      {/* Photo quality flags (story 23). */}
      <h3 className="mt-5 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
        <Camera className="h-4 w-4 text-slate-500" aria-hidden="true" />
        Photo quality
      </h3>
      {extraction.qualityFlags.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500">
          The model reported no quality concerns. Recapture a view yourself if
          any declaration is hard to read.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {extraction.qualityFlags.map((flag, i) => {
            const photo = photosById.get(flag.photoId);
            return (
              <li
                key={`${flag.photoId}-${flag.issue}-${i}`}
                className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900"
              >
                <Info
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  <strong>{photo?.name ?? flag.photoId}</strong> — {flag.issue}
                  {flag.note ? `: ${flag.note}` : ". Recapture this view."}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Rule results with citations + accept/reject (stories 21, 22, 27). */}
      <h3 className="mt-5 text-sm font-semibold text-slate-900">
        Checks ({ruleResults.length})
      </h3>
      <ul className="mt-2 space-y-3">
        {ruleResults.map((result) => {
          const decision =
            result.result === "suspected_violation"
              ? (review.decisions[result.ruleId] ?? null)
              : null;
          return (
            <li
              key={result.ruleId}
              className="rounded-lg border border-slate-200 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-bold ring-1 ring-inset ${resultBadge(result.result)}`}
                >
                  {resultLabel(result.result)}
                </span>
                <span className="text-sm font-semibold text-slate-900">
                  {result.label}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {result.legalCitation} · {result.gazetteNumber} · effective{" "}
                {result.effectiveFrom} ·{" "}
                <a
                  href={result.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-700 underline hover:text-blue-800"
                >
                  source
                </a>
              </p>
              <p className="mt-1.5 text-sm text-slate-700">{result.message}</p>
              {result.evidence !== null && (
                <p className="mt-1 rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700">
                  “{result.evidence.value}”
                  {result.evidence.photoId !== undefined &&
                    ` — from ${photosById.get(result.evidence.photoId)?.name ?? result.evidence.photoId}`}
                </p>
              )}
              {result.result === "suspected_violation" && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDecision(result.ruleId, "accepted")}
                    aria-pressed={decision === "accepted"}
                    className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold shadow-sm ${
                      decision === "accepted"
                        ? "bg-red-700 text-white"
                        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    Accept violation
                  </button>
                  <button
                    type="button"
                    onClick={() => setDecision(result.ruleId, "rejected")}
                    aria-pressed={decision === "rejected"}
                    className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold shadow-sm ${
                      decision === "rejected"
                        ? "bg-slate-700 text-white"
                        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Reject violation
                  </button>
                  {decision !== null && (
                    <span className="text-xs font-medium text-slate-600">
                      Reviewer {decision} this finding — recorded in the report.
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* Confirm (story 28). */}
      <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3">
        {confirmBlockers.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
            {confirmBlockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-600">
            Review complete — confirming records the reviewed result and time.
            Exports use this confirmed state.
          </p>
        )}
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmBlockers.length > 0 || confirming || confirmedAt !== null}
          className="mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1E40AF] disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {confirming ? "Confirming…" : "Confirm report"}
        </button>
      </div>

      {/* Full-photo lightbox. */}
      {lightboxPhoto !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Full photo ${lightboxPhoto.name}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 p-4"
          onClick={() => setLightboxPhotoId(null)}
        >
          <div
            className="max-h-full max-w-3xl overflow-auto rounded-lg bg-white p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightboxPhoto.url}
              alt={lightboxPhoto.name}
              className="max-h-[75vh] w-auto object-contain"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="truncate text-sm text-slate-600">
                {lightboxPhoto.name}
              </p>
              <button
                type="button"
                onClick={() => setLightboxPhotoId(null)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
