/**
 * Model-failure path (GitHub issue #11, PRD Testing Decisions).
 *
 * The model server stopped or returning invalid output must surface a
 * typed error and create NO report — never a fabricated fallback.
 * Fetch is mocked; no network is touched.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzePackage,
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

  it("HTTP 400 rejected payload is not MODEL_NOT_FOUND", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid image payload" }), {
          status: 400,
          statusText: "Bad Request",
        }),
      ),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("BAD_REQUEST");
    const copy = describeModelError(err);
    expect(copy.title).not.toBe("The model was not found");
  });

  it("HTTP 413 is not MODEL_NOT_FOUND", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("too large", { status: 413 })),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("BAD_REQUEST");
    expect(describeModelError(err).title).not.toBe("The model was not found");
  });

  it("HTTP 429 is not MODEL_NOT_FOUND", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("SERVER_ERROR");
    expect(describeModelError(err).title).not.toBe("The model was not found");
  });

  it("HTTP 400 that names a missing model stays MODEL_NOT_FOUND", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Model qwen3-vl-4b does not exist" }), {
          status: 400,
        }),
      ),
    );
    const err = await analyzePhotos([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("MODEL_NOT_FOUND");
  });

  it("analyzePackage: 200 choices with empty content is BAD_RESPONSE, not package_ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const err = await analyzePackage([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("BAD_RESPONSE");
  });

  it("analyzePackage: 200 choices with non-JSON content is BAD_RESPONSE, not package_ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "sorry, I cannot read this" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const err = await analyzePackage([PHOTO]).catch((e) => e);
    expect(err).toBeInstanceOf(ModelClientError);
    expect((err as ModelClientError).code).toBe("BAD_RESPONSE");
  });

  it("analyzePackage: parseable empty observations is not a transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    observations: [],
                    categoryUncertain: true,
                    importSuggestion: "unknown",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await analyzePackage([PHOTO]);
    expect(result.observations).toEqual([]);
    expect(result.unattestedPhotoIds).toEqual([PHOTO.id]);
  });
});
