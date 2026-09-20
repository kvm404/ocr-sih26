"use client";

import Link from "next/link";

export type NoticeTone = "error" | "info" | "success";

export type NoticeCopy = {
  title: string;
  detail?: string;
  href?: string;
  hrefLabel?: string;
};

const TONES: Record<
  NoticeTone,
  { box: string; title: string; detail: string; link: string }
> = {
  error: {
    box: "border-red-200 bg-red-50",
    title: "text-red-950",
    detail: "text-red-800",
    link: "text-red-950 hover:text-red-900",
  },
  info: {
    box: "border-blue-200 bg-blue-50",
    title: "text-blue-950",
    detail: "text-blue-800",
    link: "text-blue-950 hover:text-blue-900",
  },
  success: {
    box: "border-green-200 bg-green-50",
    title: "text-green-950",
    detail: "text-green-800",
    link: "text-green-950 hover:text-green-900",
  },
};

export function Notice({
  tone = "error",
  title,
  detail,
  href,
  hrefLabel = "Open Settings",
}: NoticeCopy & { tone?: NoticeTone }) {
  const colors = TONES[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 ${colors.box}`}
    >
      <p className={`text-sm font-semibold ${colors.title}`}>{title}</p>
      {detail ? (
        <p className={`mt-1 text-sm leading-5 ${colors.detail}`}>{detail}</p>
      ) : null}
      {href ? (
        <Link
          href={href}
          className={`mt-2 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2 ${colors.link}`}
        >
          {hrefLabel}
        </Link>
      ) : null}
    </div>
  );
}
