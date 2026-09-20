import { AlertTriangle, CheckCircle2, XCircle, type LucideIcon } from "lucide-react";
import type { CheckStatus, ComplianceCheck } from "@/lib/types";

const STATUS_ICONS: Record<CheckStatus, LucideIcon> = {
  pass: CheckCircle2,
  fail: XCircle,
  warning: AlertTriangle,
};

const ICON_COLORS: Record<CheckStatus, string> = {
  pass: "text-green-600",
  fail: "text-red-600",
  warning: "text-amber-500",
};

const ROW_STYLES: Record<CheckStatus, string> = {
  pass: "border-green-200 bg-green-50/60",
  fail: "border-red-200 bg-red-50/60",
  warning: "border-amber-200 bg-amber-50/60",
};

export default function Checklist({ checks }: { checks: ComplianceCheck[] }) {
  if (!checks || checks.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
        No compliance checks available for this report.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {checks.map((check) => {
        const Icon = STATUS_ICONS[check.status] ?? AlertTriangle;
        const rowStyle = ROW_STYLES[check.status] ?? "border-slate-200 bg-white";
        const iconColor = ICON_COLORS[check.status] ?? "text-slate-400";
        return (
          <li key={check.id} className={`rounded-lg border p-4 ${rowStyle}`}>
            <div className="flex items-start gap-3">
              <Icon
                className={`mt-0.5 h-5 w-5 shrink-0 ${iconColor}`}
                aria-label={check.status}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900">{check.label}</span>
                  <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-[11px] font-medium text-white">
                    {check.ruleRef}
                  </span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{check.message}</p>
                {check.extractedText ? (
                  <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-2 font-mono text-xs leading-relaxed text-green-200">
                    &ldquo;{check.extractedText}&rdquo;
                  </pre>
                ) : null}
                {check.expected ? (
                  <p className="mt-1.5 text-xs text-slate-500">
                    <span className="font-medium">Expected:</span> {check.expected}
                  </p>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
