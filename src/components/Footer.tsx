"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IndiaFlag, LogoMark } from "@/components/landing/marks";

const LANDING_LINKS = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how-it-works" },
  { label: "What we check", href: "#what-we-check" },
  { label: "Repository", href: "/repository" },
  { label: "GitHub", href: "https://github.com/kvm404/ocr-sih26" },
];

const APP_LINKS = [
  { label: "Home", href: "/" },
  { label: "Inspection", href: "/scan" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "Repository", href: "/repository" },
  { label: "Settings", href: "/settings" },
  { label: "GitHub", href: "https://github.com/kvm404/ocr-sih26" },
];

export default function Footer() {
  const pathname = usePathname();
  const links = pathname === "/" ? LANDING_LINKS : APP_LINKS;

  return (
    <footer className="no-print border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <LogoMark className="h-8 w-8" />
          <span className="leading-tight">
            <span className="block text-[1.05rem] font-extrabold tracking-tight text-slate-900">
              NyayaPack
            </span>
            <span className="block text-xs font-medium text-slate-500">
              see. verify. ensure.
            </span>
          </span>
        </Link>

        <nav
          className="flex flex-wrap items-center gap-x-6 gap-y-2"
          aria-label="Footer"
        >
          {links.map((item) => (
            <Link
              key={item.href + item.label}
              href={item.href}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
              {...(item.href.startsWith("http")
                ? {
                    target: "_blank",
                    rel: "noreferrer",
                    "aria-label": "NyayaPack on GitHub, opens in a new window",
                  }
                : {})}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <p className="flex items-center gap-2 text-sm text-slate-500">
          Made for Bharat
          <IndiaFlag className="h-3.5 w-5 rounded-[1px] ring-1 ring-slate-200" />
          <span className="text-slate-600">SIH 2026</span>
        </p>
      </div>
    </footer>
  );
}
