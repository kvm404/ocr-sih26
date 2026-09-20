"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Menu, X } from "lucide-react";
import { IndiaFlag, LogoMark } from "@/components/landing/marks";

const LANDING_NAV = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how-it-works" },
  { label: "What we check", href: "#what-we-check" },
  { label: "Repository", href: "/repository" },
];

const APP_NAV = [
  { label: "Home", href: "/" },
  { label: "Inspection", href: "/scan" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "Repository", href: "/repository" },
  { label: "Settings", href: "/settings" },
];

export default function Header() {
  const pathname = usePathname();
  const isLanding = pathname === "/";
  const onScan = pathname === "/scan";
  const nav = isLanding ? LANDING_NAV : APP_NAV;
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header className="no-print sticky top-0 z-50">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-900"
      >
        Skip to content
      </a>
      <div className="bg-[#0B1F3A] text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:px-8">
          <p className="flex min-w-0 items-center gap-2 text-xs font-medium tracking-wide text-slate-200">
            <IndiaFlag className="h-3.5 w-5 shrink-0 rounded-[1px] ring-1 ring-white/20" />
            <span className="truncate">
              SMART INDIA HACKATHON 2026
              <span className="hidden sm:inline"> · PROBLEM STATEMENT 26034</span>
            </span>
          </p>
          <p className="hidden items-center gap-2 text-xs text-slate-300 md:flex">
            Towards a fairer marketplace
            <IndiaFlag className="h-3.5 w-5 rounded-[1px] ring-1 ring-white/20" />
          </p>
        </div>
      </div>

      <div className="border-b border-slate-200/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-[4.25rem] max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <LogoMark className="h-8 w-8" />
            <span className="leading-tight">
              <span className="block text-[1.15rem] font-extrabold tracking-tight text-slate-900">
                NyayaPack
              </span>
              <span className="block text-xs font-medium tracking-wide text-slate-500">
                see. verify. ensure.
              </span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
            {nav.map((item) => {
              const current = !item.href.startsWith("#") && pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-slate-50 hover:text-slate-900 ${
                    current ? "bg-slate-100 text-slate-900" : "text-slate-600"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            {onScan ? null : (
              <Link
                href="/scan"
                className="hidden h-10 items-center gap-1.5 rounded-xl bg-[#1D4ED8] ps-4 pe-3.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1E40AF] sm:inline-flex"
              >
                Start an inspection
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}
            <button
              type="button"
              ref={menuButtonRef}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 lg:hidden"
              aria-expanded={open}
              aria-controls="site-mobile-nav"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? (
                <X className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Menu className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {open ? (
          <nav
            id="site-mobile-nav"
            className="border-t border-slate-200 bg-white px-4 py-3 lg:hidden"
            aria-label="Mobile"
          >
            {nav.map((item) => {
              const current = !item.href.startsWith("#") && pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  aria-current={current ? "page" : undefined}
                  className={`block rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-slate-50 ${
                    current ? "bg-slate-100 text-slate-900" : "text-slate-700"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {onScan ? null : (
              <Link
                href="/scan"
                onClick={() => setOpen(false)}
                className="mt-2 block rounded-xl bg-[#1D4ED8] px-3 py-2.5 text-center text-sm font-semibold text-white sm:hidden"
              >
                Start an inspection
              </Link>
            )}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
