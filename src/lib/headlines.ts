/**
 * Shared headline helpers (Wave 3 fix #4).
 *
 * Single canonical copy of the tolerant headline resolution used by the
 * dashboard and repository. Both pages import from here instead of keeping
 * local duplicates, so real-inspection headlines stay consistent.
 *
 * Honesty contract: records without attached rule results honestly resolve
 * to "insufficient evidence" (mirrors computeHeadline([])). The numeric
 * internal score is never read here.
 */

import type { InspectionRecord } from "./store";
import type { ObservedInput, ReportHeadline, ReviewContext, RuleResult } from "./types";
import type { ObservedDeclaration } from "./observations";
import { toObservedInputs } from "./observations";
import { loadReview } from "./review-store";
import { computeHeadline, evaluateRules, resultsForHeadline } from "./rules";

/** Tolerant headline normalization: display/underscore/dash forms. */
export function normalizeHeadline(value: unknown): ReportHeadline | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (
    v === "suspected violation" ||
    v === "suspected_violation" ||
    v === "suspected-violation"
  )
    return "suspected violation";
  if (
    v === "insufficient evidence" ||
    v === "insufficient_evidence" ||
    v === "insufficient-evidence"
  )
    return "insufficient evidence";
  if (
    v === "no issue found in assessed checks" ||
    v === "no_issue_found" ||
    v === "no issue found"
  )
    return "no issue found in assessed checks";
  return null;
}

/**
 * Headline from honest rule results (`no_issue_found` /
 * `suspected_violation` / `not_assessed`). Null when no honest result is
 * present. Any suspected violation wins; all-not_assessed is insufficient
 * evidence; otherwise no issue was found in the assessed checks.
 */
export function headlineFromResults(results: unknown): ReportHeadline | null {
  if (!Array.isArray(results)) return null;
  const known: string[] = [];
  for (const item of results) {
    if (item !== null && typeof item === "object") {
      const r = (item as Record<string, unknown>).result;
      if (r === "suspected_violation" || r === "no_issue_found" || r === "not_assessed") {
        known.push(r);
      }
    }
  }
  if (known.length === 0) return null;
  if (known.includes("suspected_violation")) return "suspected violation";
  if (known.every((r) => r === "not_assessed")) return "insufficient evidence";
  return "no issue found in assessed checks";
}

/** Legacy overall-status mapping (lm_reports / pre-#6 shapes only). */
export function headlineFromLegacyStatus(status: unknown): ReportHeadline | null {
  if (status === "NON_COMPLIANT") return "suspected violation";
  if (status === "COMPLIANT") return "no issue found in assessed checks";
  if (status === "NEEDS_REVIEW") return "insufficient evidence";
  return null;
}

/**
 * Headline for one real IndexedDB inspection. Prefers explicit headline
 * fields added later by the review flow, then honest rule results, then
 * legacy-shaped checks (fail -> suspected), then a legacy overall status.
 * Falls back to "insufficient evidence" — never a fabricated verdict.
 */
export function resolveEntryHeadline(record: InspectionRecord): ReportHeadline {
  const rec = record as unknown as Record<string, unknown>;
  for (const key of ["headline", "reportHeadline", "overallHeadline", "verdict"]) {
    const h = normalizeHeadline(rec[key]);
    if (h) return h;
  }
  for (const key of ["ruleResults", "results", "rule_results"]) {
    const h = headlineFromResults(rec[key]);
    if (h) return h;
  }
  const checks = rec["checks"];
  if (Array.isArray(checks)) {
    const honest = headlineFromResults(checks);
    if (honest) return honest;
    let sawFail = false;
    let sawPass = false;
    for (const item of checks) {
      if (item === null || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      if (c["status"] === "fail") sawFail = true;
      else if (c["status"] === "pass") sawPass = true;
    }
    if (sawFail) return "suspected violation";
    if (sawPass) return "no issue found in assessed checks";
  }
  return headlineFromLegacyStatus(rec["overallStatus"]) ?? "insufficient evidence";
}

/**
 * Real headline for one inspection, computed from reviewer state (Wave 3
 * spec gap fix). Reads the unified review sidecar via `loadReview` (a sync
 * localStorage-map read; null on the server or when nothing was reviewed),
 * applies reviewer corrections over the model observations, and evaluates
 * the cited rules — the same pipeline as the scan/report flow.
 *
 * Correction semantics mirror `buildReviewedInputs` (ReviewPanel): a
 * `correctedTexts[obsId]` entry overrides that observation's value (empty
 * text means the reviewer confirms the declaration absent, i.e. null) and
 * clears `needsReview`. `field:<ObservedField>` entries (reviewer edits to
 * a field with no model observation) are added as reviewer-verified inputs.
 * Untouched observations keep the model's confidence gating via
 * `toObservedInputs`.
 *
 * Per the PRD headline rule the computed headline is returned regardless
 * of confirmation state (the three phrases apply before confirmation too);
 * `isDraft` (confirmedAt null) is exposed separately so callers render a
 * Draft badge instead of prefixing the headline.
 *
 * Returns null when there is no review state, so callers fall back to
 * `resolveEntryHeadline` (honestly "insufficient evidence"). The numeric
 * internal score is never read here.
 */
export interface RealHeadline {
  headline: ReportHeadline;
  /** True until the reviewer confirms (confirmedAt null). */
  isDraft: boolean;
  /** Honest per-check results backing the headline (for violation labels). */
  results: RuleResult[];
}

const REVIEWED_FIELDS: readonly ObservedInput["field"][] = [
  "manufacturer",
  "net_quantity",
  "mrp",
  "manufacture_date",
  "consumer_care",
];

function reviewCategory(raw: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return "unknown";
  if (/^auto(\b|[\s-_])/i.test(trimmed)) return "unknown";
  if (trimmed.toLowerCase() === "unknown") return "unknown";
  return trimmed;
}

export function resolveRealHeadline(
  inspectionId: string,
  photoCount: number,
): RealHeadline | null {
  let review: ReturnType<typeof loadReview>;
  try {
    review = loadReview(inspectionId);
  } catch {
    return null;
  }
  if (!review) return null;

  const observations: ObservedDeclaration[] = Array.isArray(review.observations)
    ? review.observations
    : [];
  const corrected: Record<string, string> =
    review.correctedTexts !== null && typeof review.correctedTexts === "object"
      ? review.correctedTexts
      : {};

  // toObservedInputs preserves order, so index i maps to observations[i].
  const inputs: ObservedInput[] = toObservedInputs(observations);
  observations.forEach((observation, i) => {
    const obsId: unknown = observation?.obsId;
    if (typeof obsId !== "string") return;
    if (!Object.prototype.hasOwnProperty.call(corrected, obsId)) return;
    const text = corrected[obsId].trim();
    inputs[i] = {
      ...inputs[i],
      value: text.length > 0 ? text : null,
      needsReview: false,
    };
  });

  // Reviewer edits to fields with no model observation.
  const covered = new Set(inputs.map((input) => input.field));
  for (const [key, text] of Object.entries(corrected)) {
    if (!key.startsWith("field:")) continue;
    const field = key.slice("field:".length) as ObservedInput["field"];
    if (!REVIEWED_FIELDS.includes(field)) continue;
    if (covered.has(field)) continue;
    const trimmed = (text ?? "").trim();
    inputs.push({
      field,
      value: trimmed.length > 0 ? trimmed : null,
      needsReview: false,
    });
    covered.add(field);
  }

  const ctx: ReviewContext = {
    category: reviewCategory(review.reviewedCategory),
    importStatus: review.reviewedImport ?? "unknown",
    coverageConfirmed: review.coverageConfirmed === true,
    photoCount,
  };
  const results = evaluateRules(inputs, ctx);
  const forHeadline = resultsForHeadline(results, review.decisions);
  return {
    headline: computeHeadline(forHeadline),
    isDraft: review.confirmedAt == null,
    results: forHeadline,
  };
}
