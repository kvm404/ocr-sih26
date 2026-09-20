import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REVIEW_STORE_KEY,
  ReviewStoreError,
  describeReviewError,
  loadReview,
  saveReview,
  type ReviewPayload,
} from "../src/lib/review-store";

function memoryStorage(onSet?: (key: string, value: string) => void) {
  const data = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      if (onSet) onSet(key, value);
      data.set(key, value);
    },
    removeItem(key: string): void {
      data.delete(key);
    },
  };
}

function payload(): ReviewPayload {
  return {
    observations: [],
    correctedTexts: {},
    reviewedCategory: null,
    reviewedImport: "unknown",
    coverageConfirmed: false,
    decisions: {},
    confirmedAt: null,
    productName: null,
    brand: null,
    photoFaces: [],
    samePackage: null,
    mismatchNote: null,
  };
}

describe("review-store persist failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saveReview writes and loadReview reads the sidecar", () => {
    const localStorage = memoryStorage();
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", { localStorage });

    saveReview("insp-1", { ...payload(), confirmedAt: "2026-01-01T00:00:00.000Z" });
    const loaded = loadReview("insp-1");
    expect(loaded?.confirmedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(localStorage.getItem(REVIEW_STORE_KEY)).toBeTruthy();
  });

  it("quota errors throw ReviewStoreError instead of silently no-op", () => {
    const localStorage = memoryStorage(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", { localStorage });

    let thrown: unknown;
    try {
      saveReview("insp-1", payload());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReviewStoreError);
    expect((thrown as ReviewStoreError).code).toBe("quota-exceeded");
    expect(loadReview("insp-1")).toBeNull();
    const copy = describeReviewError(thrown);
    expect(copy.title).toBe("This browser is out of storage");
    expect(copy.detail).toMatch(/not saved/i);
  });

  it("private-mode / unavailable storage throws instead of silently no-op", () => {
    const localStorage = memoryStorage(() => {
      throw new Error("localStorage is not available");
    });
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", { localStorage });

    let thrown: unknown;
    try {
      saveReview("insp-1", payload());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReviewStoreError);
    expect((thrown as ReviewStoreError).code).toBe("unavailable");
    expect(loadReview("insp-1")).toBeNull();
  });
});

describe("review-store without window", () => {
  beforeEach(() => {
    vi.stubGlobal("window", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loadReview returns null and does not throw", () => {
    expect(loadReview("insp-1")).toBeNull();
  });

  it("saveReview throws so callers cannot treat persist as success", () => {
    expect(() => saveReview("insp-1", payload())).toThrow(ReviewStoreError);
  });
});
