"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Download, Loader2, PackageSearch, ScanLine, Search } from "lucide-react";
import {
  isStorageAvailable,
  deleteEmptyDrafts,
  describeStoreError,
  listInspections,
  listLegacyReports,
} from "@/lib/store";
import { Notice, type NoticeCopy } from "@/components/Notice";
import {
  headlineFromLegacyStatus,
  headlineFromResults,
  normalizeHeadline,
  resolveEntryHeadline,
  resolveRealHeadline,
  type RealHeadline,
} from "@/lib/headlines";
import type { InspectionRecord, LegacyReportRef } from "@/lib/store";
import type { ReportHeadline } from "@/lib/types";

type HeadlineFilter = "All" | ReportHeadline;
type SortKey = "newest" | "oldest" | "photos-desc" | "photos-asc";

function CoverThumb({
  src,
  alt,
  unavailableLabel,
}: {
  src: string;
  alt: string;
  unavailableLabel: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex h-40 w-full flex-col items-center justify-center gap-1 bg-slate-50 px-4 text-center">
        <PackageSearch className="h-8 w-8 text-slate-300" />
        <p className="text-xs font-medium text-slate-500">{unavailableLabel}</p>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- stored Blob / unrestorable http URLs, not Next image optimizer
    <img
      src={src}
      alt={alt}
      className="h-40 w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

type UnifiedEntry = {
  key: string;
  kind: "inspection" | "legacy";
  title: string;
  subtitle: string;
  category: string;
  createdAt: string;
  headline: ReportHeadline;
  /** True until the reviewer confirms (review sidecar confirmedAt null). */
  isDraft: boolean;
  photoCount: number;
  evidenceUnavailable: boolean;
  imageUrl: string | null;
  reportId: string;
  statusNote: string;
};

const HEADLINE_OPTIONS: { value: HeadlineFilter; label: string }[] = [
  { value: "All", label: "All headlines" },
  { value: "suspected violation", label: "Suspected violation" },
  { value: "no issue found in assessed checks", label: "No issue found in assessed checks" },
  { value: "insufficient evidence", label: "Insufficient evidence" },
];

/**
 * Headline for a real IndexedDB inspection. When review state exists, the
 * headline comes from the real cited-rules evaluation
 * (`resolveRealHeadline`, draft or confirmed); otherwise the shared
 * tolerant resolution applies (honestly "insufficient evidence"). The
 * numeric internal score is never read here.
 */
function resolveInspectionHeadline(
  record: InspectionRecord,
  real?: RealHeadline | null,
): { headline: ReportHeadline; isDraft: boolean } {
  if (real) return { headline: real.headline, isDraft: real.isDraft };
  return { headline: resolveEntryHeadline(record), isDraft: false };
}

function inspectionToEntry(record: InspectionRecord, real?: RealHeadline | null): UnifiedEntry {
  const short = record.inspectionId.slice(0, 8);
  const { headline, isDraft } = resolveInspectionHeadline(record, real);
  return {
    key: `inspection:${record.inspectionId}`,
    kind: "inspection",
    title: `Inspection ${short}`,
    subtitle: `${record.photos.length} photo${record.photos.length === 1 ? "" : "s"} · ${record.status}`,
    category:
      typeof record.categoryHint === "string" && record.categoryHint.length > 0
        ? record.categoryHint
        : "unknown",
    createdAt: record.createdAt,
    headline,
    isDraft,
    photoCount: record.photos.length,
    evidenceUnavailable: record.photos.length === 0,
    imageUrl: null,
    reportId: record.inspectionId,
    statusNote: record.status,
  };
}

function legacyToEntry(ref: LegacyReportRef): UnifiedEntry {
  const raw =
    ref.raw !== null && typeof ref.raw === "object"
      ? (ref.raw as Record<string, unknown>)
      : {};
  const headline =
    normalizeHeadline(raw["headline"]) ??
    normalizeHeadline(raw["reportHeadline"]) ??
    normalizeHeadline(raw["overallHeadline"]) ??
    headlineFromResults(raw["ruleResults"] ?? raw["results"]) ??
    headlineFromResults(raw["checks"]) ??
    headlineFromLegacyStatus(raw["overallStatus"]) ??
    "insufficient evidence";
  const category =
    typeof raw["category"] === "string" && raw["category"].length > 0
      ? raw["category"]
      : "legacy";
  const createdAt =
    typeof ref.scannedAt === "string" && ref.scannedAt.length > 0
      ? ref.scannedAt
      : typeof raw["scannedAt"] === "string"
        ? (raw["scannedAt"] as string)
        : "";
  return {
    key: `legacy:${ref.id}`,
    kind: "legacy",
    title: ref.productName,
    subtitle: ref.brand,
    category,
    createdAt,
    headline,
    isDraft: false,
    photoCount: ref.evidenceUnavailable ? 0 : 1,
    evidenceUnavailable: ref.evidenceUnavailable,
    imageUrl: ref.evidenceUnavailable ? null : ref.imageUrl || null,
    reportId: ref.id,
    statusNote: "legacy report",
  };
}

function headlineBadge(headline: ReportHeadline): string {
  switch (headline) {
    case "suspected violation":
      return "bg-red-100 text-red-800";
    case "no issue found in assessed checks":
      return "bg-green-100 text-green-800";
    case "insufficient evidence":
      return "bg-amber-100 text-amber-800";
  }
}

function formatDate(value: string): string {
  if (!value) return "date unknown";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "date unknown";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function createdAtTime(value: string): number {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function toCsvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function RepositoryPage() {
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [legacy, setLegacy] = useState<LegacyReportRef[]>([]);
  const [realHeadlines, setRealHeadlines] = useState<Record<string, RealHeadline>>({});
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<NoticeCopy | null>(null);
  const [query, setQuery] = useState("");
  const [headline, setHeadline] = useState<HeadlineFilter>("All");
  const [category, setCategory] = useState<string>("All");
  const [sort, setSort] = useState<SortKey>("newest");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (!isStorageAvailable()) {
          if (!cancelled) {
            setInspections([]);
            setRealHeadlines({});
            setLegacy(listLegacyReports());
            setLoadError({
              title: "Browser storage is unavailable",
              detail: "Saved inspections cannot be listed in this browser.",
            });
          }
          return;
        }
        await deleteEmptyDrafts();
        const records = (await listInspections()).filter(
          (record) => record.photos.length > 0,
        );
        // Real per-record headlines from reviewer state (sync localStorage
        // reads resolved here so the loading state below covers them).
        const headlines: Record<string, RealHeadline> = {};
        for (const record of records) {
          try {
            const real = resolveRealHeadline(record.inspectionId, record.photos.length);
            if (real) headlines[record.inspectionId] = real;
          } catch {
            // One unreadable review must not hide the inspection; it falls
            // back to "insufficient evidence" below.
          }
        }
        if (!cancelled) {
          setInspections(records);
          setRealHeadlines(headlines);
          setLegacy(listLegacyReports());
        }
      } catch (err) {
        if (!cancelled) {
          setInspections([]);
          setRealHeadlines({});
          try {
            setLegacy(listLegacyReports());
          } catch {
            setLegacy([]);
          }
          setLoadError(describeStoreError(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cover thumbnails from real Blob bytes; revoked on change/unmount so no
  // invented image is ever shown and no object URL leaks. Object URLs are an
  // external browser resource, so syncing them here is the intended effect use.
  useEffect(() => {
    if (inspections.length === 0) {
      // Initial {} state already means "no thumbnails"; the previous effect
      // run's cleanup revoked any old object URLs.
      return;
    }
    const urls: Record<string, string> = {};
    for (const inspection of inspections) {
      const first = inspection.photos[0];
      if (first && first.blob instanceof Blob && first.blob.size > 0) {
        try {
          urls[inspection.inspectionId] = URL.createObjectURL(first.blob);
        } catch {
          // Leave the entry without a thumbnail; the card shows the
          // evidence-unavailable state instead of inventing an image.
        }
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URLs sync external browser resources (created + revoked here), not render state.
    setCoverUrls(urls);
    return () => {
      for (const url of Object.values(urls)) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Revocation is best-effort.
        }
      }
    };
  }, [inspections]);

  const inspectionEntries = useMemo<UnifiedEntry[]>(
    () => inspections.map((record) => inspectionToEntry(record, realHeadlines[record.inspectionId] ?? null)),
    [inspections, realHeadlines],
  );

  const legacyEntries = useMemo<UnifiedEntry[]>(
    () => legacy.map(legacyToEntry),
    [legacy],
  );

  // Search, filter, sort, and CSV describe IndexedDB inspections ONLY.
  // Legacy lm_reports entries are excluded and shown separately below.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of inspectionEntries) {
      if (e.category.length > 0) set.add(e.category);
    }
    return ["All", ...Array.from(set).sort()];
  }, [inspectionEntries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = inspectionEntries.filter((e) => {
      if (headline !== "All" && e.headline !== headline) return false;
      if (category !== "All" && e.category !== category) return false;
      if (
        q &&
        !e.title.toLowerCase().includes(q) &&
        !e.subtitle.toLowerCase().includes(q) &&
        !e.category.toLowerCase().includes(q) &&
        !e.reportId.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
    switch (sort) {
      case "newest":
        return [...list].sort((a, b) => createdAtTime(b.createdAt) - createdAtTime(a.createdAt));
      case "oldest":
        return [...list].sort((a, b) => createdAtTime(a.createdAt) - createdAtTime(b.createdAt));
      case "photos-desc":
        return [...list].sort((a, b) => b.photoCount - a.photoCount);
      case "photos-asc":
        return [...list].sort((a, b) => a.photoCount - b.photoCount);
    }
  }, [inspectionEntries, query, headline, category, sort]);

  function exportCsv() {
    // Real inspections only: legacy lm_reports entries are excluded (they
    // live in `legacyEntries`, never in `filtered`).
    const header = ["id", "kind", "title", "category", "headline", "draft", "photos", "evidence", "date"];
    const rows = filtered.map((e) =>
      [
        e.reportId,
        e.kind,
        e.title,
        e.category,
        e.headline,
        e.isDraft ? "draft" : "confirmed",
        e.photoCount,
        e.evidenceUnavailable ? "evidence unavailable" : "evidence available",
        e.createdAt ? new Date(e.createdAt).toISOString() : "",
      ]
        .map(toCsvCell)
        .join(","),
    );
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "repository-export.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-[-0.03em] text-slate-950">
            Saved inspections
          </h1>
          <p className="text-sm text-slate-600">
            {loading ? "Loading…" : `${filtered.length} inspection${filtered.length === 1 ? "" : "s"} found`} · real records only
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={loading || filtered.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          <Download className="h-4 w-4" /> Export CSV
        </button>
      </div>

      {loadError && !loading ? <Notice {...loadError} /> : null}

      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, ID, or category…"
            className="w-full rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <select
          value={headline}
          onChange={(e) => setHeadline(e.target.value as HeadlineFilter)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          aria-label="Filter by headline"
        >
          {HEADLINE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          aria-label="Filter by category"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === "All" ? "All categories" : c}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          aria-label="Sort inspections"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="photos-desc">Most photos</option>
          <option value="photos-asc">Fewest photos</option>
        </select>
      </div>

      {loading ? (
        <div
          className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading saved inspections…
        </div>
      ) : inspectionEntries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center">
          <PackageSearch className="h-10 w-10 text-slate-300" />
          <p className="font-medium text-slate-700">No inspections yet</p>
          <p className="max-w-md text-sm text-slate-500">
            Photograph a package to create the first inspection. Empty visits
            to the inspect page are not saved.
          </p>
          <Link
            href="/scan"
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            <ScanLine className="h-4 w-4" /> Start an inspection
          </Link>
        </div>
      ) : filtered.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((entry) => {
            const cover =
              entry.kind === "inspection"
                ? (coverUrls[entry.reportId] ?? null)
                : entry.imageUrl;
            return (
              <div
                key={entry.key}
                className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              >
                {cover ? (
                  <CoverThumb
                    src={cover}
                    alt={entry.title}
                    unavailableLabel="evidence unavailable — the original image cannot be restored"
                  />
                ) : (
                  <div className="flex h-40 w-full flex-col items-center justify-center gap-1 bg-slate-50 px-4 text-center">
                    <PackageSearch className="h-8 w-8 text-slate-300" />
                    <p className="text-xs font-medium text-slate-500">
                      {entry.evidenceUnavailable
                        ? "evidence unavailable — the original image cannot be restored"
                        : "no preview available"}
                    </p>
                  </div>
                )}
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-slate-900">{entry.title}</h3>
                      <p className="truncate text-sm text-slate-500">{entry.subtitle}</p>
                    </div>
                    <span className="shrink-0 rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                      {entry.photoCount} photo{entry.photoCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`rounded-md px-2 py-0.5 font-semibold ${headlineBadge(entry.headline)}`}
                    >
                      {entry.headline}
                    </span>
                    {entry.isDraft ? (
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold text-slate-600 ring-1 ring-inset ring-slate-300">
                        Draft
                      </span>
                    ) : null}
                    <span className="text-slate-400">{formatDate(entry.createdAt)}</span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {entry.category} · {entry.statusNote}
                    {entry.evidenceUnavailable ? " · evidence unavailable" : ""}
                  </p>
                  <Link
                    href={`/report/${entry.reportId}`}
                    className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
                  >
                    View Report <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center">
          <PackageSearch className="h-10 w-10 text-slate-300" />
          <p className="font-medium text-slate-700">No inspections found</p>
          <p className="text-sm text-slate-500">
            Try adjusting your search or filters.
          </p>
        </div>
      )}
      <p className="text-xs text-slate-400">
        Headlines only — no issue found in assessed checks, suspected violation, or insufficient
        evidence. The internal test score is never shown as a compliance result.
      </p>
      {!loading && legacyEntries.length > 0 && (
        <section
          aria-label="Older browser records"
          className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 shadow-sm"
        >
          <h2 className="font-semibold text-slate-900">
            Older browser records (evidence unavailable)
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {legacyEntries.length} older {legacyEntries.length === 1 ? "record" : "records"} from
            a previous app version. Their photographs cannot be restored after a reload, so they
            are excluded from the search, filters, and CSV export above.
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {legacyEntries.map((entry) => (
              <li
                key={entry.key}
                className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="min-w-0">
                  <h3 className="truncate font-semibold text-slate-900">{entry.title}</h3>
                  <p className="truncate text-sm text-slate-500">{entry.subtitle}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={`rounded-md px-2 py-0.5 font-semibold ${headlineBadge(entry.headline)}`}
                  >
                    {entry.headline}
                  </span>
                  <span className="text-slate-400">{formatDate(entry.createdAt)}</span>
                </div>
                <p className="text-xs text-slate-500">
                  {entry.category} · {entry.statusNote} · evidence unavailable
                </p>
                <Link
                  href={`/report/${entry.reportId}`}
                  className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
                >
                  View Report <ArrowRight className="h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
