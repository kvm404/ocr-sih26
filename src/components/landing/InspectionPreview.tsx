import Image from "next/image";
import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

const DECLARATIONS = [
  { label: "Manufacturer details", value: "ITC Limited", ok: true },
  { label: "Net quantity", value: "5 kg", ok: true },
  { label: "MRP", value: "₹ 285.00", ok: true },
  { label: "Manufacturing date", value: "12 Mar 2026", ok: true },
  { label: "Consumer care", value: "Phone number not observed", ok: false },
];

const THUMBS = [
  { src: "/landing/atta-thumb-1.jpg", alt: "Front panel photograph" },
  { src: "/landing/atta-thumb-2.jpg", alt: "Side panel photograph" },
  { src: "/landing/atta-thumb-3.jpg", alt: "Back panel photograph" },
];

export default function InspectionPreview() {
  return (
    <article
      className="overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_24px_60px_-24px_rgba(15,23,42,0.28)]"
      aria-label="Sample inspection of Aashirvaad Whole Wheat Atta, labelled as a demonstration"
    >
      <div className="grid lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]">
        <div className="flex flex-col bg-[#F4F6FA] p-4 sm:p-5">
          <div className="relative mx-auto aspect-[3/4] w-full max-w-[220px] overflow-hidden rounded-xl bg-[#EEF1F6] outline outline-1 outline-black/10">
            <Image
              src="/landing/atta-pack.jpg"
              alt="5 kg whole wheat atta pack used in the sample inspection"
              fill
              className="object-contain p-2"
              sizes="220px"
              priority
            />
          </div>
          <ul className="mt-4 flex justify-center gap-2">
            {THUMBS.map((thumb) => (
              <li
                key={thumb.src}
                className="relative h-14 w-12 overflow-hidden rounded-md bg-white outline outline-1 outline-black/10"
              >
                <Image
                  src={thumb.src}
                  alt={thumb.alt}
                  fill
                  className="object-cover"
                  sizes="48px"
                />
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-4 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-xs font-medium whitespace-nowrap text-slate-500">
              <span className="h-2 w-2 rounded-full bg-[#1D4ED8]" aria-hidden="true" />
              Sample inspection
            </p>
            <p className="text-xs font-medium tracking-wide whitespace-nowrap text-slate-600">
              #NYP-2026-0017
            </p>
          </div>

          <div>
            <h2 className="text-lg font-bold tracking-tight text-balance text-slate-900 sm:text-[1.2rem]">
              Aashirvaad · Whole Wheat Atta
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">5 kg</p>
          </div>

          <section className="overflow-hidden rounded-xl border border-slate-200">
            <div className="border-b border-slate-100 bg-slate-50/80 px-3 py-2">
              <h3 className="text-xs font-semibold text-slate-700">
                Observed declarations
              </h3>
            </div>
            <ul>
              {DECLARATIONS.map((row) => (
                <li
                  key={row.label}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-2.5 last:border-b-0"
                >
                  <span className="inline-flex min-w-0 items-center gap-2 text-[13px] text-slate-700">
                    {row.ok ? (
                      <CheckCircle2
                        className="h-4 w-4 shrink-0 text-emerald-600"
                        aria-hidden="true"
                      />
                    ) : (
                      <AlertTriangle
                        className="h-4 w-4 shrink-0 text-amber-500"
                        aria-hidden="true"
                      />
                    )}
                    <span>{row.label}</span>
                  </span>
                  <span
                    className={`text-end text-[13px] font-medium ${
                      row.ok ? "text-slate-800" : "text-amber-700"
                    }`}
                  >
                    {row.value}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-slate-200 p-3">
            <h3 className="text-xs font-semibold text-slate-700">
              Rule assessment
            </h3>
            <div className="mt-3 flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  Consumer care details
                </p>
                <p className="text-xs text-slate-500">Rule 6(1)(f)</p>
                <p className="mt-1.5 inline-flex rounded-md bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800">
                  Suspected violation
                </p>
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  Phone number not observed in submitted photographs.
                </p>
              </div>
            </div>
          </section>

          <div className="mt-auto">
            <Link
              href="/scan"
              className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-[#1E293B] px-3 text-sm font-semibold whitespace-nowrap text-white hover:bg-slate-800"
            >
              Start an inspection
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
