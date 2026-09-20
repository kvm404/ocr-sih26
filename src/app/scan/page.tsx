"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Play } from "lucide-react";
import UploadZone, { type UploadZonePhoto } from "@/components/UploadZone";
import ReviewPanel, {
  buildReviewedInputs,
  type ReviewState,
} from "@/components/ReviewPanel";
import { Notice, type NoticeCopy } from "@/components/Notice";
import { photoBlobToJpegDataUrl } from "@/lib/image";
import { saveReview } from "@/lib/review-store";
import { analyzePackage, describeModelError } from "@/lib/model-client";
import { errorDetail, log } from "@/lib/log";
import type { ExtractionResult } from "@/lib/observations";
import { computeHeadline, evaluateRules } from "@/lib/rules";
import {
  addPhotos,
  createInspection,
  describeStoreError,
  isStorageAvailable,
  removePhoto,
  saveInspection,
} from "@/lib/store";
import type { InspectionRecord } from "@/lib/store";
import type { CategoryHint } from "@/lib/store";
import type { ImportStatus, ReportHeadline, RuleResult } from "@/lib/types";

function noticeFromModel(err: unknown): NoticeCopy {
  const copy = describeModelError(err);
  return {
    title: copy.title,
    detail: copy.detail,
    href: copy.offerSettings ? "/settings" : undefined,
    hrefLabel: copy.offerSettings ? "Open Settings" : undefined,
  };
}

/** Store-hint value -> display label for the model prompt. */
function hintToModelLabel(hint: string): string {
  switch (hint) {
    case "food-beverages":
      return "Food and beverages";
    case "personal-care":
      return "Personal care";
    case "household":
      return "Household products";
    case "other":
      return "Other";
    default:
      return "Auto-detect";
  }
}

/**
 * Resolve the rules-context category in store-hint form. A manual hint wins;
 * otherwise a confident model suggestion maps back to hint form; anything
 * else stays "unknown" (the rules engine treats hyphenated broad hints and
 * "unknown" as unsettled for the date check — see rules.ts).
 */
function toCtxCategory(
  manualHint: string,
  suggestion: string | null,
  uncertain: boolean,
): string {
  if (manualHint && manualHint !== "auto") return manualHint;
  if (!uncertain && suggestion) {
    const n = suggestion
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ");
    if (n.includes("food")) return "food-beverages";
    if (n.includes("personal") || n.includes("cosmet")) return "personal-care";
    if (n.includes("household")) return "household";
    if (n === "other") return "other";
  }
  return "unknown";
}

export default function ScanPage() {
  const router = useRouter();
  const urlsRef = useRef<Record<string, string>>({});

  const [record, setRecord] = useState<InspectionRecord | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [hint, setHint] = useState<string>("auto");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<NoticeCopy | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [ruleResults, setRuleResults] = useState<RuleResult[]>([]);
  const [headline, setHeadline] = useState<ReportHeadline>("insufficient evidence");
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [stage, setStage] = useState<"photos" | "review">("photos");

  const creatingRef = useRef<Promise<InspectionRecord> | null>(null);

  useEffect(() => {
    if (!isStorageAvailable()) {
      setError({
        title: "Browser storage is unavailable",
        detail: "Photos cannot be saved in this browser.",
      });
    }
  }, []);

  // Revoke preview URLs on unmount.
  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    urlsRef.current = photoUrls;
  }, [photoUrls]);

  const uploadPhotos: UploadZonePhoto[] = useMemo(() => {
    if (!record) return [];
    const faces = new Map(
      (extraction?.photoFaces ?? []).map((face) => [face.photoId, face.face] as const),
    );
    return record.photos.map((photo) => ({
      photoId: photo.photoId,
      url: photoUrls[photo.photoId] ?? "",
      name: photo.name,
      face: faces.get(photo.photoId),
    }));
  }, [record, photoUrls, extraction]);

  function resetAnalysis(reason: string) {
    setExtraction(null);
    setReview(null);
    setRuleResults([]);
    setHeadline("insufficient evidence");
    setConfirmedAt(null);
    setNotice(reason);
    setStage("photos");
  }

  function handleHintChange(next: string) {
    setHint(next);
    if (record) {
      const updated = { ...record, categoryHint: next as CategoryHint };
      setRecord(updated);
      // Changing the category invalidates the analysis it was based on.
      if (extraction) resetAnalysis("Category changed — run the analysis again.");
      saveInspection(updated).catch(() => {
        // Non-fatal: the in-memory record still drives this session.
      });
    }
  }

  async function ensureRecord(): Promise<InspectionRecord> {
    if (record) return record;
    if (!creatingRef.current) {
      creatingRef.current = createInspection({
        categoryHint: hint as CategoryHint,
      });
    }
    try {
      const created = await creatingRef.current;
      setRecord(created);
      return created;
    } catch (err) {
      creatingRef.current = null;
      throw err;
    }
  }

  async function handleFilesSelect(files: File[]) {
    if (analyzing || confirming || files.length === 0) return;
    setError(null);
    try {
      const current = await ensureRecord();
      const added = await addPhotos(current.inspectionId, files);
      const urls: Record<string, string> = {};
      for (const photo of added.photos) {
        urls[photo.photoId] = URL.createObjectURL(photo.blob);
      }
      setPhotoUrls((prev) => ({ ...prev, ...urls }));
      setRecord({
        ...current,
        photos: [...current.photos, ...added.photos],
        updatedAt: added.updatedAt,
      });
      log.info("scan", "photos_saved", "Photographs stored for this inspection", {
        data: {
          inspectionId: current.inspectionId,
          added: added.photos.length,
          total: current.photos.length + added.photos.length,
        },
      });
      if (extraction) {
        resetAnalysis("Photos changed — run the analysis again on the new set.");
      }
    } catch (err) {
      const detail = errorDetail(err);
      log.error("scan", "photos_save_failed", detail.message, {
        code: detail.code,
        data: { count: files.length },
      });
      setError(describeStoreError(err));
    }
  }

  async function handleRemovePhoto(photoId: string) {
    if (!record || analyzing || confirming) return;
    setError(null);
    try {
      const updated = await removePhoto(record.inspectionId, photoId);
      const url = photoUrls[photoId];
      if (url) URL.revokeObjectURL(url);
      setPhotoUrls((prev) => {
        const next = { ...prev };
        delete next[photoId];
        return next;
      });
      setRecord(updated);
      if (extraction) {
        resetAnalysis("Photos changed — run the analysis again on the new set.");
      }
    } catch (err) {
      setError({
        title: "Photo was not removed",
        detail: describeStoreError(err).detail,
      });
    }
  }

  function runRules(
    observations: ExtractionResult["observations"],
    correctedTexts: Record<string, string>,
    category: string,
    importStatus: ImportStatus,
    coverageConfirmed: boolean,
    photoCount: number,
  ): { results: RuleResult[]; headline: ReportHeadline } {
    const inputs = buildReviewedInputs(observations, correctedTexts);
    const results = evaluateRules(inputs, {
      category,
      importStatus,
      coverageConfirmed,
      photoCount,
    });
    return { results, headline: computeHeadline(results) };
  }

  function persistReviewPayload(
    inspectionId: string,
    parsed: ExtractionResult,
    state: ReviewState,
    confirmedAtValue: string | null,
  ) {
    saveReview(inspectionId, {
      observations: parsed.observations,
      correctedTexts: state.correctedTexts,
      reviewedCategory: state.reviewedCategory,
      reviewedImport: state.reviewedImport,
      coverageConfirmed: state.coverageConfirmed,
      decisions: state.decisions,
      confirmedAt: confirmedAtValue,
      productName: state.productName || parsed.identity.productName,
      brand: state.brand || parsed.identity.brand,
      photoFaces: parsed.photoFaces,
      samePackage: parsed.identity.samePackage,
      mismatchNote: parsed.identity.mismatchNote,
    });
  }

  async function handleAnalyze() {
    if (!record || analyzing || confirming) return;
    if (record.photos.length === 0) {
      setError({ title: "Add a photograph first" });
      return;
    }
    setError(null);
    setNotice(null);
    setAnalyzing(true);
    log.info("scan", "analyze_start", "Running vision analysis", {
      data: {
        inspectionId: record.inspectionId,
        photoCount: record.photos.length,
        hint,
      },
    });
    setAnalyzeProgress(
      record.photos.length > 1
        ? `Analyzing photo 1 of ${record.photos.length}…`
        : "Analyzing photo…",
    );
    try {
      // Real upload bytes -> normalized JPEG data URLs -> vision model.
      // Originals stay untouched in IndexedDB; only the transmitted copy is
      // re-encoded (phone HEIC/WebP fail server-side otherwise). No fallback text.
      // Each photograph is analysed on its own, then merged, so a front face
      // (brand/product) is not dropped when a back face carries the legal block.
      const modelPhotos = [];
      for (const photo of record.photos) {
        modelPhotos.push({ id: photo.photoId, dataUrl: await photoBlobToJpegDataUrl(photo.blob) });
      }
      const parsed = await analyzePackage(modelPhotos, hintToModelLabel(hint), {
        onProgress: (done, total) => {
          if (done < total) setAnalyzeProgress(`Analyzing photo ${done + 1} of ${total}…`);
          else setAnalyzeProgress("Combining photographs…");
        },
      });

      const hasIdentity = Boolean(parsed.identity.brand || parsed.identity.productName);
      const anyAttested = parsed.unattestedPhotoIds.length < record.photos.length;
      if (parsed.observations.length === 0 && !hasIdentity && !anyAttested) {
        setError({
          title: "Nothing readable in these photos",
          detail:
            "Try clearer, well-lit views of the front and the information panel, then run the analysis again.",
        });
        return;
      }

      const ctxCategory = toCtxCategory(hint, parsed.categorySuggestion, parsed.categoryUncertain);
      const initialReview: ReviewState = {
        correctedTexts: {},
        reviewedCategory: ctxCategory,
        reviewedImport: parsed.importSuggestion,
        coverageConfirmed: false,
        decisions: {},
        productName: parsed.identity.productName ?? "",
        brand: parsed.identity.brand ?? "",
        samePackageConfirmed: false,
      };
      // Draft evaluation: coverage unconfirmed, so nothing can be called
      // missing yet — absent declarations stay "not assessed".
      const { results, headline: draftHeadline } = runRules(
        parsed.observations,
        {},
        ctxCategory,
        parsed.importSuggestion,
        false,
        record.photos.length,
      );
      setExtraction(parsed);
      setReview(initialReview);
      setRuleResults(results);
      setHeadline(draftHeadline);
      setConfirmedAt(null);

      const analyzed = await saveInspection({
        ...record,
        categoryHint: hint as CategoryHint,
        status: "analyzed",
      });
      setRecord(analyzed);
      persistReviewPayload(record.inspectionId, parsed, initialReview, null);
      setStage("review");
      window.scrollTo(0, 0);
      log.info("scan", "analyze_ok", "Analysis stored as a draft review", {
        data: {
          inspectionId: record.inspectionId,
          observationCount: parsed.observations.length,
          headline: draftHeadline,
        },
      });
    } catch (err) {
      // ModelClientError carries the honest server/connectivity reason.
      // No report is created and there is no navigation.
      const detail = errorDetail(err);
      log.error("scan", "analyze_failed", detail.message, {
        code: detail.code,
        data: { inspectionId: record.inspectionId },
      });
      setError(noticeFromModel(err));
    } finally {
      setAnalyzing(false);
      setAnalyzeProgress(null);
    }
  }

  function handleReviewChange(next: ReviewState) {
    if (!record || !extraction) return;
    setReview(next);
    // Re-run rules on every reviewer change; coverage=true only after the
    // reviewer checks the box, so missing requires coverage.
    const { results, headline: nextHeadline } = runRules(
      extraction.observations,
      next.correctedTexts,
      next.reviewedCategory,
      next.reviewedImport,
      next.coverageConfirmed,
      record.photos.length,
    );
    setRuleResults(results);
    setHeadline(nextHeadline);
    persistReviewPayload(record.inspectionId, extraction, next, null);
  }

  const confirmBlockers = useMemo(() => {
    if (!record || !extraction || !review) return ["Run the analysis first."];
    const blockers: string[] = [];
    if (!review.coverageConfirmed) {
      blockers.push("Confirm that the relevant package sides were photographed.");
    }
    if (extraction.unattestedPhotoIds.length > 0) {
      blockers.push(
        "One or more photos contributed nothing to this analysis — re-run the analysis or remove the ignored photo before confirming.",
      );
    }
    if (extraction.identity.samePackage === false && !review.samePackageConfirmed) {
      blockers.push("Confirm that these photographs are the same physical package.");
    }
    const undecided = ruleResults.filter(
      (result) =>
        result.result === "suspected_violation" &&
        review.decisions[result.ruleId] === undefined,
    );
    if (undecided.length > 0) {
      blockers.push(
        `Accept or reject each suspected violation (${undecided.length} undecided).`,
      );
    }
    return blockers;
  }, [record, extraction, review, ruleResults]);

  async function handleConfirm() {
    if (!record || !extraction || !review || confirming) return;
    if (confirmBlockers.length > 0) return;
    setError(null);
    setConfirming(true);
    try {
      const at = new Date().toISOString();
      const confirmed = await saveInspection({
        ...record,
        categoryHint: review.reviewedCategory as CategoryHint,
        status: "confirmed",
      });
      setRecord(confirmed);
      persistReviewPayload(record.inspectionId, extraction, review, at);
      setConfirmedAt(at);
      router.push(`/report/${record.inspectionId}`);
    } catch (err) {
      setError({
        title: "Confirmation was not saved",
        detail: describeStoreError(err).detail,
      });
      setConfirming(false);
    }
  }

  const busy = analyzing || confirming;
  const photoCount = record?.photos.length ?? 0;
  const onReview = stage === "review" && extraction !== null && review !== null;
  const showMobileDock = !onReview && !confirmedAt;
  const currentStep =
    confirmedAt !== null ? 4 : extraction !== null ? 2 : photoCount > 0 ? 1 : 0;

  const analyzeButton = (
    <button
      type="button"
      onClick={handleAnalyze}
      disabled={busy || photoCount === 0}
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#1E40AF] disabled:cursor-not-allowed disabled:bg-slate-300"
    >
      {analyzing ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {analyzeProgress ?? "Analyzing photos…"}
        </>
      ) : (
        <>
          <Play className="h-4 w-4" aria-hidden="true" />
          Analyze with vision model
        </>
      )}
    </button>
  );

  return (
    <div
      className={`mx-auto max-w-5xl px-4 pt-4 sm:px-6 sm:pt-8 lg:px-8 lg:pb-8 ${
        showMobileDock ? "pb-28" : "pb-8"
      }`}
    >
      {onReview ? (
        <>
          <div className="mb-4 sm:mb-6">
            <button
              type="button"
              onClick={() => setStage("photos")}
              className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-slate-700 hover:text-slate-900"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to photos
            </button>
            <h1 className="mt-3 text-2xl font-extrabold tracking-[-0.03em] text-slate-950 sm:text-3xl">
              Review findings
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Check each reading against its photograph, then confirm the
              report.
            </p>
          </div>
          {error ? (
            <div className="mb-4">
              <Notice {...error} />
            </div>
          ) : null}
          <ReviewPanel
            inspectionId={record?.inspectionId ?? ""}
            photos={uploadPhotos.filter((photo) => photo.url !== "")}
            extraction={extraction}
            review={review}
            onReviewChange={handleReviewChange}
            ruleResults={ruleResults}
            headline={headline}
            confirming={confirming}
            confirmedAt={confirmedAt}
            confirmBlockers={confirmBlockers}
            onConfirm={handleConfirm}
          />
        </>
      ) : (
        <>
          <div className="mb-4 sm:mb-6">
            <h1 className="text-2xl font-extrabold tracking-[-0.03em] text-slate-950 sm:text-3xl">
              Photograph the package
            </h1>
            <p className="mt-1 text-sm text-slate-600 sm:text-base">
              One inspection is one physical package. Add the front, back, and
              any side with declarations, then run the analysis.
            </p>
          </div>

          <div className="space-y-5">
            <UploadZone
              photos={uploadPhotos}
              categoryHint={hint}
              onCategoryHintChange={handleHintChange}
              onFilesSelect={handleFilesSelect}
              onRemovePhoto={handleRemovePhoto}
              currentStep={currentStep}
              disabled={busy}
            />

            {error ? <Notice {...error} /> : null}
            {notice ? <Notice tone="info" title={notice} /> : null}

            {extraction && review ? (
              <button
                type="button"
                onClick={() => {
                  setStage("review");
                  window.scrollTo(0, 0);
                }}
                className="inline-flex min-h-11 items-center text-sm font-medium text-blue-800 hover:text-blue-900"
              >
                Open current analysis
              </button>
            ) : null}

            <div className="hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:block">
              {analyzeButton}
            </div>
          </div>

          {showMobileDock ? (
            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(15,23,42,0.08)] md:hidden">
              {analyzeButton}
              <p className="mt-1.5 text-center text-xs text-slate-600">
                {photoCount === 0
                  ? "Take at least one photograph first."
                  : `${photoCount} photo${photoCount === 1 ? "" : "s"} ready to analyze.`}
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
