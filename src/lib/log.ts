/**
 * Session observability for the prototype.
 *
 * Events go to the console and, in the browser, a ring buffer in
 * sessionStorage (Settings → Session log). API keys, Authorization
 * headers, data URLs, and blobs are stripped before anything is stored
 * or printed.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  t: string;
  level: LogLevel;
  scope: string;
  event: string;
  msg: string;
  durationMs?: number;
  code?: string;
  data?: Record<string, unknown>;
}

const MAX_EVENTS = 120;
const STORAGE_KEY = "nyayapack.logs.v1";

const SECRET_KEY = /^(apiKey|authorization|token|password|cookie|set-cookie)$/i;
const SECRET_VALUE = /^(bearer\s+)/i;
const DATA_URL_PREFIX = /^data:/i;

type Listener = () => void;
const listeners = new Set<Listener>();

let memory: LogEvent[] | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strip secrets and bulky payloads. Safe to print or persist. */
export function sanitizeLogData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string") {
      if (DATA_URL_PREFIX.test(value) || value.length > 400) {
        out[key] = `[omitted ${value.length} chars]`;
        continue;
      }
      if (SECRET_VALUE.test(value)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = value;
      continue;
    }
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message };
      continue;
    }
    if (isPlainRecord(value)) {
      out[key] = sanitizeLogData(value) ?? {};
      continue;
    }
    if (Array.isArray(value)) {
      const smallIds = value.every(
        (item) =>
          (typeof item === "string" && item.length < 80) ||
          typeof item === "number" ||
          typeof item === "boolean",
      );
      out[key] = smallIds && value.length <= 24 ? value : value.length;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    }
  }
  return out;
}

export function errorDetail(err: unknown): { message: string; name?: string; code?: string } {
  if (err && typeof err === "object" && "code" in err && err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      message: err.message,
      name: err.name,
      code: typeof code === "string" ? code : undefined,
    };
  }
  if (err instanceof Error) return { message: err.message, name: err.name };
  return { message: String(err) };
}

function loadBuffer(): LogEvent[] {
  if (memory) return memory;
  if (typeof sessionStorage === "undefined") {
    memory = [];
    return memory;
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      memory = [];
      return memory;
    }
    const parsed = JSON.parse(raw) as unknown;
    memory = Array.isArray(parsed) ? (parsed as LogEvent[]) : [];
  } catch {
    memory = [];
  }
  return memory;
}

function persist(events: LogEvent[]): void {
  memory = events;
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Quota or private mode: console still has the line.
  }
  for (const listener of listeners) listener();
}

function write(entry: LogEvent): void {
  const events = loadBuffer();
  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  persist(events);

  const payload = {
    code: entry.code,
    durationMs: entry.durationMs,
    ...(entry.data ?? {}),
  };
  const line = `[nyayapack] ${entry.scope}.${entry.event}: ${entry.msg}`;
  if (entry.level === "error") console.error(line, payload);
  else if (entry.level === "warn") console.warn(line, payload);
  else if (entry.level === "debug") console.debug(line, payload);
  else console.info(line, payload);
}

function emit(
  level: LogLevel,
  scope: string,
  event: string,
  msg: string,
  extra?: { durationMs?: number; code?: string; data?: Record<string, unknown> },
): void {
  write({
    t: nowIso(),
    level,
    scope,
    event,
    msg,
    durationMs: extra?.durationMs,
    code: extra?.code,
    data: sanitizeLogData(extra?.data),
  });
}

export const log = {
  debug: (scope: string, event: string, msg: string, extra?: { durationMs?: number; code?: string; data?: Record<string, unknown> }) =>
    emit("debug", scope, event, msg, extra),
  info: (scope: string, event: string, msg: string, extra?: { durationMs?: number; code?: string; data?: Record<string, unknown> }) =>
    emit("info", scope, event, msg, extra),
  warn: (scope: string, event: string, msg: string, extra?: { durationMs?: number; code?: string; data?: Record<string, unknown> }) =>
    emit("warn", scope, event, msg, extra),
  error: (scope: string, event: string, msg: string, extra?: { durationMs?: number; code?: string; data?: Record<string, unknown> }) =>
    emit("error", scope, event, msg, extra),
};

export function getLogs(): LogEvent[] {
  return [...loadBuffer()];
}

export function clearLogs(): void {
  persist([]);
}

export function subscribeLogs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reset in-memory state. Used by tests. */
export function resetLogState(): void {
  memory = [];
  listeners.clear();
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
