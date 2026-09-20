"use client";

import { useEffect } from "react";
import { errorDetail, log } from "@/lib/log";

/** Catch uncaught errors for the session log. Renders nothing. */
export default function LogProbe() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      log.error("window", "uncaught", event.message || "Uncaught error", {
        data: {
          file: event.filename,
          line: event.lineno,
          col: event.colno,
        },
      });
    }
    function onReject(event: PromiseRejectionEvent) {
      const detail = errorDetail(event.reason);
      log.error("window", "unhandled_rejection", detail.message, {
        code: detail.code,
        data: { name: detail.name },
      });
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onReject);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onReject);
    };
  }, []);
  return null;
}
