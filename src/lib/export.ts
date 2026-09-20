/**
 * Reviewed-report exports for NyayaPack (GitHub issue #9, PRD stories 33-34).
 *
 * - `buildReportModel(inspection, observations?, overlay?)` assembles one
 *   export model from the stored inspection, the model's original
 *   observations, and the reviewer's corrections/decisions. Reviewed values
 *   win; the original model reading survives beside them as an audit note.
 * - `exportPdf(model)` returns a fixed-layout PDF document (jsPDF).
 * - `exportDocx(model)` returns the same content as an editable DOCX (Blob).
 *
 * Honesty contract:
 * - Only reviewed values appear as findings. The internal numeric score and
 *   any API key are NEVER included (they are not even parameters here).
 * - An unconfirmed report is visibly a draft: both files stamp DRAFT in the
 *   header and (PDF) as a page watermark. Nothing is silently final.
 * - Evidence is a photo reference (file name + photo id) or an explicit
 *   "no evidence recorded" note. Images are never invented.
 * - Pure module: no DOM, no storage, no network. Safe to run in Node for
 *   verification as well as in the browser report page.
 */

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { jsPDF } from "jspdf";
import { FIELD_MAP, type ObservedDeclaration } from "./observations";
import { RULE_CATALOG, computeHeadline, evaluateRules, resultsForHeadline } from "./rules";
import type { InspectionRecord } from "./store";
import type {
  CheckResult,
  ImportStatus,
  ObservedField,
  ObservedInput,
  ReportHeadline,
  ReviewContext,
  RuleResult,
} from "./types";

/** The five declaration groups covered by the cited rule catalog, in order. */
export const REVIEW_FIELDS: readonly ObservedField[] = [
  "manufacturer",
  "net_quantity",
  "mrp",
  "manufacture_date",
  "consumer_care",
] as const;

/** Reviewer decision on one suspected violation. Absent = awaiting review. */
export type FindingDecision = "accepted" | "rejected";

/**
 * Reviewer-owned corrections and decisions for one inspection. The report
 * page persists this beside the stored inspection (the store schema itself
 * is owned by another agent and stays untouched).
 */
export interface ReviewOverlay {
  productName: string;
  brand: string;
  /** Reviewed broad category; "" or "auto" means undecided ("unknown"). */
  category: string;
  importStatus: ImportStatus;
  /** Reviewer confirms the relevant package sides were photographed. */
  coverageConfirmed: boolean;
  /**
   * Corrected declaration text per field. `null` means the reviewer
   * confirms the declaration is missing, not seen. An ABSENT key means the
   * reviewer has not touched the field: the model value shows as-is.
   */
  reviewedValues: Partial<Record<ObservedField, string | null>>;
  /** Accept/reject per suspected-violation rule. Absent = awaiting review. */
  findingDecisions: Partial<Record<ObservedField, FindingDecision>>;
  /** ISO timestamp of reviewer confirmation; null until confirmed. */
  confirmedAt: string | null;
}

export function emptyReviewOverlay(): ReviewOverlay {
  return {
    productName: "",
    brand: "",
    category: "",
    importStatus: "unknown",
    coverageConfirmed: false,
    reviewedValues: {},
    findingDecisions: {},
    confirmedAt: null,
  };
}

/** One declaration row: reviewed value plus the original-reading audit note. */
export interface ReportDeclaration {
  field: ObservedField;
  label: string;
  /** Reviewed (corrected where edited) value; null = confirmed missing. */
  reviewedValue: string | null;
  /** Original model reading; null when the model recorded nothing. */
  originalValue: string | null;
  /** True when the reviewer changed the model reading. */
  corrected: boolean;
  /** Audit/traceability note, or null when nothing needs flagging. */
  auditNote: string | null;
  photoId: string | null;
  photoName: string | null;
  /** True when the reading still needs a reviewer look. */
  needsReview: boolean;
  /** False when the model recorded no observation for this field. */
  hasObservation: boolean;
}

/** One assessed check (no_issue_found or suspected_violation). */
export interface ReportFinding {
  ruleId: ObservedField;
  label: string;
  result: Exclude<CheckResult, "not_assessed">;
  /** Reviewer decision; null while a suspected violation awaits review. */
  decision: FindingDecision | null;
  legalCitation: string;
  gazetteNumber: string;
  effectiveFrom: string;
  sourceUrl: string;
  message: string;
  evidenceValue: string | null;
  evidencePhotoName: string | null;
}

/** One check that could not be assessed, with the honest reason. */
export interface ReportNotAssessed {
  ruleId: ObservedField;
  label: string;
  legalCitation: string;
  gazetteNumber: string;
  effectiveFrom: string;
  sourceUrl: string;
  message: string;
}

/** The full reviewed-report model shared by the PDF and DOCX renderers. */
export interface ReportModel {
  inspectionId: string;
  productName: string;
  brand: string;
  category: string;
  importStatus: ImportStatus;
  inspectionDate: string;
  confirmedAt: string | null;
  /** True until the reviewer confirms: exports must stamp DRAFT. */
  isDraft: boolean;
  headline: ReportHeadline;
  coverageConfirmed: boolean;
  declarations: ReportDeclaration[];
  findings: ReportFinding[];
  notAssessed: ReportNotAssessed[];
  photoRefs: { photoId: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Model builder.
// ---------------------------------------------------------------------------

function catalogLabel(field: ObservedField): string {
  return RULE_CATALOG.find((entry) => entry.ruleId === field)?.label ?? field;
}

function hasKey(
  record: Partial<Record<ObservedField, string | null>>,
  field: ObservedField,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

/** First model observation feeding a catalog field, if any. */
function findObservation(
  observations: ObservedDeclaration[],
  field: ObservedField,
): ObservedDeclaration | null {
  for (const observation of observations) {
    if (FIELD_MAP[observation.field] === field) return observation;
  }
  return null;
}

function reviewCategory(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0 || /^auto(\b|[\s-_])/i.test(trimmed)) return "unknown";
  return trimmed;
}

/**
 * Assemble the export model. `inspection` is the stored record from
 * `getInspection`; `observations` are the model's original readings;
 * `overlay` holds reviewer corrections (defaults to untouched review).
 */
export function buildReportModel(
  inspection: InspectionRecord,
  observations: ObservedDeclaration[] = [],
  overlay: ReviewOverlay | null = null,
): ReportModel {
  const review: ReviewOverlay = overlay ?? emptyReviewOverlay();
  const safeObservations = Array.isArray(observations) ? observations : [];
  const category = reviewCategory(review.category || inspection.categoryHint);
  const photoNameById = new Map<string, string>();
  for (const photo of inspection.photos) {
    photoNameById.set(photo.photoId, photo.name);
  }

  const ctx: ReviewContext = {
    category,
    importStatus: review.importStatus ?? "unknown",
    coverageConfirmed: review.coverageConfirmed === true,
    photoCount: inspection.photos.length,
  };

  // Rules-facing inputs: reviewed text wins and counts as reviewer-verified;
  // untouched fields use the model reading; fields with neither are absent
  // so the engine reports "no assessable evidence" instead of guessing.
  const inputs: ObservedInput[] = [];
  for (const field of REVIEW_FIELDS) {
    const observation = findObservation(safeObservations, field);
    if (hasKey(review.reviewedValues, field)) {
      inputs.push({
        field,
        value: review.reviewedValues[field] ?? null,
        ...(observation ? { photoId: observation.photoId } : {}),
        needsReview: false,
      });
    } else if (observation) {
      inputs.push({
        field,
        value: observation.value,
        photoId: observation.photoId,
        needsReview: observation.confidence !== "ok",
      });
    }
  }

  const results: RuleResult[] = evaluateRules(inputs, ctx);

  const declarations: ReportDeclaration[] = REVIEW_FIELDS.map((field) => {
    const observation = findObservation(safeObservations, field);
    const originalValue: string | null = observation?.value ?? null;
    const touched = hasKey(review.reviewedValues, field);
    const reviewedValue: string | null = touched
      ? (review.reviewedValues[field] ?? null)
      : originalValue;
    const corrected = touched && reviewedValue !== originalValue;
    const photoId: string | null = observation?.photoId ?? null;
    const photoName: string | null =
      photoId !== null ? (photoNameById.get(photoId) ?? null) : null;

    let auditNote: string | null = null;
    if (!observation && !touched) {
      auditNote = "No model observation recorded for this declaration.";
    } else if (corrected) {
      auditNote =
        `Reviewer corrected this value. Model originally read: ` +
        (originalValue === null ? "nothing (null)." : `"${originalValue}".`);
    } else if (observation && observation.confidence !== "ok") {
      auditNote = `Model reading needs review (${observation.confidence}); shown as recorded.`;
    }
    if (photoId !== null && photoName === null) {
      const missing =
        "Its source photograph is no longer part of this inspection.";
      auditNote = auditNote === null ? missing : `${auditNote} ${missing}`;
    }

    return {
      field,
      label: catalogLabel(field),
      reviewedValue,
      originalValue,
      corrected,
      auditNote,
      photoId,
      photoName,
      needsReview: touched ? false : (observation?.confidence !== "ok" && observation !== null),
      hasObservation: observation !== null,
    };
  });

  const findings: ReportFinding[] = [];
  const notAssessed: ReportNotAssessed[] = [];
  for (const result of results) {
    const evidencePhotoName =
      result.evidence?.photoId !== undefined
        ? (photoNameById.get(result.evidence.photoId) ?? null)
        : null;
    if (result.result === "not_assessed") {
      notAssessed.push({
        ruleId: result.ruleId,
        label: result.label,
        legalCitation: result.legalCitation,
        gazetteNumber: result.gazetteNumber,
        effectiveFrom: result.effectiveFrom,
        sourceUrl: result.sourceUrl,
        message: result.message,
      });
    } else {
      findings.push({
        ruleId: result.ruleId,
        label: result.label,
        result: result.result,
        decision:
          result.result === "suspected_violation"
            ? (review.findingDecisions[result.ruleId] ?? null)
            : null,
        legalCitation: result.legalCitation,
        gazetteNumber: result.gazetteNumber,
        effectiveFrom: result.effectiveFrom,
        sourceUrl: result.sourceUrl,
        message: result.message,
        evidenceValue: result.evidence?.value ?? null,
        evidencePhotoName,
      });
    }
  }

  const confirmedAt = review.confirmedAt;
  return {
    inspectionId: inspection.inspectionId,
    productName: review.productName.trim() || "Untitled package",
    brand: review.brand.trim() || "Not recorded",
    category,
    importStatus: review.importStatus ?? "unknown",
    inspectionDate: inspection.createdAt,
    confirmedAt,
    isDraft: inspection.status !== "confirmed" || confirmedAt === null,
    headline: computeHeadline(resultsForHeadline(results, review.findingDecisions)),
    coverageConfirmed: ctx.coverageConfirmed,
    declarations,
    findings,
    notAssessed,
    photoRefs: inspection.photos.map((photo) => ({
      photoId: photo.photoId,
      name: photo.name,
    })),
  };
}

/** File-safe base name for exported files, derived from the product name. */
export function reportFileBase(model: ReportModel): string {
  const base = (model.productName || "package")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
  return base || "package";
}

// ---------------------------------------------------------------------------
// Shared wording.
// ---------------------------------------------------------------------------

const DRAFT_LINE = "DRAFT — pending reviewer confirmation. Do not treat as final.";
const AID_NOTE =
  "This report is an inspection aid, not legal certification. " +
  "Internal test scores and API keys are never included in exports.";

function findingStatus(finding: ReportFinding): string {
  if (finding.result === "no_issue_found") return "NO ISSUE FOUND";
  if (finding.decision === "accepted") return "SUSPECTED VIOLATION — ACCEPTED BY REVIEWER";
  if (finding.decision === "rejected") return "SUSPECTED VIOLATION — REJECTED BY REVIEWER";
  return "SUSPECTED VIOLATION — AWAITING REVIEWER DECISION";
}

function declarationLine(declaration: ReportDeclaration): string {
  if (declaration.reviewedValue === null) {
    return declaration.corrected
      ? "Reviewed value: (confirmed missing by reviewer)"
      : "Reviewed value: (not observed)";
  }
  return `Reviewed value: "${declaration.reviewedValue}"`;
}

// ---------------------------------------------------------------------------
// PDF renderer (jsPDF).
// ---------------------------------------------------------------------------

/**
 * Build the fixed-layout PDF for a report model. The caller saves it
 * (`doc.save(...)` in the browser). Draft models carry a DRAFT header and
 * a diagonal DRAFT watermark on every page.
 */
export function exportPdf(model: ReportModel): jsPDF {
  const doc = new jsPDF();
  const margin = 14;
  const width = 210 - margin * 2;
  let y = 18;

  function ensure(lines: number): void {
    if (y + lines * 5.5 > 285) {
      doc.addPage();
      y = 18;
    }
  }

  function writeLines(text: string, size: number, gap = 5.5): void {
    doc.setFontSize(size);
    const wrapped = doc.splitTextToSize(text, width);
    ensure(wrapped.length);
    doc.text(wrapped, margin, y);
    y += wrapped.length * gap;
  }

  doc.setFontSize(17);
  doc.text("NyayaPack inspection report", margin, y);
  y += 9;

  if (model.isDraft) {
    doc.setTextColor(185, 28, 28);
    writeLines(DRAFT_LINE, 12);
    doc.setTextColor(0, 0, 0);
  }

  doc.setFontSize(11);
  for (const line of [
    `Product: ${model.productName}`,
    `Brand: ${model.brand}`,
    `Category (reviewed): ${model.category}`,
    `Import status (reviewed): ${model.importStatus}`,
    `Inspection date: ${model.inspectionDate}`,
    model.confirmedAt === null
      ? "Status: draft (not yet confirmed by reviewer)"
      : `Status: confirmed by reviewer at ${model.confirmedAt}`,
    `Inspection-aid result: ${model.headline}`,
    model.coverageConfirmed
      ? "Photo coverage: reviewer confirmed the relevant package sides were photographed."
      : "Photo coverage: NOT confirmed — an unseen declaration cannot be called missing.",
  ]) {
    writeLines(line, 11);
  }
  y += 2;

  doc.setFontSize(13);
  ensure(2);
  doc.text("Reviewed declarations", margin, y);
  y += 7;
  model.declarations.forEach((declaration, index) => {
    writeLines(`${index + 1}. ${declaration.label}`, 11);
    writeLines(`   ${declarationLine(declaration)}`, 10);
    if (declaration.auditNote !== null) {
      writeLines(`   Audit note: ${declaration.auditNote}`, 10);
    }
    writeLines(
      declaration.photoName !== null
        ? `   Evidence: photo "${declaration.photoName}" (${declaration.photoId})`
        : "   Evidence: no source photograph recorded for this declaration.",
      10,
    );
    y += 1.5;
  });

  doc.setFontSize(13);
  ensure(2);
  doc.text("Assessed findings (reviewed)", margin, y);
  y += 7;
  if (model.findings.length === 0) {
    writeLines("No check could be assessed from the available evidence.", 10);
  }
  for (const finding of model.findings) {
    writeLines(
      `${findingStatus(finding)} — ${finding.label} ` +
        `(${finding.legalCitation}; effective ${finding.effectiveFrom})`,
      10,
    );
    writeLines(`   ${finding.message}`, 10);
    if (finding.evidenceValue !== null) {
      writeLines(
        `   Evidence text: "${finding.evidenceValue}"` +
          (finding.evidencePhotoName !== null
            ? ` (photo "${finding.evidencePhotoName}")`
            : " (no source photograph recorded)"),
        10,
      );
    }
    writeLines(`   Source: ${finding.sourceUrl}`, 9);
    y += 1.5;
  }

  doc.setFontSize(13);
  ensure(2);
  doc.text("Not assessed", margin, y);
  y += 7;
  if (model.notAssessed.length === 0) {
    writeLines("Every supported check was assessed.", 10);
  }
  for (const item of model.notAssessed) {
    writeLines(
      `NOT ASSESSED — ${item.label} (${item.legalCitation}; effective ${item.effectiveFrom})`,
      10,
    );
    writeLines(`   ${item.message}`, 10);
    writeLines(`   Source: ${item.sourceUrl}`, 9);
    y += 1.5;
  }

  doc.setFontSize(13);
  ensure(2);
  doc.text("Photograph references", margin, y);
  y += 7;
  if (model.photoRefs.length === 0) {
    writeLines("No photographs are stored in this inspection.", 10);
  }
  for (const ref of model.photoRefs) {
    writeLines(`- "${ref.name}" (${ref.photoId})`, 10);
  }
  y += 3;
  writeLines(AID_NOTE, 10);

  if (model.isDraft) {
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
      doc.setPage(page);
      doc.setTextColor(205, 205, 205);
      doc.setFontSize(72);
      doc.text("DRAFT", 105, 150, { align: "center", angle: 45 });
    }
    doc.setTextColor(0, 0, 0);
  }

  return doc;
}

// ---------------------------------------------------------------------------
// DOCX renderer (docx, editable).
// ---------------------------------------------------------------------------

function run(text: string, bold = false, color?: string, size?: number): TextRun {
  return new TextRun({
    text,
    bold: bold === true ? true : undefined,
    color,
    size,
  });
}

/**
 * Build the editable DOCX for a report model (same content as the PDF).
 * Draft models carry a DRAFT heading instead of a final title.
 */
export async function exportDocx(model: ReportModel): Promise<Blob> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [
        run(model.isDraft ? "NyayaPack inspection report (DRAFT)" : "NyayaPack inspection report"),
      ],
    }),
  );
  if (model.isDraft) {
    children.push(
      new Paragraph({
        children: [run(DRAFT_LINE, true, "B91C1C")],
      }),
    );
  }

  for (const line of [
    `Product: ${model.productName}`,
    `Brand: ${model.brand}`,
    `Category (reviewed): ${model.category}`,
    `Import status (reviewed): ${model.importStatus}`,
    `Inspection date: ${model.inspectionDate}`,
    model.confirmedAt === null
      ? "Status: draft (not yet confirmed by reviewer)"
      : `Status: confirmed by reviewer at ${model.confirmedAt}`,
    `Inspection-aid result: ${model.headline}`,
    model.coverageConfirmed
      ? "Photo coverage: reviewer confirmed the relevant package sides were photographed."
      : "Photo coverage: NOT confirmed — an unseen declaration cannot be called missing.",
  ]) {
    children.push(new Paragraph({ children: [run(line)] }));
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run("Reviewed declarations")] }));
  model.declarations.forEach((declaration, index) => {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run(`${index + 1}. ${declaration.label}`)] }),
      new Paragraph({ children: [run(declarationLine(declaration))] }),
    );
    if (declaration.auditNote !== null) {
      children.push(new Paragraph({ children: [run(`Audit note: ${declaration.auditNote}`)] }));
    }
    children.push(
      new Paragraph({
        children: [
          run(
            declaration.photoName !== null
              ? `Evidence: photo "${declaration.photoName}" (${declaration.photoId})`
              : "Evidence: no source photograph recorded for this declaration.",
          ),
        ],
      }),
    );
  });

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run("Assessed findings (reviewed)")] }));
  if (model.findings.length === 0) {
    children.push(new Paragraph({ children: [run("No check could be assessed from the available evidence.")] }));
  }
  for (const finding of model.findings) {
    children.push(
      new Paragraph({
        children: [
          run(
            `${findingStatus(finding)} — ${finding.label} (${finding.legalCitation}; effective ${finding.effectiveFrom})`,
            true,
          ),
        ],
      }),
      new Paragraph({ children: [run(finding.message)] }),
    );
    if (finding.evidenceValue !== null) {
      children.push(
        new Paragraph({
          children: [
            run(
              `Evidence text: "${finding.evidenceValue}"` +
                (finding.evidencePhotoName !== null
                  ? ` (photo "${finding.evidencePhotoName}")`
                  : " (no source photograph recorded)"),
            ),
          ],
        }),
      );
    }
    children.push(new Paragraph({ children: [run(`Source: ${finding.sourceUrl}`)] }));
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run("Not assessed")] }));
  if (model.notAssessed.length === 0) {
    children.push(new Paragraph({ children: [run("Every supported check was assessed.")] }));
  }
  for (const item of model.notAssessed) {
    children.push(
      new Paragraph({
        children: [
          run(`NOT ASSESSED — ${item.label} (${item.legalCitation}; effective ${item.effectiveFrom})`, true),
        ],
      }),
      new Paragraph({ children: [run(item.message)] }),
      new Paragraph({ children: [run(`Source: ${item.sourceUrl}`)] }),
    );
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run("Photograph references")] }));
  if (model.photoRefs.length === 0) {
    children.push(new Paragraph({ children: [run("No photographs are stored in this inspection.")] }));
  }
  for (const ref of model.photoRefs) {
    children.push(new Paragraph({ children: [run(`"${ref.name}" (${ref.photoId})`)] }));
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [run(AID_NOTE, false, "64748B", 18)],
    }),
  );

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}
