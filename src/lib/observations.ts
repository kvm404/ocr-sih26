/**
 * Evidence-linked declaration extraction boundary (GitHub issue #5).
 *
 * The vision model (Qwen3-VL-4B via `analyzePhotos`) PROPOSES observations;
 * it never decides legal compliance. This module:
 * - builds the strict JSON instruction prompt (`buildExtractionPrompt`),
 * - validates the raw server response into `ExtractionResult`
 *   (`parseExtractionResponse`),
 * - resolves manual-vs-model category precedence (`resolveCategory`).
 *
 * Honesty contract (PRD user stories 12-14, 16-20):
 * - Every observation keeps its source `photoId` and `rawModelText`.
 * - An uncertain value or location stays `null` / `region: undefined`
 *   (needs review) — never a fabricated value or highlight.
 * - An observation citing an unknown `photoId` is kept but downgraded to
 *   `uncertain` with a `null` value, since its evidence cannot be verified.
 * - Out-of-range `region` numbers are dropped (`region: undefined`).
 * - Category / import indications are suggestions for reviewer confirmation,
 *   not facts. Manual category precedence is applied by the caller via
 *   `resolveCategory`.
 * - Invalid model output yields an "unknown" result (empty observations,
 *   `categoryUncertain: true`, `importSuggestion: "unknown"`), never a
 *   silent success and never sample data. No legal verdicts here — the
 *   rules agent owns those. No Tesseract, no network, no DOM.
 *
 * Field taxonomy: the rules engine's `ObservedField`
 * (`manufacturer | net_quantity | mrp | manufacture_date | consumer_care`)
 * is canonical. This module's `ObservationField` keeps the model-facing
 * camelCase spellings and maps each one via the exported `FIELD_MAP`;
 * `toObservedInputs()` adapts validated declarations to the rules-facing
 * `ObservedInput[]`. `productName`, `origin` and `importStatus` are NOT
 * observation fields: the generic name (Rule 6(1)(b)) and country of
 * origin (Rule 6(1)(aa)) have no supported check in the 5-check demo
 * catalog, and import status is reviewer-confirmed `ReviewContext`
 * (never inferred from a photo alone) — that information travels via
 * `categorySuggestion` / `importSuggestion` for reviewer confirmation.
 */

import type { ObservedField, ObservedInput, QualityFlag, QualityIssue } from './types';

/** Broad retail categories offered in the UI. A manual choice wins. */
export const CATEGORIES = [
  "Auto-detect",
  "Food and beverages",
  "Personal care",
  "Household products",
  "Other",
] as const;

/** One of the `CATEGORIES` labels. */
export type CategoryHint = (typeof CATEGORIES)[number];

/**
 * Supported declaration groups the model may report as observations.
 * Exactly the five rule-backed groups — every member maps through
 * `FIELD_MAP` to the canonical `ObservedField`. `productName`, `origin`
 * and `importStatus` are intentionally absent (suggestion-only inputs,
 * see module header): they are never emitted as declaration observations.
 */
export type ObservationField =
  | "manufacturer"
  | "netQuantity"
  | "mrp"
  | "dateDeclaration"
  | "consumerCare";

/**
 * Canonical rules-field for each supported observation field.
 * Every `ObservationField` maps; suggestion-only inputs
 * (`productName` / `origin` / `importStatus`) have no entry because they
 * never feed the rules engine.
 */
export const FIELD_MAP: Record<ObservationField, ObservedField> = {
  manufacturer: "manufacturer",
  netQuantity: "net_quantity",
  mrp: "mrp",
  dateDeclaration: "manufacture_date",
  consumerCare: "consumer_care",
};

/**
 * Adapt validated model observations to the rules-facing inputs.
 * `needsReview` is true for anything but a confident (`ok`) reading, so
 * uncertain or unreadable views stay `not_assessed` downstream instead of
 * becoming verdicts. The source `photoId` is preserved as evidence.
 */
export function toObservedInputs(
  observations: ObservedDeclaration[],
): ObservedInput[] {
  const list = Array.isArray(observations) ? observations : [];
  return list.map((observation) => ({
    field: FIELD_MAP[observation.field],
    value: observation.value,
    photoId: observation.photoId,
    needsReview: observation.confidence !== "ok",
  }));
}

/** Model confidence in one observation. Anything but `ok` needs review. */
export type ObservationConfidence = "ok" | "uncertain" | "unreadable";

/** Normalized image region, 0-1 relative coordinates. */
export interface ObservationRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One model-proposed declaration tied to a source photograph. */
export interface ObservedDeclaration {
  obsId: string;
  field: ObservationField;
  /** Transcribed value, or `null` when uncertain/unreadable/unlinked. */
  value: string | null;
  /** Source photograph id (must match an id from the inspection). */
  photoId: string;
  /** Credible location only; absent when the model is unsure. */
  region?: ObservationRegion;
  confidence: ObservationConfidence;
  /** Verbatim model text for this observation (kept beside corrections). */
  rawModelText: string;
}

/**
 * Which package face a photograph shows. A hint for where declarations
 * usually live — never a legal finding. `unknown` when the model cannot tell.
 */
export type PackageFace = "front" | "back" | "side" | "unknown";

/** Model-proposed face for one photograph in the inspection. */
export interface PhotoFace {
  photoId: string;
  face: PackageFace;
  note: string;
}

/**
 * Package identity assembled from the photographs. Brand and product name
 * are not rule-backed declarations; they label the inspection. `samePackage`
 * is null when there is only one photo or identity text is too thin to compare.
 */
export interface PackageIdentity {
  brand: string | null;
  productName: string | null;
  samePackage: boolean | null;
  mismatchNote: string | null;
}

/** Validated extraction outcome: suggestions + evidence, no verdicts. */
export interface ExtractionResult {
  observations: ObservedDeclaration[];
  categorySuggestion: string | null;
  categoryUncertain: boolean;
  importSuggestion: "imported" | "domestic" | "unknown";
  qualityFlags: QualityFlag[];
  /**
   * Valid photoIds that appear in NEITHER observations NOR qualityFlags
   * NOR a recognized face/identity — the model silently ignored them.
   * Callers must surface these and must never treat their silence as
   * absence of declarations.
   */
  unattestedPhotoIds: string[];
  identity: PackageIdentity;
  photoFaces: PhotoFace[];
}

// ---------------------------------------------------------------------------
// Prompt builder.
// ---------------------------------------------------------------------------

/**
 * Strict JSON instruction string for Qwen3-VL-4B. The caller sends the real
 * photographs (with their ids) alongside this text via `analyzePhotos`.
 */
function categoryHintLine(categoryHint?: CategoryHint): string {
  return categoryHint && categoryHint.trim() && categoryHint.trim().toLowerCase() !== "auto-detect"
    ? `The operator pre-selected the broad category "${categoryHint.trim()}" — treat it as a hint, not ground truth.`
    : "No category was pre-selected — suggest the most likely broad retail category, or null when uncertain.";
}

/**
 * Per-photograph JSON instruction. Qwen3-VL-4B attends unreliably when several
 * images share one request, so the scan flow sends this prompt with exactly
 * one image and merges the results in `package-analysis.ts`.
 */
export function buildPhotoExtractionPrompt(
  photoId: string,
  index: number,
  total: number,
  categoryHint?: CategoryHint,
): string {
  const id = photoId.trim() || "photo";
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 1;
  const n = Number.isFinite(total) && total > 0 ? Math.floor(total) : 1;
  return [
    "You are reading ONE photograph of a physical retail package for Legal Metrology (Packaged Commodities) declaration text.",
    `This image's photoId is "${id}". It is photograph ${i} of ${n} in the same inspection. Other sides may exist and are not in this image.`,
    categoryHintLine(categoryHint),
    "Transcribe ONLY text visibly printed in THIS photograph. Never invent a value, a photoId, a region, a brand, or a category.",
    'Classify the face: "front" (principal display — brand, product name, marketing), "back" (information panel — manufacturer/packer/importer, net quantity, MRP, date, consumer care), "side", or "unknown". This is a layout hint, not a legal finding.',
    "Read the brand name and the product/commodity name if they are printed. Put them in brand and productName, not in observations.",
    "Report these declaration groups ONLY when the text is printed on THIS photo: manufacturer (name and address of manufacturer/packer/importer), netQuantity, mrp (maximum retail price), dateDeclaration (month/year wording exactly as printed — do not assume packing vs manufacture vs import), consumerCare (contact details).",
    "If a group is not printed on this face, omit it from observations. A front face without MRP or manufacturer is normal. Do not emit a null observation or an unreadable quality flag just because the field lives on another side.",
    "Do not treat logos, endorsements (e.g. IMA Recommended), batch/serial numbers, barcodes, or marketing claims as manufacturer, netQuantity, MRP, date, or consumerCare. netQuantity must include a unit (ml, g, kg, l). A bare number is not net quantity.",
    "Read small Latin letters carefully (VVF vs VYF, Benckiser vs Benchiser). If both manufacturer/packer and marketed-by blocks are printed, put both name-and-address lines in manufacturer.value.",
    "When text is blurry, cropped, or obstructed, set value to null and confidence to uncertain or unreadable. Never guess characters.",
    "Struck-through, overwritten, or promo-sticker prices: put ONLY the final effective (promo) rupee amount in mrp.value, transcribe the struck-through price and the word Promo in rawModelText, and set confidence to uncertain. Never merge old and new digits into one number.",
    "The Indian rupee sign ₹ is often misread as %. A number sitting where a price should be is rupees, not a percent, unless the word percent/off/discount is printed. Never put % in mrp.value.",
    "If several month/year marks are printed (e.g. 02/26 above 01/28), put the one beside the MRP/batch block in dateDeclaration.value and list every mark in rawModelText. Do not invent which one is manufacture vs expiry.",
    "Never invent symbols the photo does not show. Give a region {x,y,w,h} in normalized 0-1 coordinates ONLY when you can locate the text reliably.",
    `Every observation and qualityFlag must use photoId "${id}". Quality flags are for capture problems on this photo (blur, crop, glare/obstruction), not for declarations that belong on another face.`,
    "Category and import indications are suggestions for a human reviewer, not legal facts.",
    "Reply with JSON ONLY, in exactly this shape:",
    `{"face":"front|back|side|unknown","brand":string|null,"productName":string|null,"observations":[{"field":"manufacturer|netQuantity|mrp|dateDeclaration|consumerCare","value":string|null,"photoId":"${id}","region":{"x":number,"y":number,"w":number,"h":number}|null,"confidence":"ok|uncertain|unreadable","rawModelText":string}],"categorySuggestion":string|null,"categoryUncertain":boolean,"importSuggestion":"imported|domestic|unknown","qualityFlags":[{"photoId":"${id}","issue":"blur|crop|obstruction|unreadable","note":string}]}`,
  ].join("\n");
}

/**
 * Multi-image instruction kept for `analyzePhotos` callers. Prefer
 * `buildPhotoExtractionPrompt` + merge for the live scan — small VL models
 * often attend to only one image in a combined request.
 */
export function buildExtractionPrompt(photoCount: number, categoryHint?: CategoryHint): string {
  const count = Number.isFinite(photoCount) && photoCount > 0 ? Math.floor(photoCount) : 1;
  return [
    "You are inspecting photographs of ONE retail package for Legal Metrology (Packaged Commodities) declaration text.",
    `You will receive ${count} photograph(s) of the same package. Each image is identified by a photoId supplied with it — cite that exact photoId for every observation.`,
    categoryHintLine(categoryHint),
    "Transcribe ONLY text visibly printed in the provided photographs. Never invent a value, a photoId, a region, a brand, or a category.",
    "First identify each photograph as front, back, side, or unknown. Front typically shows brand and product name; back typically shows manufacturer, net quantity, MRP, date, and consumer care. That split is expected, not a conflict.",
    "Read brand and product/commodity name from the photographs (usually the front) into brand and productName. Do not put those in observations.",
    "Consolidate across ALL photographs into ONE package-level answer: examine every photo before judging any field, and emit exactly one observation per declaration group for the whole package, citing the photoId where the text was actually found. Only mark a field unreadable after checking every photograph. If two photos show different values for one field, report the clearest reading in value and describe the conflict in rawModelText with both photoIds.",
    `You received ${count} photograph(s). Every photoId must appear at least once across photoFaces, observations, or qualityFlags — no photograph may be silently ignored. A front face with brand/product and no legal block is still a valid photo; record its face instead of flagging it unreadable.`,
    "Report these supported declaration groups when visible: manufacturer (manufacturer/packer/importer name and address), netQuantity, mrp (maximum retail price), dateDeclaration (the month/year wording exactly as printed — do not assume packing vs manufacture vs import), consumerCare (contact details).",
    "Do NOT report productName, origin, or importStatus as observations.",
    "When text is blurry, cropped, obstructed, or absent from every photograph, set value to null and confidence to uncertain or unreadable. Never guess the characters.",
    "Struck-through, overwritten, or promo-sticker prices are common: when one price is visibly crossed out and another printed beside or over it, put ONLY the final effective (promo) rupee amount in value, transcribe the struck-through price in rawModelText, and set confidence to uncertain. Never merge the old and new digits into one number.",
    "The Indian rupee sign ₹ is often misread as %. A price-area number is rupees, not a percent, unless the word percent/off/discount is printed. An MRP is a plain price — a % character in an mrp value is always a misread.",
    "Read small Latin letters carefully. If manufacturer/packer and marketed-by both appear, include both name-and-address lines in manufacturer.",
    "Give a region {x,y,w,h} in normalized 0-1 coordinates ONLY when you can locate the text reliably; otherwise omit it.",
    "Flag poor photo quality (blur, crop, obstruction, unreadable) per photoId. Do not flag a face as unreadable only because a declaration lives on another face.",
    "Category and import indications are suggestions for a human reviewer, not legal facts.",
    "Reply with JSON ONLY, in exactly this shape:",
    '{"face":"front|back|side|unknown","brand":string|null,"productName":string|null,"photoFaces":[{"photoId":string,"face":"front|back|side|unknown","note":string}],"observations":[{"field":"manufacturer|netQuantity|mrp|dateDeclaration|consumerCare","value":string|null,"photoId":string,"region":{"x":number,"y":number,"w":number,"h":number}|null,"confidence":"ok|uncertain|unreadable","rawModelText":string}],"categorySuggestion":string|null,"categoryUncertain":boolean,"importSuggestion":"imported|domestic|unknown","qualityFlags":[{"photoId":string,"issue":"blur|crop|obstruction|unreadable","note":string}]}',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Category helpers.
// ---------------------------------------------------------------------------

function normalizeLabel(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Canonical `CATEGORIES` entry for a label, or `null` when unrecognized. */
function matchKnownCategory(name: string): CategoryHint | null {
  const n = normalizeLabel(name);
  for (const c of CATEGORIES) {
    if (normalizeLabel(c) === n) return c;
  }
  const aliases: Record<string, CategoryHint> = {
    auto: "Auto-detect",
    autodetect: "Auto-detect",
    food: "Food and beverages",
    "food beverages": "Food and beverages",
    "food & beverages": "Food and beverages",
    personalcare: "Personal care",
    household: "Household products",
  };
  return aliases[n] ?? null;
}

/**
 * Manual category wins over the model suggestion (PRD stories 4-7).
 * An uncertain or missing suggestion resolves to `unknown` for review.
 */
export function resolveCategory(
  manual: string,
  suggestion: string | null,
  uncertain: boolean,
): { category: string; source: "manual" | "model" | "unknown" } {
  const m = (manual ?? "").trim();
  if (m.length > 0 && !/^(auto[\s-]?detect|auto|unknown|none|n\/a)$/i.test(m)) {
    return { category: matchKnownCategory(m) ?? m, source: "manual" };
  }
  if (!uncertain && typeof suggestion === "string" && suggestion.trim().length > 0) {
    const canonical = matchKnownCategory(suggestion);
    if (canonical && canonical !== "Auto-detect") {
      return { category: canonical, source: "model" };
    }
  }
  return { category: "unknown", source: "unknown" };
}

// ---------------------------------------------------------------------------
// Response parsing / validation.
// ---------------------------------------------------------------------------

/**
 * Single table-driven normalizer behind every tolerant model-string
 * parse below. Keys are canonical tokens (lowercase, no separators);
 * every normalizer is one alias table plus its fallback.
 */
function canonicalToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function lookupAlias<T extends string>(
  value: unknown,
  table: Readonly<Record<string, T>>,
): T | null {
  if (typeof value !== "string") return null;
  return table[canonicalToken(value)] ?? null;
}

/** Tolerant alias map: model spelling variants -> canonical field. */
const FIELD_ALIASES: Readonly<Record<string, ObservationField>> = {
  manufacturer: "manufacturer",
  manufacturerblock: "manufacturer",
  maker: "manufacturer",
  packer: "manufacturer",
  importer: "manufacturer",
  address: "manufacturer",
  netquantity: "netQuantity",
  netqty: "netQuantity",
  netweight: "netQuantity",
  quantity: "netQuantity",
  mrp: "mrp",
  price: "mrp",
  maxretailprice: "mrp",
  retailprice: "mrp",
  datedeclaration: "dateDeclaration",
  mfgdate: "dateDeclaration",
  mfg: "dateDeclaration",
  manufacturedate: "dateDeclaration",
  packedon: "dateDeclaration",
  datemark: "dateDeclaration",
  monthyear: "dateDeclaration",
  consumercare: "consumerCare",
  consumercareblock: "consumerCare",
  customercare: "consumerCare",
  helpline: "consumerCare",
  contact: "consumerCare",
};

const CONFIDENCE_ALIASES: Readonly<Record<string, ObservationConfidence>> = {
  ok: "ok",
  confident: "ok",
  readable: "ok",
  high: "ok",
  clear: "ok",
  unreadable: "unreadable",
  illegible: "unreadable",
  missing: "unreadable",
  notvisible: "unreadable",
  hidden: "unreadable",
  absent: "unreadable",
};

function normalizeField(value: unknown): ObservationField | null {
  return lookupAlias(value, FIELD_ALIASES);
}

function normalizeConfidence(value: unknown): ObservationConfidence {
  return lookupAlias(value, CONFIDENCE_ALIASES) ?? "uncertain";
}

const REGION_EPS = 1e-6;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Keep a region only when all numbers are in normalized 0-1 range with
 * positive size and the box stays inside the image. Otherwise `undefined`
 * (no fabricated highlight).
 */
function normalizeRegion(value: unknown): ObservationRegion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const { x, y, w, h } = rec;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) {
    return undefined;
  }
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  if (w <= 0 || w > 1 || h <= 0 || h > 1) return undefined;
  if (x + w > 1 + REGION_EPS || y + h > 1 + REGION_EPS) return undefined;
  return { x, y, w, h };
}

/**
 * Unified quality vocabulary (`QualityIssue` in `types.ts`). There is no
 * `glare` literal: glare and reflections obstruct the view, so that family
 * maps to `obstruction` with the detail preserved in the flag's `note`.
 */
const QUALITY_ALIASES: Readonly<Record<string, QualityIssue>> = {
  blur: "blur",
  blurry: "blur",
  blurred: "blur",
  outoffocus: "blur",
  crop: "crop",
  cropped: "crop",
  cutoff: "crop",
  cut: "crop",
  partial: "crop",
  obstruction: "obstruction",
  obstructed: "obstruction",
  occluded: "obstruction",
  covered: "obstruction",
  blocked: "obstruction",
  glare: "obstruction",
  reflection: "obstruction",
  glossy: "obstruction",
  washout: "obstruction",
  unreadable: "unreadable",
  illegible: "unreadable",
  toosmall: "unreadable",
  small: "unreadable",
  poor: "unreadable",
  dark: "unreadable",
};

function normalizeQualityIssue(value: unknown): QualityIssue | null {
  return lookupAlias(value, QUALITY_ALIASES);
}

const FACE_ALIASES: Readonly<Record<string, PackageFace>> = {
  front: "front",
  principal: "front",
  principaldisplay: "front",
  facefront: "front",
  label: "front",
  back: "back",
  rear: "back",
  reverse: "back",
  informationpanel: "back",
  infopanel: "back",
  side: "side",
  left: "side",
  right: "side",
  unknown: "unknown",
};

function normalizeFace(value: unknown): PackageFace {
  return lookupAlias(value, FACE_ALIASES) ?? "unknown";
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^(unknown|null|n\/a|na|none|unsure)$/i.test(trimmed)) return null;
  return trimmed;
}

function parsePhotoFace(item: unknown, validPhotoIds: Set<string>): PhotoFace | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const photoId = typeof rec["photoId"] === "string" ? rec["photoId"] : "";
  if (!validPhotoIds.has(photoId)) return null;
  const face = normalizeFace(rec["face"] ?? rec["side"] ?? rec["view"]);
  const note = typeof rec["note"] === "string" ? rec["note"] : "";
  return { photoId, face, note };
}

/** Exact spellings that mean "no import indication" (all -> `unknown`). */
const IMPORT_UNKNOWN_ALIASES: Readonly<Record<string, "unknown">> = {
  unknown: "unknown",
  null: "unknown",
  na: "unknown",
  none: "unknown",
  unsure: "unknown",
};

function parseImportSuggestion(value: unknown): ExtractionResult["importSuggestion"] {
  if (typeof value === "boolean") return value ? "imported" : "domestic";
  if (typeof value !== "string") return "unknown";
  const v = value.trim().toLowerCase();
  if (!v || lookupAlias(value, IMPORT_UNKNOWN_ALIASES) !== null) return "unknown";
  if (/domestic|not\s*import|non[\s-]*import|\blocal\b|\bmade\s*in\s*india\b/.test(v)) return "domestic";
  if (/import/.test(v)) return "imported";
  return "unknown";
}

/**
 * Promo stickers often print a struck-through MRP and a new rupee amount.
 * Qwen3-VL commonly reads the rupee sign as `%` and concatenates both
 * amounts (`₹ 50 35%`). Recover the effective rupee amount; never invent
 * digits that were not in the transcription.
 */
export function repairMrpTranscription(raw: string): {
  value: string;
  repaired: boolean;
  note: string;
} {
  const text = raw.trim();
  if (!text) return { value: text, repaired: false, note: "" };

  const two = text.match(
    /^(.*?)(\d{1,5}(?:[.,]\d{1,2})?)\s+(\d{1,5}(?:[.,]\d{1,2})?)\s*%\s*$/i,
  );
  if (two) {
    const prefix = two[1].replace(/\d[\s\S]*$/, "").trimEnd();
    const currency = /₹|rs\.?|inr/i.test(prefix) ? prefix : prefix ? `${prefix} ₹` : "₹";
    const promo = two[3];
    return {
      value: `${currency.trim()} ${promo}`.replace(/\s+/g, " ").trim(),
      repaired: true,
      note: `Rupee sign likely misread as %; struck/old ${two[2]} and promo ${promo}. Using the promo amount.`,
    };
  }

  const one = text.match(/^(.*?)(\d{1,5}(?:[.,]\d{1,2})?)\s*%\s*$/i);
  if (one && !/percent|off|discount/i.test(text)) {
    const prefix = one[1].replace(/\d[\s\S]*$/, "").trimEnd();
    const currency = /₹|rs\.?|inr/i.test(prefix) ? prefix : prefix ? `${prefix} ₹` : "₹";
    return {
      value: `${currency.trim()} ${one[2]}`.replace(/\s+/g, " ").trim(),
      repaired: true,
      note: "Trailing % treated as a misread rupee sign.",
    };
  }

  return { value: text, repaired: false, note: "" };
}

function parseObservation(
  item: unknown,
  obsId: string,
  validPhotoIds: Set<string>,
): ObservedDeclaration | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const field = normalizeField(rec["field"]);
  if (!field) return null; // Unsupported group — ignore rather than invent.

  const rawPhotoId =
    typeof rec["photoId"] === "string"
      ? rec["photoId"]
      : typeof rec["photo_id"] === "string"
        ? rec["photo_id"]
        : "";
  const photoLinked = validPhotoIds.has(rawPhotoId);

  let confidence = normalizeConfidence(rec["confidence"] ?? rec["certainty"]);
  const rawValue = typeof rec["value"] === "string" ? rec["value"].trim() : "";
  let rawModelText =
    typeof rec["rawModelText"] === "string"
      ? rec["rawModelText"]
      : typeof rec["text"] === "string"
        ? rec["text"]
        : typeof rec["value"] === "string"
          ? rec["value"]
          : "";

  let value: string | null = rawValue.length > 0 ? rawValue : null;

  if (field === "mrp" && value) {
    const repaired = repairMrpTranscription(value);
    if (repaired.repaired) {
      value = repaired.value;
      if (confidence === "ok") confidence = "uncertain";
      if (repaired.note && !rawModelText.includes(repaired.note)) {
        rawModelText = [rawModelText, repaired.note].filter((part) => part.length > 0).join(" | ");
      }
    } else if (value.includes("%")) {
      if (confidence === "ok") confidence = "uncertain";
    }
  }

  // Uncertain/unreadable stays null — except a repaired MRP amount, which is
  // still a transcription of digits the model already produced.
  const keepUncertainMrp =
    field === "mrp" && value !== null && !value.includes("%") && confidence === "uncertain";
  if (confidence !== "ok" && !keepUncertainMrp) value = null;
  if (value === null && confidence === "ok") confidence = "uncertain";
  if (!photoLinked) {
    // Evidence cannot be verified — needs review, value withheld.
    if (confidence === "ok") confidence = "uncertain";
    value = null;
  }

  // Highlight only for credible, verifiable readings.
  const region = confidence === "ok" && value !== null ? normalizeRegion(rec["region"]) : undefined;

  return { obsId, field, value, photoId: rawPhotoId, region, confidence, rawModelText };
}

function parseQualityFlag(item: unknown, validPhotoIds: Set<string>): QualityFlag | null {
  if (!item || typeof item !== "object") return null; // Free-text notes can't be attributed — skip.
  const rec = item as Record<string, unknown>;
  const photoId = typeof rec["photoId"] === "string" ? rec["photoId"] : "";
  if (!validPhotoIds.has(photoId)) return null; // Never attach a flag to an unknown photo.
  const issue = normalizeQualityIssue(rec["issue"] ?? rec["kind"] ?? rec["type"]);
  if (!issue) return null;
  const note = typeof rec["note"] === "string" ? rec["note"] : "";
  return { photoId, issue, note };
}

/** Strip ```json fences and parse; fall back to the largest {...} span. */
function parseJsonLenient(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Unwrap `analyzePhotos` output: a chat/completions envelope whose message
 * content holds the extraction JSON, a bare JSON string, or the extraction
 * object itself.
 */
function extractPayload(raw: unknown): Record<string, unknown> | null {
  let candidate: unknown = raw;
  if (typeof candidate === "string") {
    candidate = parseJsonLenient(candidate);
  }
  if (candidate && typeof candidate === "object" && "choices" in candidate) {
    const choices = (candidate as { choices?: unknown }).choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message =
      first && typeof first === "object" && "message" in first
        ? (first as { message?: unknown }).message
        : undefined;
    const content =
      message && typeof message === "object" && "content" in message
        ? (message as { content?: unknown }).content
        : undefined;
    if (typeof content === "string") {
      candidate = parseJsonLenient(content);
    } else if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("\n");
      candidate = parseJsonLenient(text);
    } else if (content && typeof content === "object") {
      candidate = content;
    } else {
      return null;
    }
  }
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  return null;
}

/**
 * True when raw model output contains parseable extraction JSON.
 * Empty or non-JSON completion content is not a successful empty reading.
 */
export function hasExtractionPayload(raw: unknown): boolean {
  return extractPayload(raw) !== null;
}

export function emptyIdentity(): PackageIdentity {
  return { brand: null, productName: null, samePackage: null, mismatchNote: null };
}

function emptyResult(validPhotoIds?: string[]): ExtractionResult {
  return {
    observations: [],
    categorySuggestion: null,
    categoryUncertain: true,
    importSuggestion: "unknown",
    qualityFlags: [],
    // Unparseable output attests nothing — every photo is unattested.
    unattestedPhotoIds: (validPhotoIds ?? []).filter((id) => typeof id === "string"),
    identity: emptyIdentity(),
    photoFaces: [],
  };
}

/**
 * Validate raw model output against the inspection's real photo ids.
 * Never throws on shape errors — invalid output becomes an "unknown"
 * result (needs review / caller surfaces an error), never a silent pass.
 */
export function parseExtractionResponse(
  raw: unknown,
  validPhotoIds: string[],
): ExtractionResult {
  const validSet = new Set(validPhotoIds.filter((id) => typeof id === "string"));
  const result = emptyResult([...validSet]);
  const payload = extractPayload(raw);
  if (!payload) return result;

  const rawObs = payload["observations"];
  if (Array.isArray(rawObs)) {
    for (const item of rawObs) {
      const parsed = parseObservation(item, `obs-${result.observations.length + 1}`, validSet);
      if (parsed) result.observations.push(parsed);
    }
  }

  const rawCat = payload["categorySuggestion"] ?? payload["category"];
  if (typeof rawCat === "string") {
    const trimmed = rawCat.trim();
    if (trimmed.length > 0 && !/^(unknown|null|n\/a|na|none|unsure)$/i.test(trimmed)) {
      const canonical = matchKnownCategory(trimmed);
      // Unrecognized labels stay unknown rather than becoming invented categories.
      result.categorySuggestion =
        canonical && canonical !== "Auto-detect" ? canonical : null;
    }
  }
  const rawUncertain =
    payload["categoryUncertain"] ?? payload["category_unknown"] ?? payload["uncertain"];
  result.categoryUncertain =
    typeof rawUncertain === "boolean" ? rawUncertain : result.categorySuggestion === null;
  if (result.categorySuggestion === null) result.categoryUncertain = true;

  result.importSuggestion = parseImportSuggestion(
    payload["importSuggestion"] ?? payload["importStatus"] ?? payload["import"],
  );

  const rawFlags = payload["qualityFlags"] ?? payload["quality"] ?? payload["qualityNotes"];
  if (Array.isArray(rawFlags)) {
    for (const item of rawFlags) {
      const flag = parseQualityFlag(item, validSet);
      if (flag) result.qualityFlags.push(flag);
    }
  }

  const facesByPhoto = new Map<string, PhotoFace>();
  const rawFaces = payload["photoFaces"] ?? payload["faces"];
  if (Array.isArray(rawFaces)) {
    for (const item of rawFaces) {
      const face = parsePhotoFace(item, validSet);
      if (face) facesByPhoto.set(face.photoId, face);
    }
  }
  // Single-photo payloads put face/brand at the top level.
  if (validSet.size === 1) {
    const onlyId = [...validSet][0];
    const topFace = payload["face"] ?? payload["packageFace"];
    if (topFace !== undefined && !facesByPhoto.has(onlyId)) {
      facesByPhoto.set(onlyId, {
        photoId: onlyId,
        face: normalizeFace(topFace),
        note: typeof payload["faceNote"] === "string" ? payload["faceNote"] : "",
      });
    }
  } else if (payload["face"] !== undefined && validSet.size > 1) {
    // Multi-image replies sometimes label only the first photo; keep it if
    // that photoId is explicit, otherwise ignore the bare face.
    const tagged =
      typeof payload["facePhotoId"] === "string" ? payload["facePhotoId"] : "";
    if (validSet.has(tagged) && !facesByPhoto.has(tagged)) {
      facesByPhoto.set(tagged, {
        photoId: tagged,
        face: normalizeFace(payload["face"]),
        note: "",
      });
    }
  }
  result.photoFaces = [...facesByPhoto.values()];

  const brand = normalizeName(payload["brand"] ?? payload["brandName"]);
  const productName = normalizeName(
    payload["productName"] ?? payload["product"] ?? payload["commodityName"],
  );
  result.identity = {
    brand,
    productName,
    samePackage: validSet.size <= 1 ? null : null,
    mismatchNote: null,
  };

  // Pooling check: every submitted photo must be attested somewhere. A
  // recognized face or identity string counts — a front with only a brand
  // is not "ignored". Silence must never read as absence of declarations.
  const attested = new Set<string>();
  for (const observation of result.observations) attested.add(observation.photoId);
  for (const flag of result.qualityFlags) attested.add(flag.photoId);
  for (const face of result.photoFaces) {
    if (face.face !== "unknown") attested.add(face.photoId);
  }
  if (brand !== null || productName !== null) {
    if (validSet.size === 1) attested.add([...validSet][0]);
  }
  result.unattestedPhotoIds = [...validSet].filter((id) => !attested.has(id));

  return result;
}
