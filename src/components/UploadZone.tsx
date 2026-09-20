"use client";

import { useRef, useState } from "react";
import {
  Camera,
  Check,
  ClipboardCheck,
  ImagePlus,
  ScanSearch,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import CameraCapture from "@/components/CameraCapture";
import {
  defaultCameraFacing,
  liveCameraAvailable,
  type CameraFacing,
} from "@/lib/camera";
import { log } from "@/lib/log";

export interface UploadZonePhoto {
  photoId: string;
  url: string;
  name: string;
  face?: string;
}

export interface UploadZoneProps {
  photos: UploadZonePhoto[];
  categoryHint: string;
  onCategoryHintChange: (hint: string) => void;
  onFilesSelect: (files: File[]) => void;
  onRemovePhoto: (photoId: string) => void;
  currentStep: number;
  disabled?: boolean;
}

const STEPS: { label: string; icon: LucideIcon }[] = [
  { label: "Photos", icon: Camera },
  { label: "Analyze", icon: ScanSearch },
  { label: "Review", icon: ClipboardCheck },
  { label: "Confirm", icon: Check },
];

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "food-beverages", label: "Food and beverages" },
  { value: "personal-care", label: "Personal care" },
  { value: "household", label: "Household products" },
  { value: "other", label: "Other" },
];

export default function UploadZone({
  photos,
  categoryHint,
  onCategoryHintChange,
  onFilesSelect,
  onRemovePhoto,
  currentStep,
  disabled = false,
}: UploadZoneProps) {
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("user");

  function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (list.length > 0) onFilesSelect(list);
  }

  function openDeviceCamera() {
    setCameraOpen(false);
    cameraInputRef.current?.click();
  }

  function openTakePhoto() {
    if (disabled) return;
    if (liveCameraAvailable()) {
      const facing = defaultCameraFacing();
      setCameraFacing(facing);
      setCameraOpen(true);
      log.info("camera", "open", "Take photo opened live camera", {
        data: { facing },
      });
      return;
    }
    log.info("camera", "file_fallback", "No live camera; opening file picker");
    openDeviceCamera();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <ol className="mb-5 flex items-start" aria-label="Inspection progress">
        {STEPS.map((step, i) => {
          const done = i < currentStep;
          const active = i === currentStep;
          const Icon = step.icon;
          return (
            <li
              key={step.label}
              className={`flex items-center ${i < STEPS.length - 1 ? "flex-1" : ""}`}
              aria-current={active ? "step" : undefined}
            >
              <div className="flex flex-col items-center gap-1">
                <span
                  className={`flex h-9 w-9 items-center justify-center rounded-xl border-2 ${
                    done
                      ? "border-green-600 bg-green-600 text-white"
                      : active
                        ? "border-blue-700 bg-blue-700 text-white"
                        : "border-slate-300 bg-white text-slate-400"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span
                  className={`text-xs font-medium ${
                    done || active ? "text-slate-900" : "text-slate-500"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`mx-1 mb-5 h-0.5 flex-1 rounded sm:mx-2 ${
                    done ? "bg-green-600" : "bg-slate-200"
                  }`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>

      <div>
        <label
          htmlFor="category-hint"
          className="block text-sm font-medium text-slate-700"
        >
          Package category
        </label>
        <select
          id="category-hint"
          value={categoryHint}
          disabled={disabled}
          onChange={(e) => onCategoryHintChange(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 py-2 text-base text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60 sm:w-72 sm:text-sm"
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="mt-1 hidden text-xs text-slate-600 sm:block">
          Optional. Auto-detect lets the model suggest one; your choice
          overrides the suggestion. The reviewer can still correct it before
          confirming.
        </p>
      </div>

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={disabled}
          onClick={openTakePhoto}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#1E40AF] disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          <Camera className="h-5 w-5" aria-hidden="true" />
          Take photo
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (!disabled) galleryInputRef.current?.click();
          }}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ImagePlus className="h-5 w-5" aria-hidden="true" />
          Choose from gallery
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-600">
        Front, back, and any side that shows declarations.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
        className={`mt-4 hidden min-h-52 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-12 text-center md:flex lg:min-h-64 lg:py-16 ${
          disabled
            ? "border-slate-200 bg-slate-50 opacity-60"
            : dragActive
              ? "border-blue-500 bg-blue-50"
              : "border-slate-300 bg-slate-50"
        }`}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-800">
          <Upload className="h-6 w-6" aria-hidden="true" />
        </span>
        <p className="text-sm font-semibold text-slate-900">
          Or drop package photos here
        </p>
        <p className="text-xs text-slate-600">JPEG, PNG, or HEIC from a phone</p>
      </div>

      {photos.length > 0 ? (
        <div className="mt-4">
          <p className="text-sm font-medium text-slate-800">
            {photos.length} photo{photos.length === 1 ? "" : "s"} in this
            inspection
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {photos.map((photo, index) => {
              const label =
                photo.face && photo.face !== "unknown"
                  ? photo.face
                  : `Photo ${index + 1}`;
              return (
                <li
                  key={photo.photoId}
                  className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
                >
                  <img
                    src={photo.url}
                    alt={label}
                    className="aspect-[4/3] h-auto w-full object-cover"
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onRemovePhoto(photo.photoId)}
                    aria-label={`Remove ${label}`}
                    className="absolute top-2 right-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-black/65 text-white hover:bg-black/80 disabled:opacity-60"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <p className="truncate px-2 py-1.5 text-xs text-slate-600">
                    {label}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-600 md:hidden">
          Nothing is saved until you take or add a photograph.
        </p>
      )}

      {cameraOpen ? (
        <CameraCapture
          initialFacing={cameraFacing}
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => handleFiles([file])}
          onUseDeviceCamera={openDeviceCamera}
        />
      ) : null}
    </div>
  );
}
