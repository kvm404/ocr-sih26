import type { ReactNode } from "react";

export type StatCardTone = "green" | "red" | "blue" | "amber";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  trend?: string;
  tone?: StatCardTone;
}

const toneStyles: Record<StatCardTone, string> = {
  green: "bg-green-100 text-green-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
  amber: "bg-amber-100 text-amber-800",
};

export default function StatCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  tone = "blue",
}: StatCardProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-600">{title}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
            {value}
          </p>
        </div>
        {icon ? (
          <span
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${toneStyles[tone]}`}
          >
            {icon}
          </span>
        ) : null}
      </div>
      {subtitle || trend ? (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-600">
          {trend ? (
            <span className="font-semibold text-slate-700">{trend}</span>
          ) : null}
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
