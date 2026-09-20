"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[nyayapack] app.global_error:", error.message, {
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-white text-slate-900">
        <div className="mx-auto max-w-lg px-4 py-16 text-center">
          <h1 className="text-xl font-bold tracking-tight">
            NyayaPack failed to load
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
      </body>
    </html>
  );
}
