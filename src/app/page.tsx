import Link from "next/link";
import Image from "next/image";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  Camera,
  CheckCircle2,
  ChevronRight,
  FileOutput,
  FileSearch,
  Factory,
  IndianRupee,
  Phone,
  Play,
  ScanLine,
  Scale,
  UserRound,
} from "lucide-react";
import InspectionPreview from "@/components/landing/InspectionPreview";

const STEPS = [
  {
    n: "01",
    title: "Capture",
    body: "Upload package photographs.",
    icon: Camera,
  },
  {
    n: "02",
    title: "Extract",
    body: "Identify and extract declarations using AI.",
    icon: ScanLine,
  },
  {
    n: "03",
    title: "Evaluate",
    body: "Check against supported Legal Metrology rules.",
    icon: FileSearch,
  },
  {
    n: "04",
    title: "Review",
    body: "Verify findings, correct values, and confirm.",
    icon: UserRound,
  },
  {
    n: "05",
    title: "Report",
    body: "Generate PDF or DOCX with the complete record.",
    icon: FileOutput,
  },
];

const CHECKS = [
  {
    title: "Manufacturer details",
    body: "Name and address of the manufacturer, packer, or importer.",
    icon: Factory,
  },
  {
    title: "Net quantity",
    body: "Declared quantity and the unit of measurement.",
    icon: Scale,
  },
  {
    title: "Maximum retail price",
    body: "MRP inclusive of all taxes, with the rupee mark.",
    icon: IndianRupee,
  },
  {
    title: "Manufacturing date",
    body: "Month and year of manufacture, where the reviewed rule requires it. Not a packing or import date check.",
    icon: Calendar,
  },
  {
    title: "Consumer care details",
    body: "A phone number, email, or address for complaints.",
    icon: Phone,
  },
];

const CHECK_COLUMNS = [CHECKS.slice(0, 3), CHECKS.slice(3)];

const RESULTS = [
  {
    title: "No issue found in assessed checks",
    body: "Checks that could be assessed showed no suspected violation. Unassessed checks are not passes.",
    icon: CheckCircle2,
    iconClass: "bg-emerald-50 text-emerald-700",
    titleClass: "text-emerald-800",
  },
  {
    title: "Suspected violation",
    body: "A possible problem. A reviewer confirms it before the report is saved.",
    icon: AlertTriangle,
    iconClass: "bg-red-50 text-red-800",
    titleClass: "text-red-800",
  },
  {
    title: "Insufficient evidence",
    body: "The photographs do not show enough to assess this check.",
    icon: FileSearch,
    iconClass: "bg-amber-50 text-amber-800",
    titleClass: "text-amber-800",
  },
];

export default function Home() {
  return (
    <div className="bg-white text-slate-900">
        <section
          id="product"
          className="scroll-mt-28 border-b border-slate-100"
        >
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:gap-12 lg:px-8 lg:py-16">
            <div className="max-w-xl">
              <h1 className="max-w-[16ch] text-[2.35rem] font-extrabold leading-[1.08] tracking-[-0.03em] text-slate-950 sm:text-5xl lg:text-[3.35rem]">
                From package photographs to a reviewed record.
              </h1>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/scan"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1E40AF]"
                >
                  Start an inspection
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                <a
                  href="#how-it-works"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-md border border-slate-300">
                    <Play className="h-2.5 w-2.5 fill-slate-800 text-slate-800" aria-hidden="true" />
                  </span>
                  See how it works
                </a>
              </div>
            </div>
            <InspectionPreview />
          </div>
        </section>

        <section
          id="how-it-works"
          className="scroll-mt-28 border-b border-slate-100 bg-white"
        >
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
                  How NyayaPack works
                </p>
                <h2 className="mt-3 max-w-[18ch] text-3xl font-extrabold tracking-[-0.03em] text-slate-950 sm:text-4xl">
                  A simpler inspection workflow.
                </h2>
              </div>
              <p className="max-w-sm text-sm leading-relaxed text-slate-500 lg:text-right">
                From a package photo to a complete, reviewable record — in a few
                clear steps.
              </p>
            </div>

            <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:gap-5">
              {STEPS.map((step, i) => (
                <li key={step.n} className="relative">
                  {i < STEPS.length - 1 ? (
                    <ChevronRight
                      className="pointer-events-none absolute top-8 -right-4 hidden h-4 w-4 text-slate-300 lg:block"
                      aria-hidden="true"
                    />
                  ) : null}
                  <div className="rounded-2xl border border-slate-100 bg-[#F8FAFC] px-4 py-5">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-[#1D4ED8] shadow-sm ring-1 ring-slate-100">
                      <step.icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <p className="mt-5 text-xs font-semibold tracking-wider text-slate-600">
                      {step.n}
                    </p>
                    <h3 className="mt-1 text-base font-bold text-slate-900">
                      {step.title}
                    </h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
                      {step.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="what-we-check" className="scroll-mt-28 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
            <p className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
              What we check
            </p>
            <h2 className="mt-3 max-w-[18ch] text-3xl font-extrabold tracking-[-0.03em] text-slate-950 sm:text-4xl">
              What each inspection looks for
            </h2>
            <p className="mt-4 max-w-[54ch] text-sm leading-relaxed text-slate-600 sm:text-base">
              Supported declarations from the Packaged Commodities Rules. If
              the photographs do not show a declaration, that check is not
              assessed.
            </p>

            <div className="mt-10 grid overflow-hidden rounded-2xl border border-slate-200 lg:grid-cols-2">
              {CHECK_COLUMNS.map((column, columnIndex) => (
                <ul
                  key={column.map((item) => item.title).join("-")}
                  className={`divide-y divide-slate-100 ${
                    columnIndex === 0 ? "lg:border-e lg:border-slate-200" : ""
                  }`}
                >
                  {column.map((check) => (
                    <li key={check.title} className="flex gap-3.5 px-5 py-4">
                      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-700 ring-1 ring-slate-200/80">
                        <check.icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">
                          {check.title}
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-slate-600">
                          {check.body}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ))}
            </div>

            <h3 className="mt-12 text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
              How a check can end
            </h3>
            <ul className="mt-4 grid overflow-hidden rounded-2xl border border-slate-200 md:grid-cols-3">
              {RESULTS.map((result, index) => (
                <li
                  key={result.title}
                  className={`flex gap-3 px-5 py-4 ${
                    index < RESULTS.length - 1
                      ? "border-b border-slate-200 md:border-e md:border-b-0"
                      : ""
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${result.iconClass}`}
                  >
                    <result.icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${result.titleClass}`}>
                      {result.title}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">
                      {result.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="relative overflow-hidden border-t border-slate-100">
          <div className="absolute inset-0">
            <Image
              src="/landing/label-closeup.jpg"
              alt=""
              fill
              className="object-cover object-right"
              sizes="100vw"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-white via-white/88 to-white/20 sm:via-white/80" />
          </div>
          <div className="relative mx-auto grid max-w-6xl items-center gap-8 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)] lg:px-8 lg:py-20">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
                Built for a fairer marketplace
              </p>
              <h2 className="mt-3 text-3xl font-extrabold tracking-[-0.03em] text-slate-950 sm:text-4xl">
                See it. Verify it. Ensure it.
              </h2>
              <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-slate-600 sm:text-base">
                NyayaPack is a prototype for Smart India Hackathon 2026 (Problem
                Statement 26034). Not for enforcement use.
              </p>
              <Link
                href="/scan"
                className="mt-7 inline-flex h-11 items-center gap-2 rounded-xl bg-[#1D4ED8] px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1E40AF]"
              >
                Start an inspection
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
            <p className="hidden max-w-[16ch] justify-self-end text-right text-lg font-semibold leading-snug text-slate-700 lg:block">
              Clearer inspections for a fairer tomorrow.
            </p>
          </div>
        </section>
    </div>
  );
}
