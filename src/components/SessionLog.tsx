"use client";

import { useEffect, useState } from "react";
import { ClipboardCopy, ScrollText, Trash2 } from "lucide-react";
import { clearLogs, getLogs, subscribeLogs, type LogEvent } from "@/lib/log";

function levelClass(level: LogEvent["level"]): string {
  switch (level) {
    case "error":
      return "text-red-800";
    case "warn":
      return "text-amber-800";
    default:
      return "text-slate-700";
  }
}

export default function SessionLog() {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function refresh() {
      setEvents(getLogs());
    }
    refresh();
    return subscribeLogs(refresh);
  }, []);

  const errors = events.filter((event) => event.level === "error").length;

  async function copyJson() {
    const text = JSON.stringify(events, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ScrollText className="h-4 w-4 text-slate-500" aria-hidden="true" />
          Session log
        </h2>
        <p className="text-xs text-slate-600">
          {events.length} event{events.length === 1 ? "" : "s"}
          {errors > 0 ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}
        </p>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        Camera, storage, and model calls for this browser tab. API keys and
        photo bytes are not recorded.
      </p>
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">No events yet this session.</p>
      ) : (
        <ol className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 font-mono text-xs">
          {[...events].reverse().map((event, index) => (
            <li
              key={`${event.t}-${event.scope}-${event.event}-${index}`}
              className="border-b border-slate-200 px-3 py-2 last:border-b-0"
            >
              <p className={`font-semibold ${levelClass(event.level)}`}>
                {event.level} · {event.scope}.{event.event}
                {event.code ? ` · ${event.code}` : ""}
                {event.durationMs !== undefined ? ` · ${event.durationMs}ms` : ""}
              </p>
              <p className="mt-0.5 text-slate-800">{event.msg}</p>
              <p className="mt-0.5 text-slate-500">{event.t}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copyJson()}
          disabled={events.length === 0}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
        >
          <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
          {copied ? "Copied" : "Copy JSON"}
        </button>
        <button
          type="button"
          onClick={() => clearLogs()}
          disabled={events.length === 0}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Clear
        </button>
      </div>
    </section>
  );
}
