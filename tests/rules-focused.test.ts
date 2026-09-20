/**
 * Focused rule edge cases (GitHub issue #11).
 *
 * Applicability corners that are hard to isolate through the full flow:
 * date-rule category exceptions, unknown import status on the
 * manufacturer check, and unscaled font-height checks.
 */

import { describe, expect, it } from "vitest";
import { assessFontHeight } from "../src/lib/readability";
import { computeHeadline, evaluateRules, resultsForHeadline } from "../src/lib/rules";
import type { ObservedInput, ReviewContext } from "../src/lib/types";

function ctxFor(category: string): ReviewContext {
  return {
    category,
    importStatus: "domestic",
    coverageConfirmed: true,
    photoCount: 1,
  };
}

function readable(field: ObservedInput["field"], value: string): ObservedInput {
  return { field, value, photoId: "p-front", needsReview: false };
}

describe("date rule: category exceptions stay not_assessed, never failed", () => {
  const excepted = [
    "Food and beverages",
    "food",
    "seeds",
    "cosmetics",
    "cosmet",
    "personal-care",
    "bidis",
    "incense sticks",
    "LPG",
    "unknown",
    "other",
    "",
  ];
  for (const category of excepted) {
    it(`"${category || "(empty)"}" -> not_assessed`, () => {
      const res = evaluateRules(
        [readable("manufacture_date", "MFD 01/2025")],
        ctxFor(category),
      ).find((r) => r.ruleId === "manufacture_date");
      expect(res?.result).toBe("not_assessed");
      expect(res?.message).toMatch(/month-year|packing\/import-date/i);
    });
  }

  it("clear category (household) with readable text -> assessable", () => {
    const res = evaluateRules(
      [readable("manufacture_date", "MFD 01/2025")],
      ctxFor("household"),
    ).find((r) => r.ruleId === "manufacture_date");
    expect(res?.result).toBe("no_issue_found");
  });
});

describe("unknown import status -> manufacturer check not_assessed", () => {
  it("observed name/address with importStatus unknown stays not_assessed", () => {
    const res = evaluateRules([readable("manufacturer", "Acme Ltd, Mumbai")], {
      category: "household",
      importStatus: "unknown",
      coverageConfirmed: true,
      photoCount: 1,
    }).find((r) => r.ruleId === "manufacturer");
    expect(res?.result).toBe("not_assessed");
    expect(res?.message).toMatch(/import status is unconfirmed/i);
    expect(res?.evidence?.value).toBe("Acme Ltd, Mumbai");
  });
});

describe("rejected suspected violations do not keep the suspected-violation headline", () => {
  const missingMrp: ObservedInput[] = [
    readable("manufacturer", "Acme Ltd, Mumbai"),
    { field: "mrp", value: null, photoId: "p-front", needsReview: false },
    readable("net_quantity", "500 g"),
    readable("consumer_care", "1800-123-456"),
  ];

  it("pending or accepted suspected violation still headlines as suspected violation", () => {
    const results = evaluateRules(missingMrp, ctxFor("household"));
    expect(computeHeadline(results)).toBe("suspected violation");
    expect(computeHeadline(resultsForHeadline(results, { mrp: "accepted" }))).toBe(
      "suspected violation",
    );
    const mrp = results.find((r) => r.ruleId === "mrp");
    expect(mrp?.result).toBe("suspected_violation");
  });

  it("rejecting the only suspected violation yields no issue found in assessed checks", () => {
    const results = evaluateRules(missingMrp, ctxFor("household"));
    const forHeadline = resultsForHeadline(results, { mrp: "rejected" });
    expect(computeHeadline(forHeadline)).toBe("no issue found in assessed checks");
    expect(results.find((r) => r.ruleId === "mrp")?.result).toBe("suspected_violation");
    expect(forHeadline.find((r) => r.ruleId === "mrp")?.result).toBe("no_issue_found");
  });
});

describe("unscaled font-height -> not_assessed, never millimetres", () => {
  it("no known-size reference -> not_assessed", () => {
    const res = assessFontHeight(null, 1, "Rule 7, G.S.R. 629(E)");
    expect(res.result).toBe("not_assessed");
    expect(res.estimatedMm).toBeNull();
    expect(res.method).toBeNull();
  });

  it("bad perspective / curvature -> not_assessed", () => {
    const base = {
      photoId: "p-front",
      referenceLabel: "steel ruler",
      referenceSizeMm: 10,
      measuredRefPx: 100,
      measuredTextPx: 12,
      perspectiveOk: false,
      curvatureOk: true,
    };
    expect(assessFontHeight(base, 1, "Rule 7").result).toBe("not_assessed");
    expect(assessFontHeight({ ...base, perspectiveOk: true, curvatureOk: false }, 1, "Rule 7").result).toBe(
      "not_assessed",
    );
  });

  it("unknown threshold -> not_assessed (no invented limit)", () => {
    const res = assessFontHeight(
      {
        photoId: "p-front",
        referenceLabel: "steel ruler",
        referenceSizeMm: 10,
        measuredRefPx: 100,
        measuredTextPx: 12,
        perspectiveOk: true,
        curvatureOk: true,
      },
      null,
      "Rule 7",
    );
    expect(res.result).toBe("not_assessed");
  });
});
