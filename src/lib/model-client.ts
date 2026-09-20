/**
 * LM Studio model connection boundary (OpenAI-compatible `chat/completions`
 * with `image_url`).
 *
 * - Default endpoint: local LM Studio at http://localhost:1234/v1,
 *   model "qwen3-vl-4b" (see `model-config.ts`).
 * - The optional API key is kept in a module-singleton variable for the
 *   current session only. It is never written to localStorage, never logged,
 *   and never included in reports or exports.
 * - `analyzePhotos` sends the real photographs and returns the raw server
 *   JSON. There is no substitute report, no sample fallback, and no Tesseract
 *   import here. Connectivity, timeout, and invalid responses become typed
 *   `ModelClientError`s so the scan UI can show a clear error instead of a
 *   fabricated analysis.
 */

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  clearPersistedModelConfig,
  loadPersistedModelConfig,
  normalizeBaseUrl,
  persistModelConfig,
  type ModelConfig,
} from "./model-config";
import {
  buildExtractionPrompt,
  buildPhotoExtractionPrompt,
  CATEGORIES,
  parseExtractionResponse,
  type CategoryHint,
  type ExtractionResult,
} from "./observations";
import { mergePhotoExtractions } from "./package-analysis";
import { errorDetail, log } from "./log";

export type { ModelConfig } from "./model-config";

/** One package photograph to send to the vision model. */
export interface ModelPhoto {
  /** Caller-side id (e.g. upload slot) used to reference the photo in the prompt. */
  id: string;
  /** Full data URL, e.g. "data:image/jpeg;base64,...". Sent verbatim. */
  dataUrl: string;
}

export type ModelErrorCode =
  | "CONNECTION_FAILED"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "MODEL_NOT_FOUND"
  | "BAD_REQUEST"
  | "SERVER_ERROR"
  | "BAD_RESPONSE";

export class ModelClientError extends Error {
  readonly code: ModelErrorCode;
  readonly status?: number;
  readonly endpoint?: string;

  constructor(code: ModelErrorCode, message: string, opts?: { status?: number; endpoint?: string }) {
    super(message);
    this.name = "ModelClientError";
    this.code = code;
    this.status = opts?.status;
    this.endpoint = opts?.endpoint;
  }
}

export interface TestConnectionResult {
  ok: true;
  baseUrl: string;
  /** Models reported by GET /models (may be empty when the server omits the list). */
  models: string[];
  /** Whether the configured model id appears in the reported list. */
  configuredModelFound: boolean | null;
}

export const TEST_CONNECTION_TIMEOUT_MS = 15_000;
export const ANALYZE_PHOTOS_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Session-only state. Module singleton => lives for the page session only.
// The key is never persisted, never logged, and never returned by
// getModelConfig() so it cannot leak into reports/exports.
// ---------------------------------------------------------------------------
let inMemoryApiKey = "";

function readApiKey(): string {
  return inMemoryApiKey;
}

/** Store the optional API key in session memory only. */
export function setApiKey(key: string): void {
  inMemoryApiKey = key.trim();
}

/** Whether a session API key is currently held in memory. */
export function hasApiKey(): boolean {
  return inMemoryApiKey.length > 0;
}

/** Drop the session API key from memory. */
export function clearApiKey(): void {
  inMemoryApiKey = "";
}

// ---------------------------------------------------------------------------
// Config access (persisted baseUrl + model; key stays memory-only).
// ---------------------------------------------------------------------------

/** Current effective config: persisted preferences merged over defaults. */
export function getModelConfig(): ModelConfig {
  const persisted = loadPersistedModelConfig();
  if (persisted) return persisted;
  return { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL_ID };
}

export interface ModelConfigPatch {
  baseUrl?: string;
  model?: string;
  /** Optional key update; when present it is stored in memory only. */
  apiKey?: string;
}

/**
 * Update config. `baseUrl`/`model` persist to localStorage; `apiKey` (when
 * the property is present) updates session memory only and is never stored.
 * Pass `apiKey: ""` to clear the in-memory key.
 */
export function setModelConfig(patch: ModelConfigPatch): ModelConfig {
  const current = getModelConfig();
  const next: ModelConfig = {
    baseUrl:
      patch.baseUrl !== undefined && patch.baseUrl.trim()
        ? normalizeBaseUrl(patch.baseUrl)
        : current.baseUrl,
    model:
      patch.model !== undefined && patch.model.trim()
        ? patch.model.trim()
        : current.model,
  };
  persistModelConfig(next);
  if (patch.apiKey !== undefined) {
    inMemoryApiKey = patch.apiKey.trim();
  }
  return next;
}

/** Reset persisted baseUrl/model to defaults. The memory key is left alone. */
export function resetModelConfig(): ModelConfig {
  clearPersistedModelConfig();
  return { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL_ID };
}

// ---------------------------------------------------------------------------
// Fetch helpers.
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const key = readApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException ? err.name === "AbortError" : err instanceof Error && err.name === "AbortError"
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function connectionFailed(endpoint: string, cause: unknown): ModelClientError {
  const detail = errorDetail(cause);
  log.error("model", "connection_failed", `Cannot reach ${endpoint}`, {
    code: "CONNECTION_FAILED",
    data: { endpoint, cause: detail.message, name: detail.name },
  });
  return new ModelClientError(
    "CONNECTION_FAILED",
    "Can't reach the vision model. Start LM Studio with the local server enabled, then try again.",
    { endpoint },
  );
}

function timeoutError(endpoint: string, timeoutMs: number): ModelClientError {
  log.error("model", "timeout", `No response from ${endpoint} within ${timeoutMs}ms`, {
    code: "TIMEOUT",
    durationMs: timeoutMs,
    data: { endpoint },
  });
  return new ModelClientError(
    "TIMEOUT",
    "The vision model did not respond in time. It may still be loading in LM Studio. Try again once it is ready.",
    { endpoint },
  );
}

/** Pull a short server phrase from an HTTP body. Never returns raw JSON. */
function extractHttpErrorText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      const err = rec.error;
      if (typeof err === "string" && err.trim()) return err.trim();
      if (err && typeof err === "object") {
        const nested = (err as { message?: unknown }).message;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      }
      if (typeof rec.message === "string" && rec.message.trim()) return rec.message.trim();
    }
  } catch {
    // not JSON
  }
  if (text.startsWith("{") || text.startsWith("[")) return null;
  return text.slice(0, 160);
}

async function throwForStatus(res: Response, endpoint: string): Promise<never> {
  const status = res.status;
  let raw = "";
  try {
    raw = (await res.text()).slice(0, 400).trim();
  } catch {
    raw = "";
  }
  const parsed = extractHttpErrorText(raw);
  log.error("model", "http_error", `HTTP ${status} from ${endpoint}`, {
    code: String(status),
    data: { endpoint, status, detail: parsed ?? raw.slice(0, 200) },
  });
  if (status === 401 || status === 403) {
    throw new ModelClientError(
      "UNAUTHORIZED",
      "The model server rejected the request. Check the API key in Settings. Local LM Studio usually needs none.",
      { status, endpoint },
    );
  }
  if (status === 404) {
    throw new ModelClientError(
      "NOT_FOUND",
      "The model endpoint was not found. Check the base URL in Settings.",
      { status, endpoint },
    );
  }
  if (status === 502 || status === 503) {
    throw new ModelClientError(
      "CONNECTION_FAILED",
      "Can't reach the vision model. Start LM Studio with the local server enabled, then try again.",
      { status, endpoint },
    );
  }
  if (status >= 500) {
    throw new ModelClientError(
      "SERVER_ERROR",
      "The vision model failed on the server. Try again, or check LM Studio.",
      { status, endpoint },
    );
  }
  throw new ModelClientError(
    "MODEL_NOT_FOUND",
    "The model request failed. Check the model id in Settings.",
    { status, endpoint },
  );
}

/** Short copy for inspect/settings banners. Raw HTTP bodies stay in the session log. */
export function describeModelError(err: unknown): {
  title: string;
  detail: string;
  offerSettings: boolean;
} {
  if (err instanceof ModelClientError) {
    switch (err.code) {
      case "CONNECTION_FAILED":
        return {
          title: "Can't reach the vision model",
          detail: "Start LM Studio with the local server enabled, then try again.",
          offerSettings: true,
        };
      case "TIMEOUT":
        return {
          title: "The vision model timed out",
          detail: "It may still be loading. Wait until it is ready in LM Studio, then try again.",
          offerSettings: true,
        };
      case "UNAUTHORIZED":
        return {
          title: "The model server rejected the request",
          detail: "Check the API key in Settings. Local LM Studio usually needs none.",
          offerSettings: true,
        };
      case "NOT_FOUND":
      case "MODEL_NOT_FOUND":
        return {
          title: "The model was not found",
          detail: "Check the base URL and model id in Settings.",
          offerSettings: true,
        };
      case "BAD_REQUEST":
        return {
          title: "The photographs could not be sent",
          detail: err.message,
          offerSettings: false,
        };
      case "SERVER_ERROR":
        return {
          title: "The vision model failed",
          detail: "Try again in a moment. If it keeps failing, check LM Studio.",
          offerSettings: true,
        };
      case "BAD_RESPONSE":
        return {
          title: "The vision model returned nothing usable",
          detail: "No report was created. Try again, or check the model in Settings.",
          offerSettings: true,
        };
    }
  }
  if (err instanceof Error && err.message.trim()) {
    return { title: "Analysis failed", detail: err.message, offerSettings: false };
  }
  return { title: "Analysis failed", detail: "No report was created.", offerSettings: false };
}

// ---------------------------------------------------------------------------
// Endpoint resolution: loopback LM Studio through the same-origin proxy.
// ---------------------------------------------------------------------------

/**
 * LM Studio's local server answers curl but not browsers: it sends no
 * `Access-Control-Allow-*` headers and rejects CORS preflight (HTTP 400), so
 * a page fetch always fails while the server is up. In the browser, loopback
 * targets therefore go through the same-origin `/api/lm` proxy route (which
 * forwards server-to-server where CORS does not apply). Non-loopback or
 * non-browser callers use the configured URL directly.
 */
export function resolveModelEndpoint(
  baseUrl: string,
  path: string,
): { url: string; display: string; proxyBase: string | null } {
  const base = normalizeBaseUrl(baseUrl);
  const display = `${base}/${path}`;
  if (typeof window === "undefined") return { url: display, display, proxyBase: null };
  let host = "";
  try {
    host = new URL(base).hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return { url: display, display, proxyBase: null };
  }
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!loopback) return { url: display, display, proxyBase: null };
  return { url: `/api/lm/${path}`, display, proxyBase: base };
}

function proxyHeaders(proxyBase: string | null): Record<string, string> {
  return proxyBase ? { "x-lm-base-url": proxyBase } : {};
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Check connectivity via GET {baseUrl}/models. Resolves with the reported
 * model list; throws a typed ModelClientError on failure.
 */
export async function testConnection(opts?: { timeoutMs?: number }): Promise<TestConnectionResult> {
  const { baseUrl, model } = getModelConfig();
  const timeoutMs = opts?.timeoutMs ?? TEST_CONNECTION_TIMEOUT_MS;
  const route = resolveModelEndpoint(baseUrl, "models");
  const endpoint = route.display;
  const started = Date.now();
  log.info("model", "test_start", `GET ${endpoint}`, { data: { model } });
  let res: Response;
  try {
    res = await fetchWithTimeout(
      route.url,
      { method: "GET", headers: { Accept: "application/json", ...authHeaders(), ...proxyHeaders(route.proxyBase) } },
      timeoutMs,
    );
  } catch (err) {
    if (isAbortError(err)) throw timeoutError(endpoint, timeoutMs);
    throw connectionFailed(endpoint, err);
  }
  if (!res.ok) await throwForStatus(res, endpoint);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ModelClientError(
      "BAD_RESPONSE",
      "The model server returned an invalid response. Expected OpenAI-compatible JSON.",
      { status: res.status, endpoint },
    );
  }
  if (json === null || typeof json !== "object") {
    throw new ModelClientError(
      "BAD_RESPONSE",
      "The model server returned an invalid response. Expected OpenAI-compatible JSON.",
      { status: res.status, endpoint },
    );
  }
  const data = (json as { data?: unknown }).data;
  const models = Array.isArray(data)
    ? data
        .map((m) => (m !== null && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string")
    : [];
  const result = {
    ok: true as const,
    baseUrl: normalizeBaseUrl(baseUrl),
    models,
    configuredModelFound: models.length > 0 ? models.includes(model) : null,
  };
  log.info("model", "test_ok", `Connected to ${result.baseUrl}`, {
    durationMs: Date.now() - started,
    data: {
      modelCount: models.length,
      configuredModelFound: result.configuredModelFound,
    },
  });
  return result;
}

/**
 * Canonical extraction prompt (field-grouped JSON the observation parser
 * consumes) plus the exact photo ids the model must cite. A divergent prompt
 * shape here silently yields zero observations downstream, so this is the
 * single place the analysis prompt is built.
 */
function resolveCategoryHint(categoryHint?: string): CategoryHint {
  const raw = categoryHint?.trim() ?? "";
  const known = (CATEGORIES as readonly string[]).includes(raw) ? (raw as CategoryHint) : null;
  return known ?? "Auto-detect";
}

function buildAnalysisPrompt(photoIds: string[], categoryHint?: string): string {
  const hint = resolveCategoryHint(categoryHint);
  return (
    `${buildExtractionPrompt(photoIds.length, hint)}\n` +
    `Photo ids in order: ${photoIds.join(", ")}. Cite exactly these photoIds.` +
    (hint !== "Auto-detect" ? `\nOperator category hint (not ground truth): "${hint}".` : "")
  );
}

/**
 * Send real photographs to POST {baseUrl}/chat/completions (OpenAI-compatible
 * `image_url` parts) and return the raw server JSON.
 *
 * Throws a typed ModelClientError on connectivity, timeout, HTTP, or invalid
 * responses. Never synthesizes a report.
 */
export async function analyzePhotos(
  photos: ModelPhoto[],
  categoryHint?: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal; maxTokens?: number; prompt?: string },
): Promise<unknown> {
  if (!Array.isArray(photos) || photos.length === 0) {
    throw new ModelClientError("BAD_REQUEST", "Provide at least one package photograph to analyze.");
  }
  for (const photo of photos) {
    if (!photo || typeof photo.id !== "string" || !photo.id.trim()) {
      throw new ModelClientError("BAD_REQUEST", "Each photo needs an id so observations can cite their source.");
    }
    if (typeof photo.dataUrl !== "string" || !photo.dataUrl.startsWith("data:image/")) {
      throw new ModelClientError(
        "BAD_REQUEST",
        `Photo "${photo.id}" is not a valid image data URL. Pass the original upload bytes through unchanged.`,
      );
    }
  }

  const { baseUrl, model } = getModelConfig();
  const timeoutMs = opts?.timeoutMs ?? ANALYZE_PHOTOS_TIMEOUT_MS;
  const route = resolveModelEndpoint(baseUrl, "chat/completions");
  const endpoint = route.display;
  const started = Date.now();
  log.info("model", "analyze_start", `POST ${endpoint}`, {
    data: { model, photoCount: photos.length, photoIds: photos.map((p) => p.id) },
  });
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: opts?.prompt?.trim()
              ? opts.prompt
              : buildAnalysisPrompt(photos.map((p) => p.id), categoryHint),
          },
          ...photos.map((p) => ({ type: "image_url", image_url: { url: p.dataUrl } })),
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: opts?.maxTokens ?? 2500,
  };

  let res: Response;
  try {
    res = await fetchWithTimeout(
      route.url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders(), ...proxyHeaders(route.proxyBase) },
        body: JSON.stringify(body),
      },
      timeoutMs,
      opts?.signal,
    );
  } catch (err) {
    if (opts?.signal?.aborted || isAbortError(err)) {
      if (opts?.signal?.aborted) {
        throw new ModelClientError("TIMEOUT", "The analysis was cancelled.", { endpoint });
      }
      throw timeoutError(endpoint, timeoutMs);
    }
    throw connectionFailed(endpoint, err);
  }
  if (!res.ok) await throwForStatus(res, endpoint);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    log.error("model", "bad_response", "Invalid JSON from chat/completions", {
      code: "BAD_RESPONSE",
      data: { endpoint, status: res.status },
    });
    throw new ModelClientError(
      "BAD_RESPONSE",
      "The model server returned invalid JSON. No report was created.",
      { status: res.status, endpoint },
    );
  }
  if (json === null || typeof json !== "object" || !("choices" in json)) {
    log.error("model", "bad_response", "Response missing choices", {
      code: "BAD_RESPONSE",
      data: { endpoint, status: res.status },
    });
    throw new ModelClientError(
      "BAD_RESPONSE",
      "The model server returned an unexpected response. No report was created.",
      { status: res.status, endpoint },
    );
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModelClientError(
      "BAD_RESPONSE",
      "The model server returned no completion. No report was created.",
      { status: res.status, endpoint },
    );
  }
  log.info("model", "analyze_ok", "Model returned completion choices", {
    durationMs: Date.now() - started,
    data: { photoCount: photos.length, choiceCount: choices.length, model },
  });
  return json;
}

/**
 * Analyse each package photograph on its own, then merge into one
 * package-level extraction. Qwen3-VL-4B often attends to a single image
 * when several share one request; per-photo calls keep front (brand) and
 * back (declarations) instead of dropping one side.
 */
export async function analyzePackage(
  photos: ModelPhoto[],
  categoryHint?: string,
  opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    maxTokens?: number;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<ExtractionResult> {
  if (!Array.isArray(photos) || photos.length === 0) {
    throw new ModelClientError("BAD_REQUEST", "Provide at least one package photograph to analyze.");
  }
  const hint = resolveCategoryHint(categoryHint);
  const perPhoto: ExtractionResult[] = [];
  const total = photos.length;
  const started = Date.now();
  log.info("model", "package_start", `Analyzing ${total} photograph(s)`, {
    data: { photoCount: total, hint },
  });
  for (let i = 0; i < total; i++) {
    if (opts?.signal?.aborted) {
      throw new ModelClientError("TIMEOUT", "The analysis was cancelled.");
    }
    opts?.onProgress?.(i, total);
    const photo = photos[i];
    const prompt = buildPhotoExtractionPrompt(photo.id, i + 1, total, hint);
    const raw = await analyzePhotos([photo], categoryHint, {
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      maxTokens: opts?.maxTokens ?? 2500,
      prompt,
    });
    const parsed = parseExtractionResponse(raw, [photo.id]);
    if (!parsed.photoFaces.some((face) => face.photoId === photo.id)) {
      parsed.photoFaces = [{ photoId: photo.id, face: "unknown", note: "" }, ...parsed.photoFaces];
    }
    perPhoto.push(parsed);
    opts?.onProgress?.(i + 1, total);
  }
  const merged = mergePhotoExtractions(
    perPhoto,
    photos.map((photo) => photo.id),
  );
  log.info("model", "package_ok", "Merged per-photo extractions", {
    durationMs: Date.now() - started,
    data: {
      photoCount: total,
      observationCount: merged.observations.length,
      unattested: merged.unattestedPhotoIds.length,
    },
  });
  return merged;
}

/** Result of a free-form vision chat used by the Settings test bench. */
export interface VisionChatResult {
  /** Assistant reply text. */
  text: string;
  /** Wall-clock round trip in milliseconds. */
  elapsedMs: number;
  /** Model id that answered, when reported. */
  model?: string;
}

/**
 * Send one image plus a free-form prompt to POST {baseUrl}/chat/completions
 * (OpenAI-compatible `image_url` part) and return the assistant's text.
 *
 * Powers the Settings test bench so an operator can probe the model with any
 * uploaded photo before running the inspection flow. Throws a typed
 * ModelClientError on failure. Never synthesizes content.
 */
export async function chatVisionText(
  imageDataUrl: string,
  prompt: string,
  opts?: { systemPrompt?: string; timeoutMs?: number; maxTokens?: number },
): Promise<VisionChatResult> {
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    throw new ModelClientError("BAD_REQUEST", "Provide a valid image data URL to test the model with.");
  }
  const text = prompt.trim();
  if (!text) {
    throw new ModelClientError("BAD_REQUEST", "Provide a prompt to send with the test image.");
  }

  const { baseUrl, model } = getModelConfig();
  const timeoutMs = opts?.timeoutMs ?? ANALYZE_PHOTOS_TIMEOUT_MS;
  const route = resolveModelEndpoint(baseUrl, "chat/completions");
  const endpoint = route.display;
  const messages: unknown[] = [];
  if (opts?.systemPrompt?.trim()) {
    messages.push({ role: "system", content: opts.systemPrompt.trim() });
  }
  messages.push({
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ],
  });
  const body = { model, messages, temperature: 0.2, max_tokens: opts?.maxTokens ?? 800 };

  const started = Date.now();
  log.info("model", "bench_start", `POST ${endpoint}`, { data: { model } });
  let res: Response;
  try {
    res = await fetchWithTimeout(
      route.url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders(), ...proxyHeaders(route.proxyBase) },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  } catch (err) {
    if (isAbortError(err)) throw timeoutError(endpoint, timeoutMs);
    throw connectionFailed(endpoint, err);
  }
  if (!res.ok) await throwForStatus(res, endpoint);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ModelClientError(
      "BAD_RESPONSE",
      "The model server returned invalid JSON.",
      { status: res.status, endpoint },
    );
  }
  const choice = (json as { choices?: unknown }).choices;
  const content =
    Array.isArray(choice) && choice.length > 0
      ? (choice[0] as { message?: { content?: unknown } }).message?.content
      : undefined;
  if (typeof content !== "string" || !content.trim()) {
    throw new ModelClientError(
      "BAD_RESPONSE",
      "The model server returned no reply text.",
      { status: res.status, endpoint },
    );
  }
  const served = (json as { model?: unknown }).model;
  const elapsedMs = Date.now() - started;
  log.info("model", "bench_ok", "Vision bench returned text", {
    durationMs: elapsedMs,
    data: { model: typeof served === "string" ? served : model, chars: content.trim().length },
  });
  return {
    text: content.trim(),
    elapsedMs,
    model: typeof served === "string" ? served : undefined,
  };
}

/** Re-export defaults for UIs that need them without importing both modules. */
export { DEFAULT_BASE_URL, DEFAULT_MODEL_ID };
export type { TestConnectionResult as ModelTestResult };
