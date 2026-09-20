import { describe, expect, it } from "vitest";
import {
  InspectionStoreError,
  describeStoreError,
} from "../src/lib/store";

describe("describeStoreError", () => {
  it("maps quota to a short banner, not the IndexedDB string", () => {
    const err = new InspectionStoreError(
      "quota-exceeded",
      "Cannot add photos: browser storage is full. No data was saved; free space or remove old inspections and retry.",
    );
    const copy = describeStoreError(err);
    expect(copy.title).toBe("This browser is out of storage");
    expect(copy.detail).not.toMatch(/Cannot add photos/);
  });

  it("maps unavailable without dumping the cause", () => {
    const err = new InspectionStoreError(
      "unavailable",
      "Cannot list inspections: browser storage is unavailable (UnknownError). No data was saved.",
    );
    const copy = describeStoreError(err);
    expect(copy.title).toBe("Browser storage is unavailable");
    expect(copy.detail).not.toMatch(/UnknownError/);
    expect(copy.detail).not.toMatch(/Cannot list/);
  });

  it("does not dump a raw Error message", () => {
    const copy = describeStoreError(new Error("IndexedDB request failed"));
    expect(copy.title).toBe("Browser storage failed");
    expect(copy.detail).not.toMatch(/IndexedDB/);
  });
});
