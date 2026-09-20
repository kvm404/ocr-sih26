/**
 * Full-flow contract test (GitHub issue #11, PRD Testing Decisions).
 *
 * Exercises the user-visible inspection pipeline with a CONTROLLED model
 * response fixture — no network, no prompt/component assertions:
 *
 *   photos -> parseExtractionResponse -> toObservedInputs ->
 *   evaluateRules (+ coverage gating) -> reviewer correction ->
 *   save/reopen shape -> buildReportModel (reviewed values + citations) ->
 *   headline + dashboard-zero state.
 *
 * Asserts what the user sees and saves, not internal prompts or components.
 */

import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import {
  parseExtractionResponse,
  resolveCategory,
  toObservedInputs,
} from "../src/lib/observations";
import { computeHeadline, evaluateRules } from "../src/lib/rules";
import {
  headlineFromResults,
  normalizeHeadline,
} from "../src/lib/headlines";
import {
  buildReportModel,
  exportDocx,
  exportPdf,
} from "../src/lib/export";
import type { InspectionRecord } from "../src/lib/store";
import type { ObservedDeclaration } from "../src/lib/observations";
import type { ReportModel } from "../src/lib/export";
import type { ReviewContext } from "../src/lib/types";

/** Two-photo inspection ids, as the upload flow would assign them. */
const PHOTO_IDS = ["p-front", "p-back"];

/**
 * Controlled model response: a chat/completions envelope whose message
 * content holds the extraction JSON. Covers two photos, a confident
 * reading with a region, an uncertain reading, and a category suggestion.
 */
function controlledEnvelope() {
  const extraction = {
    observations: [
      {
        field: "manufacturer",
        value: "Acme Foods Ltd, 12 Market Road, Mumbai",
        photoId: "p-front",
        region: { x: 0.1, y: 0.2, w: 0.6, h: 0.15 },
        confidence: "ok",
        rawModelText: "Acme Foods Ltd, 12 Market Road, Mumbai",
      },
      {
        field: "mrp",
        value: "Rs 95",
        photoId: "p-front",
        region: { x: 0.1, y: 0.7, w: 0.3, h: 0.1 },
        confidence: "ok",
        rawModelText: "Rs 95",
      },
      {
        field: "netQuantity",
        value: "500 g-ish?",
        photoId: "p-back",
        region: null,
        confidence: "uncertain",
        rawModelText: "500 g-ish?",
      },
      {
        field: "consumerCare",
        value: "care@acme.example, 1800-123-456",
        photoId: "p-back",
        region: { x: 0.2, y: 0.5, w: 0.5, h: 0.12 },
        confidence: "ok",
        rawModelText: "care@acme.example, 1800-123-456",
      },
    ],
    categorySuggestion: "Food and beverages",
    categoryUncertain: false,
    importSuggestion: "domestic",
    qualityFlags: [],
  };
  return {
    choices: [{ message: { content: JSON.stringify(extraction) } }],
  };
}

function draftInspection(): InspectionRecord {
  return {
    inspectionId: "insp-contract-1",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    categoryHint: "auto",
    status: "draft",
    photos: [
      {
        photoId: "p-front",
        name: "front.jpg",
        type: "image/jpeg",
        size: 1200,
        addedAt: "2026-09-18T00:00:00.000Z",
        blob: new Blob(["front-bytes"], { type: "image/jpeg" }),
      },
      {
        photoId: "p-back",
        name: "back.jpg",
        type: "image/jpeg",
        size: 1300,
        addedAt: "2026-09-18T00:00:00.000Z",
        blob: new Blob(["back-bytes"], { type: "image/jpeg" }),
      },
    ],
  };
}

/** Confirmed copy of the draft inspection (same photos, confirmed status). */
function confirmedInspection(): InspectionRecord {
  const draft = draftInspection();
  return { ...draft, status: "confirmed" };
}

/**
 * Dashboard aggregation over reviewed report models. Mirrors
 * `src/app/dashboard/page.tsx` stats: total counts every entry, headline
 * buckets compare against the same three headline strings, and drafts are
 * counted via the pure `ReportModel.isDraft` flag (no IndexedDB /
 * localStorage read). Uses `normalizeHeadline` — the same tolerant helper
 * the dashboard/repository pages import — so empty and populated cases run
 * the same code path.
 */
function aggregateDashboard(models: ReportModel[]): {
  total: number;
  suspected: number;
  noIssue: number;
  draft: number;
} {
  return {
    total: models.length,
    suspected: models.filter(
      (m) => normalizeHeadline(m.headline) === "suspected violation",
    ).length,
    noIssue: models.filter(
      (m) =>
        normalizeHeadline(m.headline) === "no issue found in assessed checks",
    ).length,
    draft: models.filter((m) => m.isDraft).length,
  };
}

/**
 * Extract `word/document.xml` from a DOCX (zip) buffer with no new deps.
 * Minimal central-directory parse: locate EOCD, walk the central directory
 * to `word/document.xml`, then inflate the local-header data with
 * `node:zlib` (method 8 = deflate, method 0 = stored). Sizes/offsets come
 * from the central directory (robust when the local header uses a data
 * descriptor).
 */
function extractDocxDocumentXml(zip: Buffer): string {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("DOCX: end-of-central-directory not found");
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  for (let n = 0; n < entryCount; n++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`DOCX: bad central-directory signature at entry ${n}`);
    }
    const method = zip.readUInt16LE(cursor + 10);
    const compSize = zip.readUInt32LE(cursor + 20);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip
      .subarray(cursor + 46, cursor + 46 + nameLen)
      .toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;
    if (name !== "word/document.xml") continue;
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("DOCX: bad local header for word/document.xml");
    }
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = zip.subarray(dataStart, dataStart + compSize);
    if (method === 8) return inflateRawSync(data).toString("utf8");
    if (method === 0) return data.toString("utf8");
    throw new Error(`DOCX: unsupported compression method ${method}`);
  }
  throw new Error("DOCX: word/document.xml not found");
}

describe("full-flow contract (controlled model response, no network)", () => {
  it("parses multi-photo extraction with photo links, regions, and review flags", () => {
    const result = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);

    // User-visible: four declarations, each tied to its source photograph.
    expect(result.observations).toHaveLength(4);
    for (const obs of result.observations) {
      expect(PHOTO_IDS).toContain(obs.photoId);
      expect(typeof obs.rawModelText).toBe("string");
    }

    const mfr = result.observations.find((o) => o.field === "manufacturer");
    expect(mfr?.value).toBe("Acme Foods Ltd, 12 Market Road, Mumbai");
    expect(mfr?.confidence).toBe("ok");
    expect(mfr?.region).toBeDefined();

    // Uncertain reading: value withheld (null), kept for review — never guessed.
    const qty = result.observations.find((o) => o.field === "netQuantity");
    expect(qty?.confidence).toBe("uncertain");
    expect(qty?.value).toBeNull();
    expect(qty?.region).toBeUndefined();

    expect(result.categorySuggestion).toBe("Food and beverages");
    expect(result.importSuggestion).toBe("domestic");
  });

  it("manual category overrides the model suggestion; blank leaves model inference", () => {
    const manual = resolveCategory("Household products", "Food and beverages", false);
    expect(manual.category).toBe("Household products");
    expect(manual.source).toBe("manual");

    const auto = resolveCategory("Auto-detect", "Food and beverages", false);
    expect(auto.category).toBe("Food and beverages");
    expect(auto.source).toBe("model");
  });

  it("invalid model output is an unknown result needing review, never a silent success", () => {
    const result = parseExtractionResponse("definitely not json {{{", PHOTO_IDS);
    expect(result.observations).toEqual([]);
    expect(result.categorySuggestion).toBeNull();
    expect(result.categoryUncertain).toBe(true);
    expect(result.importSuggestion).toBe("unknown");
    // Unparseable output attests nothing — both photos stay unattested.
    expect(result.unattestedPhotoIds).toEqual(PHOTO_IDS);
  });

  it("tracks photos the model silently ignored so their silence never reads as absence", () => {
    const partial = {
      observations: [
        {
          field: "manufacturer",
          value: "Acme Foods Ltd",
          photoId: "p-front",
          region: null,
          confidence: "ok",
          rawModelText: "Acme Foods Ltd",
        },
      ],
      categorySuggestion: null,
      categoryUncertain: true,
      importSuggestion: "unknown",
      qualityFlags: [],
    };
    const envelope = { choices: [{ message: { content: JSON.stringify(partial) } }] };
    const result = parseExtractionResponse(envelope, PHOTO_IDS);
    expect(result.observations).toHaveLength(1);
    // p-back appears nowhere: flagged, never treated as "nothing there".
    expect(result.unattestedPhotoIds).toEqual(["p-back"]);

    const full = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);
    expect(full.unattestedPhotoIds).toEqual([]);
  });

  it("forces reviewer attention on an MRP value containing a percent sign", () => {
    const bad = {
      observations: [
        {
          field: "mrp",
          value: "Rs. 56 35%",
          photoId: "p-back",
          region: { x: 0.1, y: 0.4, w: 0.2, h: 0.05 },
          confidence: "ok",
          rawModelText: "MRP. Rs. 56 35%",
        },
      ],
      categorySuggestion: null,
      categoryUncertain: true,
      importSuggestion: "unknown",
      qualityFlags: [],
    };
    const envelope = { choices: [{ message: { content: JSON.stringify(bad) } }] };
    const result = parseExtractionResponse(envelope, PHOTO_IDS);
    const mrp = result.observations.find((o) => o.field === "mrp");
    // Promo/rupee-as-percent: keep the promo amount, never confident; no highlight.
    expect(mrp?.value).toBe("Rs. 35");
    expect(mrp?.confidence).toBe("uncertain");
    expect(mrp?.region).toBeUndefined();
    expect(mrp?.rawModelText).toMatch(/MRP\. Rs\. 56 35%/);
    expect(mrp?.rawModelText).toMatch(/promo 35/i);
  });

  it("gates missing declarations on coverage: not_assessed until coverage confirmed", () => {
    const result = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);
    const inputs = toObservedInputs(result.observations);
    // Reviewer confirms the MRP declaration is genuinely missing (explicit null).
    const missingMrp = inputs.map((i) =>
      i.field === "mrp" ? { ...i, value: null as string | null, needsReview: false } : i,
    );
    const base: Omit<ReviewContext, "coverageConfirmed"> = {
      category: "household",
      importStatus: "domestic",
      photoCount: 2,
    };
    const before = evaluateRules(missingMrp, { ...base, coverageConfirmed: false }).find(
      (r) => r.ruleId === "mrp",
    );
    expect(before?.result).toBe("not_assessed");
    expect(before?.message).toMatch(/has not confirmed|photographed/i);

    const after = evaluateRules(missingMrp, { ...base, coverageConfirmed: true }).find(
      (r) => r.ruleId === "mrp",
    );
    expect(after?.result).toBe("suspected_violation");
  });

  it("reviewer correction preserves the original reading and export uses reviewed values + citations", () => {
    const result = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);
    const inspection = draftInspection();

    const model = buildReportModel(inspection, result.observations, {
      productName: "Acme Biscuits",
      brand: "Acme",
      category: "household",
      importStatus: "domestic",
      coverageConfirmed: true,
      reviewedValues: { mrp: "Rs 99" },
      findingDecisions: { mrp: "accepted" },
      confirmedAt: "2026-09-18T01:00:00.000Z",
    });

    // Corrected declaration: reviewed wins, original preserved with audit note.
    const mrpDecl = model.declarations.find((d) => d.field === "mrp");
    expect(mrpDecl?.reviewedValue).toBe("Rs 99");
    expect(mrpDecl?.originalValue).toBe("Rs 95");
    expect(mrpDecl?.corrected).toBe(true);
    expect(mrpDecl?.auditNote).toMatch(/originally read/);
    expect(mrpDecl?.photoName).toBe("front.jpg");

    // Export findings carry reviewed evidence plus exact legal citations.
    const mrpFinding = model.findings.find((f) => f.ruleId === "mrp");
    expect(mrpFinding?.evidenceValue).toBe("Rs 99");
    expect(mrpFinding?.evidencePhotoName).toBe("front.jpg");
    expect(mrpFinding?.legalCitation).toBe("Rule 6(1)(e)");
    expect(mrpFinding?.sourceUrl).toMatch(/^https?:\/\//);
    expect(mrpFinding?.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("headline reflects assessed checks: violation wins, else no-issue or insufficient evidence", () => {
    const result = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);
    const inputs = toObservedInputs(result.observations);
    const ctx: ReviewContext = {
      category: "household",
      importStatus: "domestic",
      coverageConfirmed: true,
      photoCount: 2,
    };
    // Confident manufacturer + MRP + consumer care present and covered.
    expect(computeHeadline(evaluateRules(inputs, ctx))).toBe(
      "no issue found in assessed checks",
    );

    const withMissing = inputs.map((i) =>
      i.field === "mrp" ? { ...i, value: null as string | null, needsReview: false } : i,
    );
    expect(computeHeadline(evaluateRules(withMissing, ctx))).toBe("suspected violation");
    expect(computeHeadline([])).toBe("insufficient evidence");
  });

  it("export headline drops a reviewer-rejected suspected violation but keeps the finding", () => {
    const result = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);
    const inspection = confirmedInspection();
    const observations = result.observations.map((o) =>
      o.field === "mrp" ? { ...o, value: null, confidence: "ok" as const } : o,
    );
    const model = buildReportModel(inspection, observations, {
      productName: "Acme Biscuits",
      brand: "Acme",
      category: "household",
      importStatus: "domestic",
      coverageConfirmed: true,
      reviewedValues: { mrp: null },
      findingDecisions: { mrp: "rejected" },
      confirmedAt: "2026-09-18T01:00:00.000Z",
    });
    expect(model.headline).toBe("no issue found in assessed checks");
    const mrp = model.findings.find((f) => f.ruleId === "mrp");
    expect(mrp?.result).toBe("suspected_violation");
    expect(mrp?.decision).toBe("rejected");
  });

  it("save/reopen shape: photographs and review state survive a storage round-trip", () => {
    const inspection = draftInspection();
    const result = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);

    // Shape the save path persists: metadata + review payload (bytes live
    // beside the metadata in IndexedDB; here we round-trip the JSON-able
    // shape the reopen path relies on).
    const savedMetadata = JSON.parse(
      JSON.stringify({
        ...inspection,
        photos: inspection.photos.map((p) => ({
          photoId: p.photoId,
          name: p.name,
          type: p.type,
          size: p.size,
          addedAt: p.addedAt,
        })),
      }),
    );
    const savedReview = JSON.parse(
      JSON.stringify({
        observations: result.observations,
        correctedTexts: { "obs-2": "Rs 99" } as Record<string, string>,
        reviewedCategory: "household",
        reviewedImport: "domestic",
        coverageConfirmed: true,
        decisions: { mrp: "accepted" },
        confirmedAt: "2026-09-18T01:00:00.000Z",
      }),
    );

    // Reopen: same inspection, same photographs, same review decisions.
    expect(savedMetadata.inspectionId).toBe(inspection.inspectionId);
    expect(savedMetadata.photos.map((p: { photoId: string }) => p.photoId)).toEqual([
      "p-front",
      "p-back",
    ]);
    expect(savedMetadata.photos.map((p: { name: string }) => p.name)).toEqual([
      "front.jpg",
      "back.jpg",
    ]);
    expect(savedReview.coverageConfirmed).toBe(true);
    expect(savedReview.decisions).toEqual({ mrp: "accepted" });
    expect(savedReview.correctedTexts).toEqual({ "obs-2": "Rs 99" });

    // Reopened observations still carry evidence for the report.
    const reopened = savedReview.observations as ObservedDeclaration[];
    expect(reopened.find((o) => o.field === "manufacturer")?.photoId).toBe("p-front");
  });

  it("empty store gives zero dashboard counts and no sample cards", () => {
    const savedInspections: InspectionRecord[] = [];
    const totals = {
      total: savedInspections.length,
      withPhotos: savedInspections.filter((i) => i.photos.length > 0).length,
    };
    expect(totals.total).toBe(0);
    expect(totals.withPhotos).toBe(0);
    expect(savedInspections).toEqual([]);

    // Same aggregation helper as the populated-dashboard test below: an
    // empty model list honestly yields zeros (no fabricated cards).
    const empty = aggregateDashboard([]);
    expect(empty).toEqual({ total: 0, suspected: 0, noIssue: 0, draft: 0 });
    expect(computeHeadline([])).toBe("insufficient evidence");
  });

  it("PDF export bytes carry the reviewed value, citation, and draft stamp", () => {
    const result = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);
    // Unique ASCII corrected value (no parentheses: jsPDF escapes "(" / ")"
    // as "\(" / "\)" in content streams, so paren-free text asserts cleanly).
    const corrected = "Rs 99 XQZ-789-CORRECTED";

    const confirmedModel = buildReportModel(
      confirmedInspection(),
      result.observations,
      {
        productName: "Acme Biscuits",
        brand: "Acme",
        category: "household",
        importStatus: "domestic",
        coverageConfirmed: true,
        reviewedValues: { mrp: corrected },
        findingDecisions: { mrp: "accepted" },
        confirmedAt: "2026-09-18T01:00:00.000Z",
      },
    );
    expect(confirmedModel.isDraft).toBe(false);

    const draftModel = buildReportModel(draftInspection(), result.observations, {
      productName: "Acme Biscuits",
      brand: "Acme",
      category: "household",
      importStatus: "domestic",
      coverageConfirmed: true,
      reviewedValues: { mrp: corrected },
      findingDecisions: {},
      confirmedAt: null,
    });
    expect(draftModel.isDraft).toBe(true);

    // jsPDF is constructed uncompressed by default (compress:false), so
    // reviewed text stays searchable in the raw bytes — no src change needed.
    const confirmedBytes = Buffer.from(
      confirmedModel && exportPdf(confirmedModel).output("arraybuffer") as ArrayBuffer,
    );
    expect(confirmedBytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(confirmedBytes.includes(corrected)).toBe(true);
    const confirmedText = confirmedBytes.toString("latin1");
    // jsPDF escapes citation parentheses, so strip backslashes before the
    // exact-citation assertion (documents the encoding, not a silent pass).
    expect(confirmedText).toContain("Rule 6");
    expect(confirmedText.replace(/\\/g, "")).toContain("Rule 6(1)(e)");
    expect(confirmedText).not.toContain("DRAFT");

    const draftBytes = Buffer.from(
      exportPdf(draftModel).output("arraybuffer") as ArrayBuffer,
    );
    expect(draftBytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(draftBytes.includes(corrected)).toBe(true);
    expect(draftBytes.toString("latin1")).toContain("DRAFT");
  });

  it("DOCX export bytes unzip to document.xml with the reviewed value + citation", async () => {
    const result = parseExtractionResponse(controlledEnvelope(), PHOTO_IDS);
    const corrected = "Rs 99 XQZ-789-CORRECTED";
    const confirmedModel = buildReportModel(
      confirmedInspection(),
      result.observations,
      {
        productName: "Acme Biscuits",
        brand: "Acme",
        category: "household",
        importStatus: "domestic",
        coverageConfirmed: true,
        reviewedValues: { mrp: corrected },
        findingDecisions: { mrp: "accepted" },
        confirmedAt: "2026-09-18T01:00:00.000Z",
      },
    );

    const blob = await exportDocx(confirmedModel);
    const zip = Buffer.from(await blob.arrayBuffer());
    // ZIP magic + non-trivial size: a real OOXML package, not an empty shell.
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(zip.length).toBeGreaterThan(2048);

    const xml = extractDocxDocumentXml(zip);
    expect(xml).toContain(corrected);
    expect(xml).toContain("Rule 6(1)(e)");
    // Model-level proof the bytes came from reviewed (not original) values.
    expect(
      confirmedModel.declarations.find((d) => d.field === "mrp")?.reviewedValue,
    ).toBe(corrected);
    expect(
      confirmedModel.findings.find((f) => f.ruleId === "mrp")?.legalCitation,
    ).toBe("Rule 6(1)(e)");
  });

  it("populated dashboard aggregates one suspected, one no-issue, one draft via headline helpers", () => {
    // Pure libs only: buildReportModel + evaluateRules/computeHeadline +
    // headline helpers. No IndexedDB / localStorage touched here.
    function obs(
      obsId: string,
      field: ObservedDeclaration["field"],
      value: string | null,
    ): ObservedDeclaration {
      return {
        obsId,
        field,
        value,
        photoId: "p-front",
        confidence: "ok",
        rawModelText: value ?? "",
      };
    }
    const present: ObservedDeclaration[] = [
      obs("o-mfr", "manufacturer", "Acme Foods Ltd, 12 Market Road, Mumbai"),
      obs("o-qty", "netQuantity", "500 g"),
      obs("o-mrp", "mrp", "Rs 95"),
      obs("o-date", "dateDeclaration", "MFD 01/2025"),
      obs("o-care", "consumerCare", "care@acme.example, 1800-123-456"),
    ];

    const suspected = buildReportModel(
      { ...confirmedInspection(), inspectionId: "insp-pop-1" },
      [...present.filter((o) => o.field !== "mrp")],
      {
        productName: "Suspected Pack",
        brand: "Acme",
        category: "household",
        importStatus: "domestic",
        coverageConfirmed: true,
        reviewedValues: { mrp: null },
        findingDecisions: {},
        confirmedAt: "2026-09-18T01:00:00.000Z",
      },
    );
    const noIssue = buildReportModel(
      { ...confirmedInspection(), inspectionId: "insp-pop-2" },
      present,
      {
        productName: "Clean Pack",
        brand: "Acme",
        category: "household",
        importStatus: "domestic",
        coverageConfirmed: true,
        reviewedValues: {},
        findingDecisions: {},
        confirmedAt: "2026-09-18T02:00:00.000Z",
      },
    );
    const draft = buildReportModel(
      { ...draftInspection(), inspectionId: "insp-pop-3" },
      [],
      {
        productName: "Draft Pack",
        brand: "Acme",
        category: "",
        importStatus: "unknown",
        coverageConfirmed: false,
        reviewedValues: {},
        findingDecisions: {},
        confirmedAt: null,
      },
    );

    expect(suspected.headline).toBe("suspected violation");
    expect(suspected.isDraft).toBe(false);
    expect(noIssue.headline).toBe("no issue found in assessed checks");
    expect(noIssue.isDraft).toBe(false);
    expect(draft.isDraft).toBe(true);

    // Same tolerant helpers the dashboard/repository pages import: the
    // combined honest results behind each model must resolve to its headline.
    for (const model of [suspected, noIssue, draft]) {
      const honestResults = [
        ...model.findings.map((f) => ({ result: f.result })),
        ...model.notAssessed.map(() => ({ result: "not_assessed" as const })),
      ];
      expect(headlineFromResults(honestResults)).toBe(model.headline);
      expect(normalizeHeadline(model.headline)).toBe(model.headline);
    }
    // Independent pure-engine cross-check for the suspected case.
    const suspectedInputs = present
      .filter((o) => o.field !== "mrp")
      .map((o) => ({
        field: o.field === "netQuantity" ? "net_quantity" as const : (o.field as "manufacturer" | "mrp" | "manufacture_date" | "consumer_care"),
        value: o.value,
        photoId: o.photoId,
        needsReview: false,
      }));
    expect(
      computeHeadline(
        evaluateRules(
          [...suspectedInputs, { field: "mrp" as const, value: null, needsReview: false }],
          {
            category: "household",
            importStatus: "domestic",
            coverageConfirmed: true,
            photoCount: 1,
          },
        ),
      ),
    ).toBe("suspected violation");

    expect(aggregateDashboard([suspected, noIssue, draft])).toEqual({
      total: 3,
      suspected: 1,
      noIssue: 1,
      draft: 1,
    });
  });
});
