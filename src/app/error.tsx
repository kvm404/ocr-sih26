"use client";

import { useEffect } from "react";
import { log } from "@/lib/log";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    log.error("app", "route_error", error.message, {
      data: { name: error.name, digest: error.digest },
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <h1 className="text-xl font-bold tracking-tight text-slate-900">
        This page hit an error
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        Try again. If it keeps happening, refresh the page.
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-[#1D4ED8] px-4 text-sm font-semibold text-white hover:bg-[#1E40AF]"
      >
        Try again
      </button>
    </div>
  );
}
