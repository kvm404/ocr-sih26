import { afterEach, describe, expect, it } from "vitest";
import { defaultCameraFacing } from "../src/lib/camera";
import {
  getLogs,
  log,
  resetLogState,
  sanitizeLogData,
} from "../src/lib/log";

afterEach(() => {
  resetLogState();
});

describe("sanitizeLogData", () => {
  it("redacts API keys and omits data URLs", () => {
    const clean = sanitizeLogData({
      apiKey: "sk-secret",
      authorization: "Bearer abc",
      photo: "data:image/jpeg;base64,/9j/VERYLONG",
      model: "qwen3-vl-4b",
      photoCount: 2,
    });
    expect(clean).toEqual({
      apiKey: "[redacted]",
      authorization: "[redacted]",
      photo: expect.stringMatching(/^\[omitted \d+ chars\]$/),
      model: "qwen3-vl-4b",
      photoCount: 2,
    });
  });
});

describe("log ring buffer", () => {
  it("records events without throwing in Node", () => {
    log.info("model", "test_ok", "Connected", { data: { modelCount: 1 } });
    log.error("model", "timeout", "No response", { code: "TIMEOUT" });
    const events = getLogs();
    expect(events).toHaveLength(2);
    expect(events[0]?.scope).toBe("model");
    expect(events[1]?.level).toBe("error");
    expect(events[1]?.code).toBe("TIMEOUT");
  });
});

describe("defaultCameraFacing", () => {
  it("uses the front camera when there is no phone pointer", () => {
    expect(defaultCameraFacing()).toBe("user");
  });
});
