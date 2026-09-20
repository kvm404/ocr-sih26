/**
 * Model-failure path (GitHub issue #11, PRD Testing Decisions).
 *
 * The model server stopped or returning invalid output must surface a
 * typed error and create NO report — never a fabricated fallback.
 * Fetch is mocked; no network is touched.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzePhotos,
  describeModelError,
  ModelClientError,
} from "../src/lib/model-client";

const PHOTO = {
  id: "p-front",
  dataUrl: "data:image/jpeg;base64,/9j/FAKE",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model-failure path: error, no report", () => {
  it("stopped server (fetch throws) -> CONNECTION_FAILED error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("CONNECTION_FAILED");
  });

  it("server error (HTTP 500) -> SERVER_ERROR, no report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("boom", { status: 500, statusText: "Server Error" }),
      ),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("SERVER_ERROR");
  });

  it("invalid server output (missing choices) -> BAD_RESPONSE, no report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ hello: "not-a-completion" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("BAD_RESPONSE");
  });

  it("HTTP 502 JSON body is a connection error, not dumped JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              "Cannot reach the local model server. Is LM Studio running with the local server enabled?",
          }),
          { status: 502, statusText: "Bad Gateway" },
        ),
      ),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("CONNECTION_FAILED");
    expect((err as ModelClientError).message).not.toMatch(/\{/);
    expect((err as ModelClientError).message).not.toMatch(/HTTP 502/);
    const copy = describeModelError(err);
    expect(copy.title).toBe("Can't reach the vision model");
    expect(copy.detail).not.toMatch(/\{/);
    expect(copy.offerSettings).toBe(true);
  });

  it("garbage JSON body -> BAD_RESPONSE, no report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{{{ not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("BAD_RESPONSE");
  });
});
