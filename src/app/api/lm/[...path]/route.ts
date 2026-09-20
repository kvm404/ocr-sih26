/**
 * Same-origin proxy to the local model server.
 *
 * Browsers block cross-origin reads against LM Studio's local server (it sends
 * no `Access-Control-Allow-*` headers and rejects preflight with HTTP 400),
 * so client-side `fetch("http://localhost:1234/v1/...")` always fails in the
 * page even while the server is up. This route forwards to the loopback
 * server where no CORS check applies.
 *
 * Loopback-only: the target must resolve to localhost / 127.0.0.1 / ::1,
 * otherwise the request is rejected. The caller's API key (if any) arrives
 * per-request in the Authorization header and is forwarded without storage.
 */

import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const PROXY_BASE_HEADER = "x-lm-base-url";
const DEFAULT_LOOPBACK_BASE = "http://localhost:1234/v1";

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function resolveTarget(req: Request, path: string[]): { url: string } | { error: string; status: number } {
  const rawBase = req.headers.get(PROXY_BASE_HEADER)?.trim() || DEFAULT_LOOPBACK_BASE;
  let base: URL;
  try {
    base = new URL(rawBase.replace(/\/+$/, ""));
  } catch {
    return { error: "Invalid model base URL.", status: 400 };
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return { error: "Only http(s) model endpoints are allowed.", status: 400 };
  }
  if (!isLoopbackHost(base.hostname)) {
    return { error: "Proxy is limited to the local machine (localhost).", status: 403 };
  }
  const cleanPath = path.map((seg) => seg.replace(/[^A-Za-z0-9._~-]/g, "")).filter(Boolean);
  if (cleanPath.length === 0) {
    return { error: "Missing upstream path.", status: 400 };
  }
  return { url: `${base.toString()}/${cleanPath.join("/")}` };
}

async function forward(req: Request, path: string[]): Promise<Response> {
  const started = Date.now();
  const target = resolveTarget(req, path);
  if ("error" in target) {
    log.warn("proxy", "rejected", target.error, {
      code: String(target.status),
      data: { method: req.method, path: path.join("/") },
    });
    return Response.json({ error: target.error }, { status: target.status });
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  const authorization = req.headers.get("authorization");
  if (authorization) headers["Authorization"] = authorization;

  let upstream: Response;
  try {
    upstream = await fetch(target.url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("proxy", "upstream_unreachable", "Cannot reach local model server", {
      code: "502",
      durationMs: Date.now() - started,
      data: { url: target.url, method: req.method, cause: message },
    });
    return Response.json(
      { error: "Cannot reach the local model server. Is LM Studio running with the local server enabled?" },
      { status: 502 },
    );
  }
  const body = await upstream.arrayBuffer();
  const contentTypeOut = upstream.headers.get("content-type") ?? "application/json";
  const level = upstream.ok ? "info" : "error";
  log[level]("proxy", "upstream", `${req.method} ${target.url} → ${upstream.status}`, {
    code: String(upstream.status),
    durationMs: Date.now() - started,
    data: { bytes: body.byteLength, ok: upstream.ok },
  });
  return new Response(body, { status: upstream.status, headers: { "Content-Type": contentTypeOut } });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forward(req, (await ctx.params).path);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return forward(req, (await ctx.params).path);
}
