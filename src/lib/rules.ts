/**
 * Cited rules engine for NyayaPack (GitHub issue #6: "Apply cited rules
 * with honest not-assessed results").
 *
 * - `RULE_CATALOG`: the 5 supported checks from `docs/legal-rule-sources.md`,
 *   each with exact legal citation, gazette number, effective date, source
 *   URL, applicability conditions, exceptions and expected declaration.
 * - `evaluateRules(observations, ctx)`: honest evaluation over structured
 *   observations plus reviewer context. A declaration is a suspected
 *   violation ONLY when the rule applies, the relevant view is readable and
 *   the reviewer confirmed photo coverage. Everything else without enough
 *   evidence or rule support is `not_assessed` — never a pass or a failure.
 * - `computeHeadline(results)`: the ONLY overall wording. A numeric score
 *   survives ONLY as `computeInternalScore` for internal testing and never
 *   decides the headline or any legal wording.
 *
 * Deleted per the ticket (do NOT reintroduce): Rule 6(1)(d)(v), Rule
 * 6(1)(f/g/h), Table-I font simulation, unit-price / batch / dimensions
 * checks, the generic-name regex list, origin-as-warning, and the
 * weighted-score model. Font measurement is owned by the readability agent
 * (issue #8); extraction patterns are owned by the observations agent
 * (issue #5). All functions are pure, dependency-free and fully typed
 * (no `any`).
 */

import type {
  CheckStatus,
  ComplianceCheck,
  FontAnalysis,
  ObservedField,
  ObservedInput,
  OverallStatus,
  ProductReport,
  ReportHeadline,
  ReviewContext,
  RuleCatalogEntry,
  RuleResult,
} from './types';

/* ------------------------------------------------------------------ */
/* Source URLs (docs/legal-rule-sources.md)                            */
/* ------------------------------------------------------------------ */

const COMPILED_RULES_URL =
  'https://consumeraffairs.nic.in/sites/default/files/file-uploads/latestnews/LM_PCR_All_Amendements.pdf';
const GSR_629_URL =
  'https://consumeraffairs.nic.in/sites/default/files/uploads/legal-metrology-acts-rules/8%28xii%29_0.pdf';
const GSR_779_URL = 'https://egazette.gov.in/WriteReadData/2021/230946.pdf';

/* ------------------------------------------------------------------ */
/* RULE_CATALOG: the 5 supported checks                                */
/* ------------------------------------------------------------------ */

export const RULE_CATALOG: readonly RuleCatalogEntry[] = [
  {
    ruleId: 'manufacturer',
    label: 'Manufacturer / packer / importer name and address',
    legalCitation: 'Rule 6(1)(a)',
    gazetteNumber: 'G.S.R. 629(E)',
    effectiveFrom: '2018-01-01',
    sourceUrl: GSR_629_URL,
    appliesWhen:
      'A Chapter II retail package. The importer name-and-address limb applies only when the reviewer confirms importStatus "imported".',
    exceptions:
      'Chapter II exclusions (Rule 3 as substituted: packages above 25 kg or 25 L, specified cement/fertiliser/farm-produce bags above 50 kg, industrial/institutional packs); Rule 26 exemptions (e.g. garments and hosiery sold loose or open); medical-device packs follow the Medical Devices Rules, 2017 per G.S.R. 778(E); food articles follow the Food Safety and Standards Act for this clause — flagged for review, never auto-failed.',
    expectedDeclaration:
      'Name and complete address of the manufacturer or packer; importer name and address for an imported package.',
  },
  {
    ruleId: 'net_quantity',
    label: 'Net quantity (declared text only)',
    legalCitation: 'Rule 6(1)(c)',
    gazetteNumber:
      'Legal Metrology (Packaged Commodities) Rules, 2011, compiled text (no later amendment applied to this clause in the demo set)',
    effectiveFrom: '2011-04-01',
    sourceUrl: COMPILED_RULES_URL,
    appliesWhen: 'A Chapter II retail package.',
    exceptions:
      'Chapter II / Rule 26 exclusions (same scope limits as the manufacturer check). A photograph verifies the declared text only and can never establish the actual contents of the package.',
    expectedDeclaration:
      'Net quantity by standard unit of weight or measure, or number, as declared on the package.',
  },
  {
    ruleId: 'mrp',
    label: 'Maximum retail price inclusive of all taxes',
    legalCitation: 'Rule 6(1)(e)',
    gazetteNumber: 'G.S.R. 779(E), commencement deferred to 1 October 2022 by G.S.R. 226(E)',
    effectiveFrom: '2022-10-01',
    sourceUrl: GSR_779_URL,
    appliesWhen: 'A Chapter II retail package.',
    exceptions:
      'Alcoholic beverages and specified essential commodities have special pricing provisions; Chapter II / Rule 26 exclusions; medical-device packs per G.S.R. 778(E).',
    expectedDeclaration:
      'Maximum retail price inclusive of all taxes, in Indian currency.',
  },
  {
    ruleId: 'manufacture_date',
    label: 'Month and year of manufacture (where required)',
    legalCitation: 'Rule 6(1)(d)',
    gazetteNumber: 'G.S.R. 779(E), commencement deferred to 1 October 2022 by G.S.R. 226(E)',
    effectiveFrom: '2022-10-01',
    sourceUrl: GSR_779_URL,
    appliesWhen:
      'A Chapter II retail package whose category has a clear manufacture-date requirement under the current wording. NEVER a universal packing/import-date check: G.S.R. 779(E) removed the words "or pre-packed or imported" from this clause.',
    exceptions:
      'Food, seeds, cosmetics, bidis, incense sticks and specified LPG packages have special provisions. Any unclear or unknown category (including the broad "food-beverages", "personal-care" and "other" hints, which cannot settle those exceptions) is not_assessed, never failed.',
    expectedDeclaration:
      'Month and year of manufacture, where the reviewed rule requires it for the category.',
  },
  {
    ruleId: 'consumer_care',
    label: 'Consumer care contact',
    legalCitation: 'Rule 6(2)',
    gazetteNumber:
      'Legal Metrology (Packaged Commodities) Rules, 2011, compiled text (see also Department FAQ questions 46-47)',
    effectiveFrom: '2011-04-01',
    sourceUrl: COMPILED_RULES_URL,
    appliesWhen: 'A Chapter II retail package.',
    exceptions:
      'Check the rule text and any category law before treating a missing subfield as a violation: a missing subfield (contact name, address, telephone, email) is flagged for review, never an automatic violation. Food MRP, net weight and consumer-care details remain under these rules per FAQ question 46.',
    expectedDeclaration:
      'Consumer-contact name and address, telephone number and email address for complaints (presence check).',
  },
];

/* ------------------------------------------------------------------ */
/* Applicability helpers (pure)                                        */
/* ------------------------------------------------------------------ */

/**
 * Lowercase category tokens that signal the package is outside the demo's
 * Chapter II / Rule 26 scope (industrial/institutional use, bulk packs,
 * loose garments, medical devices). Matching is substring-based and
 * deliberately conservative: a false match only yields not_assessed, never
 * a false violation. Full exemption inputs (pack size, end use) are future
 * ReviewContext fields owned with the review flow (issue #7).
 */
const CHAPTER_II_EXEMPT_TOKENS: readonly string[] = [
  'industrial',
  'institutional',
  'bulk',
  'cement',
  'fertiliser',
  'fertilizer',
  'farm-produce',
  'medical-device',
  'loose',
  'exempt',
];

/**
 * Tokens marking categories with special month-year provisions under
 * Rule 6(1)(d). The broad demo hint "personal-care" is included because it
 * contains cosmetics, whose provision this engine cannot settle.
 */
const DATE_SPECIAL_TOKENS: readonly string[] = [
  'food',
  'seed',
  'cosmet',
  'bidi',
  'incense',
  'lpg',
  'personal-care',
];

/** Category hints too vague to settle the Rule 6(1)(d) exceptions. */
const DATE_UNCLEAR_CATEGORIES: readonly string[] = ['', 'unknown', 'auto', 'other'];

function normalizedCategory(category: string): string {
  return (category ?? '').trim().toLowerCase();
}

function containsToken(normalized: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => token.length > 0 && normalized.includes(token));
}

/** True when the category signals a Chapter II / Rule 26 exclusion. */
function isChapterIIExempt(category: string): boolean {
  return containsToken(normalizedCategory(category), CHAPTER_II_EXEMPT_TOKENS);
}

/**
 * True when the month-year rule cannot be applied: an excepted category, or
 * a hint too vague to settle the food/seeds/cosmetics/bidis/incense/LPG
 * special provisions.
 */
function isDateRuleUnclear(category: string): boolean {
  const normalized = normalizedCategory(category);
  if (DATE_UNCLEAR_CATEGORIES.includes(normalized)) return true;
  return containsToken(normalized, DATE_SPECIAL_TOKENS);
}

function findObservation(
  observations: ObservedInput[],
  field: ObservedField,
): ObservedInput | null {
  let fallback: ObservedInput | null = null;
  for (const observation of observations) {
    if (observation.field !== field) continue;
    if (fallback === null) fallback = observation;
    if (
      observation.value !== null &&
      observation.value.trim().length > 0 &&
      !observation.needsReview
    ) {
      return observation;
    }
  }
  return fallback;
}

function hasReadableText(observation: ObservedInput): boolean {
  return (
    observation.value !== null &&
    observation.value.trim().length > 0 &&
    !observation.needsReview
  );
}

/**
 * Present-declaration message per check. A `Record` keyed by `ruleId`
 * (not a ternary chain) so adding a check is adding an entry. Only the
 * manufacturer entry reads context: the importer limb applies when the
 * reviewer confirmed `importStatus: "imported"`.
 */
const PRESENT_MESSAGES: Record<ObservedField, (ctx: ReviewContext) => string> = {
  manufacturer: (ctx) =>
    ctx.importStatus === 'imported'
      ? 'Manufacturer/packer/importer name and address observed (importer limb checked: import status is confirmed imported).'
      : 'Manufacturer/packer name and address observed.',
  net_quantity: () =>
    'Net quantity declaration text observed. The photograph verifies the declared text only, not the actual contents.',
  mrp: () => 'Maximum retail price declaration observed.',
  manufacture_date: () =>
    'Month and year of manufacture observed where the reviewed rule requires it. No packing/import date was checked.',
  consumer_care: () =>
    'Consumer care contact observed (presence check; any subfield doubt stays with the reviewer).',
};

/* ------------------------------------------------------------------ */
/* evaluateRules                                                       */
/* ------------------------------------------------------------------ */

function notAssessed(
  entry: RuleCatalogEntry,
  message: string,
  evidence: RuleResult['evidence'],
): RuleResult {
  return {
    ruleId: entry.ruleId,
    label: entry.label,
    legalCitation: entry.legalCitation,
    gazetteNumber: entry.gazetteNumber,
    effectiveFrom: entry.effectiveFrom,
    sourceUrl: entry.sourceUrl,
    appliesWhen: entry.appliesWhen,
    result: 'not_assessed',
    evidence,
    message,
    needsReview: true,
  };
}

function evaluateOne(
  entry: RuleCatalogEntry,
  observations: ObservedInput[],
  ctx: ReviewContext,
): RuleResult {
  if (ctx.photoCount <= 0) {
    return notAssessed(entry, 'Not assessed: no photographs were submitted, so nothing could be checked.', null);
  }

  if (isChapterIIExempt(ctx.category)) {
    return notAssessed(
      entry,
      `Not assessed: category "${ctx.category}" signals a Chapter II / Rule 26 exclusion (bulk, industrial/institutional, loose, or separately-regulated pack). Exclusions are never reported as violations.`,
      null,
    );
  }

  if (entry.ruleId === 'manufacture_date' && isDateRuleUnclear(ctx.category)) {
    return notAssessed(
      entry,
      `Not assessed: the month-year rule is unclear for category "${ctx.category || 'unknown'}" (special provisions may apply, or the category is undecided). No universal packing/import-date check was applied.`,
      null,
    );
  }

  const observation = findObservation(observations, entry.ruleId);

  if (observation === null) {
    return notAssessed(
      entry,
      'Not assessed: no assessable evidence for this declaration in the submitted observations.',
      null,
    );
  }

  const observedEvidence: RuleResult['evidence'] =
    observation.value !== null && observation.value.trim().length > 0
      ? {
          value: observation.value,
          ...(observation.photoId !== undefined ? { photoId: observation.photoId } : {}),
        }
      : null;

  if (observation.needsReview) {
    const reason =
      entry.ruleId === 'consumer_care'
        ? 'Not assessed: consumer care contact is partially observed or uncertain — a missing subfield is left for the reviewer, never an automatic violation.'
        : 'Not assessed: poor evidence — the observation needs review (uncertain reading or unreadable view).';
    return notAssessed(entry, reason, observedEvidence);
  }

  if (!ctx.coverageConfirmed) {
    return notAssessed(
      entry,
      'Not assessed: the reviewer has not confirmed that the relevant package sides were photographed, so an unseen declaration cannot be called missing.',
      observedEvidence,
    );
  }

  if (hasReadableText(observation)) {
    const text = (observation.value as string).trim();
    const evidence: RuleResult['evidence'] = {
      value: text,
      ...(observation.photoId !== undefined ? { photoId: observation.photoId } : {}),
    };
    if (entry.ruleId === 'manufacturer' && ctx.importStatus === 'unknown') {
      return notAssessed(
        entry,
        'Not assessed: name and address text observed, but import status is unconfirmed ("unknown") — ' +
          'the importer limb may apply, so neither the domestic nor the imported limb is fully established. Left for the reviewer.',
        evidence,
      );
    }
    return {
      ruleId: entry.ruleId,
      label: entry.label,
      legalCitation: entry.legalCitation,
      gazetteNumber: entry.gazetteNumber,
      effectiveFrom: entry.effectiveFrom,
      sourceUrl: entry.sourceUrl,
      appliesWhen: entry.appliesWhen,
      result: 'no_issue_found',
      evidence,
      message: PRESENT_MESSAGES[entry.ruleId](ctx),
      needsReview: false,
    };
  }

  return {
    ruleId: entry.ruleId,
    label: entry.label,
    legalCitation: entry.legalCitation,
    gazetteNumber: entry.gazetteNumber,
    effectiveFrom: entry.effectiveFrom,
    sourceUrl: entry.sourceUrl,
    appliesWhen: entry.appliesWhen,
    result: 'suspected_violation',
    evidence: null,
    message: `Suspected violation: ${entry.expectedDeclaration} not found in the confirmed readable views. Awaiting reviewer decision.`,
    needsReview: true,
  };
}

/**
 * Evaluate the cited catalog against structured observations and reviewer
 * context. Missing declarations become `suspected_violation` ONLY when the
 * rule applies, the relevant view is readable, and coverage is confirmed;
 * unsupported, inapplicable, poor-evidence and unconfirmed-coverage cases
 * are `not_assessed`.
 */
export function evaluateRules(
  observations: ObservedInput[],
  ctx: ReviewContext,
): RuleResult[] {
  const safeObservations = Array.isArray(observations) ? observations : [];
  return RULE_CATALOG.map((entry) => evaluateOne(entry, safeObservations, ctx));
}

/* ------------------------------------------------------------------ */
/* computeHeadline                                                     */
/* ------------------------------------------------------------------ */

/**
 * The ONLY overall wording. Any suspected violation wins; all-not-assessed
 * (or no results at all) is insufficient evidence; otherwise no issue was
 * found in the checks that could actually be assessed.
 */
export function computeHeadline(results: RuleResult[]): ReportHeadline {
  const list = Array.isArray(results) ? results : [];
  if (list.some((result) => result.result === 'suspected_violation')) {
    return 'suspected violation';
  }
  if (list.length === 0 || list.every((result) => result.result === 'not_assessed')) {
    return 'insufficient evidence';
  }
  return 'no issue found in assessed checks';
}

/**
 * Copy of rule results for headline / dashboard labels. A reviewer who
 * rejects a suspected violation is deciding it is not an issue; the original
 * `RuleResult` is left unchanged for the report (which still records the
 * rejection). Accepted and pending suspected violations still win.
 */
export function resultsForHeadline(
  results: RuleResult[],
  decisions?: Partial<Record<string, 'accepted' | 'rejected'>> | null,
): RuleResult[] {
  const list = Array.isArray(results) ? results : [];
  if (!decisions) return list;
  return list.map((result) => {
    if (result.result !== 'suspected_violation') return result;
    if (decisions[result.ruleId] !== 'rejected') return result;
    return { ...result, result: 'no_issue_found', needsReview: false };
  });
}

/* ------------------------------------------------------------------ */
/* Internal numeric score (internal testing ONLY)                       */
/* ------------------------------------------------------------------ */

/**
 * INTERNAL TESTING ONLY. Share of assessable (non-not_assessed) checks with
 * no issue found, 0-100; 0 when nothing was assessable. This number MUST
 * NEVER decide the headline or any legal wording — `computeHeadline` does
 * not read it. Exported so benchmark tooling (issue #11) can track internal
 * signal without leaking it into reports.
 */
export function computeInternalScore(results: RuleResult[]): number {
  const list = Array.isArray(results) ? results : [];
  const assessable = list.filter((result) => result.result !== 'not_assessed');
  if (assessable.length === 0) return 0;
  const clean = assessable.filter((result) => result.result === 'no_issue_found').length;
  return Math.round((clean / assessable.length) * 100);
}

/* ------------------------------------------------------------------ */
/* Deprecated pre-#6 compatibility adapters (do not extend)             */
/* ------------------------------------------------------------------ */
/**
 * The shims below exist ONLY so pages owned by other agents
 * (scan/report/repository/dashboard, mock-data) keep compiling until they
 * migrate to `evaluateRules`/`computeHeadline`. They contain NONE of the old
 * wrong logic (no 10-check regex engine, no wrong citations, no weighted
 * score, no font simulation): every shim delegates to the honest engine.
 * Raw OCR text without reviewer-confirmed coverage can never establish
 * compliance, so these adapters always yield not_assessed-backed legacy
 * "warning" checks until migrated callers supply real observations.
 */

function catalogEntry(ruleId: ObservedField): RuleCatalogEntry {
  const entry = RULE_CATALOG.find((candidate) => candidate.ruleId === ruleId);
  if (!entry) {
    throw new Error(`Unknown ruleId "${ruleId}": no entry in RULE_CATALOG.`);
  }
  return entry;
}

function toLegacyCheck(result: RuleResult): ComplianceCheck {
  const status: CheckStatus =
    result.result === 'no_issue_found'
      ? 'pass'
      : result.result === 'suspected_violation'
        ? 'fail'
        : 'warning';
  const check: ComplianceCheck = {
    id: result.ruleId,
    label: result.label,
    ruleRef: result.legalCitation,
    status,
    message: result.message,
  };
  if (result.evidence !== null) check.extractedText = result.evidence.value;
  check.expected = catalogEntry(result.ruleId).expectedDeclaration;
  return check;
}

/**
 * @deprecated Stub kept only for pre-migration callers. Extraction patterns
 * are owned by the observations agent (issue #5). Always returns `{}` and
 * never fabricates field text from raw OCR.
 */
export function extractFields(_ocrText: string): Record<string, string> {
  return {};
}

/**
 * @deprecated Compatibility adapter over `evaluateRules`. Raw text carries
 * no photo references and no reviewer coverage confirmation, so every check
 * is honestly `not_assessed` (legacy "warning") until callers migrate to
 * structured observations. `_panelAreaCm2` is ignored: font/size belongs to
 * the readability agent (issue #8).
 */
export function runComplianceChecks(ocrText: string, _panelAreaCm2?: number): ComplianceCheck[] {
  const text: string = ocrText ?? '';
  void _panelAreaCm2;
  const ctx: ReviewContext = {
    category: 'unknown',
    importStatus: 'unknown',
    coverageConfirmed: false,
    photoCount: text.trim().length > 0 ? 1 : 0,
  };
  return evaluateRules([], ctx).map(toLegacyCheck);
}

/**
 * @deprecated Table-I lookup removed with the old font simulation. Font
 * measurement is owned by the readability agent (issue #8). Always returns
 * NaN — callers must treat letter height as not assessed without a
 * known-size reference.
 */
export function minLetterHeightMm(_panelAreaCm2: number): number {
  return NaN;
}

/**
 * @deprecated Simulation removed. Always returns an honest not-assessed
 * placeholder: no millimetre estimate is invented from pixels.
 */
export function computeFontAnalysis(panelAreaCm2: number): FontAnalysis {
  const area: number =
    Number.isFinite(panelAreaCm2) && panelAreaCm2 > 0 ? panelAreaCm2 : 0;
  return {
    panelAreaCm2: area,
    minRequiredMm: NaN,
    estimatedMm: NaN,
    status: 'warning',
    readabilityScore: 0,
    contrastNote:
      'Not assessed: letter height needs a known-size reference in the photograph (readability agent, issue #8). Pixel estimates are never reported as millimetres.',
  };
}

/**
 * @deprecated Compatibility adapter that assembles a legacy `ProductReport`
 * via the honest engine. `score` is the internal-testing number only and
 * `overallStatus` can never be COMPLIANT here: raw OCR text without
 * reviewer-confirmed coverage cannot establish compliance.
 */
export function buildReport(
  id: string,
  productName: string,
  brand: string,
  category: string,
  imageUrl: string,
  ocrText: string,
  _panelArea?: number,
): ProductReport {
  const text: string = ocrText ?? '';
  void _panelArea;
  const ctx: ReviewContext = {
    category: category ?? 'unknown',
    importStatus: 'unknown',
    coverageConfirmed: false,
    photoCount: text.trim().length > 0 || (imageUrl ?? '').trim().length > 0 ? 1 : 0,
  };
  const results: RuleResult[] = evaluateRules([], ctx);
  const headline: ReportHeadline = computeHeadline(results);
  const overallStatus: OverallStatus =
    headline === 'suspected violation' ? 'NON_COMPLIANT' : 'NEEDS_REVIEW';
  return {
    id,
    productName,
    brand,
    category,
    imageUrl,
    scannedAt: new Date().toISOString(),
    overallStatus,
    score: computeInternalScore(results),
    checks: results.map(toLegacyCheck),
    font: computeFontAnalysis(0),
    rawOcrText: text,
  };
}
