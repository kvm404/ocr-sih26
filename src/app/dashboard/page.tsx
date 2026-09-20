"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  ScanLine,
  Search,
} from "lucide-react";
import StatCard from "@/components/StatCard";
import { Notice, type NoticeCopy } from "@/components/Notice";
import {
  headlineFromLegacyStatus,
  headlineFromResults,
  normalizeHeadline,
  resolveEntryHeadline,
  resolveRealHeadline,
  type RealHeadline,
} from "@/lib/headlines";
import {
  deleteEmptyDrafts,
  describeStoreError,
  isStorageAvailable,
  listInspections,
  listLegacyReports,
} from "@/lib/store";
import type { InspectionRecord, LegacyReportRef } from "@/lib/store";
import type { ReportHeadline } from "@/lib/types";

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
  /** Restorable legacy image URL (http/data:). Null for inspections (Blob URLs) or unrestorable legacy. */
  imageUrl: string | null;
  reportId: string;
  statusNote: string;
  violationLabels: string[];
};

function violationLabelsFromHonestResults(results: unknown): string[] {
  if (!Array.isArray(results)) return [];
  const out: string[] = [];
  for (const item of results) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.result !== "suspected_violation") continue;
    const label =
      typeof rec.label === "string" && rec.label.trim().length > 0
        ? rec.label.trim()
        : typeof rec.ruleId === "string" && rec.ruleId.length > 0
          ? rec.ruleId
          : null;
    if (label) out.push(label);
  }
  return out;
}

/**
 * Headline + violation labels for a real IndexedDB inspection. When review
 * state exists, the headline and labels come from the real cited-rules
 * evaluation (`resolveRealHeadline`); otherwise the shared tolerant
 * resolution applies (honestly "insufficient evidence"). The numeric
 * internal score is never read here.
 */
function resolveInspectionHeadline(
  record: InspectionRecord,
  real?: RealHeadline | null,
): {
  headline: ReportHeadline;
  violationLabels: string[];
  isDraft: boolean;
} {
  if (real) {
    return {
      headline: real.headline,
      violationLabels: violationLabelsFromHonestResults(real.results),
      isDraft: real.isDraft,
    };
  }
  const headline = resolveEntryHeadline(record);
  const rec = record as unknown as Record<string, unknown>;
  const labels: string[] = [];
  for (const key of ["ruleResults", "results", "rule_results"]) {
    labels.push(...violationLabelsFromHonestResults(rec[key]));
  }
  const checks = rec["checks"];
  if (Array.isArray(checks)) {
    labels.push(...violationLabelsFromHonestResults(checks));
    for (const item of checks) {
      if (item === null || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      if (c["status"] === "fail" && typeof c["label"] === "string" && c["label"].trim()) {
        labels.push(c["label"].trim());
      }
    }
  }
  return { headline, violationLabels: labels, isDraft: false };
}

function inspectionToEntry(record: InspectionRecord, real?: RealHeadline | null): UnifiedEntry {
  const { headline, violationLabels, isDraft } = resolveInspectionHeadline(record, real);
  const short = record.inspectionId.slice(0, 8);
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
    violationLabels,
  };
}

function legacyToEntry(ref: LegacyReportRef): UnifiedEntry {
  const raw =
    ref.raw !== null && typeof ref.raw === "object"
      ? (ref.raw as Record<string, unknown>)
      : {};
  const explicit =
    normalizeHeadline(raw["headline"]) ??
    normalizeHeadline(raw["reportHeadline"]) ??
    normalizeHeadline(raw["overallHeadline"]);
  const honest = headlineFromResults(raw["ruleResults"] ?? raw["results"]);
  const legacyMapped = headlineFromLegacyStatus(raw["overallStatus"]);
  const headline = explicit ?? honest ?? legacyMapped ?? "insufficient evidence";

  const violationLabels: string[] = [...violationLabelsFromHonestResults(raw["ruleResults"] ?? raw["results"])];
  const checks = raw["checks"];
  if (Array.isArray(checks)) {
    violationLabels.push(...violationLabelsFromHonestResults(checks));
    for (const item of checks) {
      if (item === null || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      if (c["status"] === "fail" && typeof c["label"] === "string" && c["label"].trim()) {
        violationLabels.push(c["label"].trim());
      }
    }
  }

  const category = typeof raw["category"] === "string" && raw["category"].length > 0 ? raw["category"] : "legacy";
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
    violationLabels,
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

function headlineLabel(headline: ReportHeadline): string {
  switch (headline) {
    case "suspected violation":
      return "Suspected violation";
    case "no issue found in assessed checks":
      return "No issue found";
    case "insufficient evidence":
      return "Insufficient evidence";
  }
}

function categoryLabel(category: string): string {
  switch (category) {
    case "auto":
    case "unknown":
    case "":
      return "Not set";
    case "food-beverages":
      return "Food and beverages";
    case "personal-care":
      return "Personal care";
    case "household":
      return "Household products";
    case "other":
      return "Other";
    case "legacy":
      return "Older record";
    default:
      return category;
  }
}

function isDraftEntry(entry: UnifiedEntry): boolean {
  return entry.isDraft || entry.statusNote === "draft";
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

export default function DashboardPage() {
  const [inspections, setInspections] = useState<InspectionRecord[]>([]);
  const [legacy, setLegacy] = useState<LegacyReportRef[]>([]);
  const [realHeadlines, setRealHeadlines] = useState<Record<string, RealHeadline>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<NoticeCopy | null>(null);
  const [query, setQuery] = useState("");

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

  const inspectionEntries = useMemo<UnifiedEntry[]>(
    () => inspections.map((record) => inspectionToEntry(record, realHeadlines[record.inspectionId] ?? null)),
    [inspections, realHeadlines],
  );

  const legacyEntries = useMemo<UnifiedEntry[]>(
    () => legacy.map(legacyToEntry),
    [legacy],
  );

  // Totals, charts, and recent views describe IndexedDB inspections ONLY.
  // Legacy lm_reports entries are excluded and shown separately below.
  const stats = useMemo(() => {
    const total = inspectionEntries.length;
    const suspected = inspectionEntries.filter((e) => e.headline === "suspected violation").length;
    const noIssue = inspectionEntries.filter((e) => e.headline === "no issue found in assessed checks").length;
    const insufficient = inspectionEntries.filter((e) => e.headline === "insufficient evidence").length;
    return { total, suspected, noIssue, insufficient };
  }, [inspectionEntries]);

  const mixRows = useMemo(
    () =>
      [
        {
          key: "insufficient" as const,
          label: "Insufficient evidence",
          value: stats.insufficient,
          bar: "bg-amber-500",
        },
        {
          key: "noIssue" as const,
          label: "No issue found",
          value: stats.noIssue,
          bar: "bg-green-600",
        },
        {
          key: "suspected" as const,
          label: "Suspected violation",
          value: stats.suspected,
          bar: "bg-red-600",
        },
      ],
    [stats],
  );

  const violationsByType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of inspectionEntries) {
      for (const label of entry.violationLabels) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [inspectionEntries]);

  const recent = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? inspectionEntries.filter((e) => {
          const hay = [
            e.title,
            e.subtitle,
            e.category,
            categoryLabel(e.category),
            e.reportId,
            e.headline,
            headlineLabel(e.headline),
          ]
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : inspectionEntries;
    return [...filtered]
      .sort((a, b) => createdAtTime(b.createdAt) - createdAtTime(a.createdAt))
      .slice(0, 8);
  }, [inspectionEntries, query]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.03em] text-slate-950 sm:text-3xl">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Inspections saved on this device.
        </p>
      </div>

      {loading ? (
        <div
          className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading saved inspections…
        </div>
      ) : null}

      {loadError && !loading ? <Notice {...loadError} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          title="Inspections"
          value={loading ? "…" : stats.total}
          subtitle="On this device"
          icon={<ScanLine className="h-4 w-4" aria-hidden="true" />}
          tone="blue"
        />
        <StatCard
          title="Suspected violations"
          value={loading ? "…" : stats.suspected}
          subtitle="From reviewed checks"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
          tone="red"
        />
        <StatCard
          title="No issue found"
          value={loading ? "…" : stats.noIssue}
          subtitle="In assessed checks"
          icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
          tone="green"
        />
        <StatCard
          title="Insufficient evidence"
          value={loading ? "…" : stats.insufficient}
          subtitle="Not assessed yet"
          icon={<Clock className="h-4 w-4" aria-hidden="true" />}
          tone="amber"
        />
      </div>

      {!loading && stats.total > 0 ? (
        <div
          className={`grid grid-cols-1 gap-4 ${
            violationsByType.length > 0 ? "lg:grid-cols-2" : ""
          }`}
        >
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Headline mix</h2>
            <ul className="mt-3 space-y-3">
              {mixRows.map((row) => {
                const pct =
                  stats.total === 0
                    ? 0
                    : Math.round((row.value / stats.total) * 100);
                return (
                  <li key={row.key}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-slate-700">{row.label}</span>
                      <span className="tabular-nums font-medium text-slate-900">
                        {row.value}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-md bg-slate-100">
                      <div
                        className={`h-2 rounded-md ${row.bar}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
          {violationsByType.length > 0 ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">
                Suspected violations by check
              </h2>
              <ul className="mt-3 divide-y divide-slate-100">
                {violationsByType.map((row) => (
                  <li
                    key={row.name}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="min-w-0 text-slate-700">{row.name}</span>
                    <span className="tabular-nums font-medium text-slate-900">
                      {row.value}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Recent inspections
            </h2>
            {!loading && inspectionEntries.length > recent.length ? (
              <p className="mt-0.5 text-xs text-slate-600">
                Showing {recent.length} of {inspectionEntries.length}.{" "}
                <Link
                  href="/repository"
                  className="font-medium text-blue-800 underline-offset-2 hover:underline"
                >
                  Open repository
                </Link>
              </p>
            ) : null}
          </div>
          {inspectionEntries.length > 0 ? (
            <div className="relative w-full sm:max-w-xs">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <label htmlFor="dashboard-filter" className="sr-only">
                Filter inspections
              </label>
              <input
                id="dashboard-filter"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by id, category, or headline"
                className="min-h-11 w-full rounded-lg border border-slate-300 py-2 pr-3 pl-9 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              />
            </div>
          ) : null}
        </div>

        {loading ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading saved inspections…
          </p>
        ) : inspectionEntries.length === 0 ? (
          <div className="py-10 text-center">
            <p className="font-medium text-slate-800">No inspections yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
              Photograph a package to create the first record. Empty visits are
              not saved.
            </p>
            <Link
              href="/scan"
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[#1D4ED8] px-4 text-sm font-semibold text-white hover:bg-[#1E40AF]"
            >
              <ScanLine className="h-4 w-4" aria-hidden="true" />
              Start an inspection
            </Link>
          </div>
        ) : recent.length === 0 ? (
          <p className="mt-6 text-center text-sm text-slate-600">
            No inspections match this filter.
          </p>
        ) : (
          <>
            <ul className="mt-4 space-y-2 md:hidden">
              {recent.map((entry) => (
                <li key={entry.key}>
                  <Link
                    href={`/report/${entry.reportId}`}
                    className="flex min-h-11 flex-col gap-1 rounded-xl border border-slate-200 px-3 py-3 hover:bg-slate-50"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-medium text-slate-900">
                        {entry.title}
                      </span>
                      <span
                        className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${headlineBadge(entry.headline)}`}
                      >
                        {headlineLabel(entry.headline)}
                      </span>
                    </span>
                    <span className="text-sm text-slate-600">
                      {formatDate(entry.createdAt)}
                      {" · "}
                      {entry.evidenceUnavailable
                        ? "Evidence unavailable"
                        : `${entry.photoCount} photo${entry.photoCount === 1 ? "" : "s"}`}
                      {" · "}
                      {categoryLabel(entry.category)}
                      {isDraftEntry(entry) ? " · Draft" : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="mt-3 hidden overflow-x-auto md:block">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-600">
                    <th className="py-2 pr-4 font-medium">Inspection</th>
                    <th className="py-2 pr-4 font-medium">Category</th>
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Photos</th>
                    <th className="py-2 font-medium">Headline</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((entry) => (
                    <tr
                      key={entry.key}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/report/${entry.reportId}`}
                          className="font-medium text-blue-800 underline-offset-2 hover:underline"
                        >
                          {entry.title}
                        </Link>
                        {isDraftEntry(entry) ? (
                          <span className="ml-2 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-300">
                            Draft
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {categoryLabel(entry.category)}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {formatDate(entry.createdAt)}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {entry.evidenceUnavailable
                          ? "Unavailable"
                          : `${entry.photoCount} photo${entry.photoCount === 1 ? "" : "s"}`}
                      </td>
                      <td className="py-2.5">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${headlineBadge(entry.headline)}`}
                        >
                          {headlineLabel(entry.headline)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {!loading && legacyEntries.length > 0 ? (
        <section
          aria-label="Older browser records"
          className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4"
        >
          <h2 className="text-sm font-semibold text-slate-900">
            Older browser records
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {legacyEntries.length} older{" "}
            {legacyEntries.length === 1 ? "record" : "records"} from a previous
            app version. Photographs cannot be restored, so they are left out of
            the totals above.
          </p>
          <ul className="mt-3 space-y-2">
            {legacyEntries.map((entry) => (
              <li key={entry.key}>
                <Link
                  href={`/report/${entry.reportId}`}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-900">
                      {entry.title}
                    </span>
                    <span className="block truncate text-xs text-slate-600">
                      {formatDate(entry.createdAt)} · Evidence unavailable
                    </span>
                  </span>
                  <span className="shrink-0 font-medium text-blue-800">
                    Open
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
