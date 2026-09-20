"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, SwitchCamera, X } from "lucide-react";
import type { CameraFacing } from "@/lib/camera";
import { log, errorDetail } from "@/lib/log";

export type CameraCaptureProps = {
  initialFacing: CameraFacing;
  onClose: () => void;
  onCapture: (file: File) => void;
  onUseDeviceCamera: () => void;
};

function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

export default function CameraCapture({
  initialFacing,
  onClose,
  onCapture,
  onUseDeviceCamera,
}: CameraCaptureProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<CameraFacing>(initialFacing);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(
    null,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const scrollY = window.scrollY;

    let cancelled = false;
    setReady(false);
    setError(null);
    log.info("camera", "start", `Opening ${facing} camera`, { data: { facing } });

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        const title = "Live camera is not available";
        const detail = "Use the device camera instead, or pick a photo from the gallery.";
        setError({ title, detail });
        log.warn("camera", "unavailable", title);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          stopStream(stream);
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (!cancelled) {
          setReady(true);
          log.info("camera", "ready", "Live camera is playing", {
            data: {
              facing,
              width: video.videoWidth,
              height: video.videoHeight,
            },
          });
        }
      } catch (err) {
        if (cancelled) return;
        const detail = errorDetail(err);
        const name = err instanceof DOMException ? err.name : detail.name;
        let title = "The live camera could not start";
        let extra = "Use the device camera instead, or pick a photo from the gallery.";
        if (name === "NotAllowedError") {
          title = "Camera permission was denied";
          extra = "Allow camera access, or use the device camera.";
        } else if (name === "NotFoundError") {
          title = "No camera was found";
          extra = "Use the device camera instead, or pick a photo from the gallery.";
        } else if (name === "NotReadableError") {
          title = "The camera is already in use";
          extra = "Close the other app using it, or pick a photo from the gallery.";
        }
        setError({ title, detail: extra });
        log.error("camera", "start_failed", title, {
          code: name,
          data: { facing, cause: detail.message },
        });
      }
    }

    void start();

    return () => {
      cancelled = true;
      stopStream(streamRef.current);
      streamRef.current = null;
      if (dialog?.open) dialog.close();
      window.scrollTo(0, scrollY);
    };
  }, [facing]);

  async function handleShutter() {
    const video = videoRef.current;
    if (!video || !ready || busy || video.videoWidth === 0) return;
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not capture this frame.");
      ctx.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.92),
      );
      if (!blob) throw new Error("Could not save this photograph.");
      const file = new File([blob], `package-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });
      onCapture(file);
      log.info("camera", "capture", "Saved a still from the live camera", {
        data: {
          facing,
          bytes: blob.size,
          width: canvas.width,
          height: canvas.height,
        },
      });
      setFlash(true);
      window.setTimeout(() => setFlash(false), 140);
    } catch (err) {
      const detail = errorDetail(err);
      setError({
        title: "This photograph could not be saved",
        detail: "Try again, or use the device camera.",
      });
      log.error("camera", "capture_failed", detail.message, {
        data: { facing },
      });
    } finally {
      setBusy(false);
    }
  }

  const instruction =
    facing === "user"
      ? "Hold the package up to the camera"
      : "Photograph one side of the package";

  return (
    <dialog
      ref={dialogRef}
      aria-label="Take package photographs"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="fixed inset-0 z-[60] m-0 h-dvh max-h-dvh w-screen max-w-none border-0 bg-black p-0 text-white"
    >
      <div className="relative flex h-full w-full flex-col">
        <video
          ref={videoRef}
          className={`absolute inset-0 h-full w-full object-cover ${
            facing === "user" ? "scale-x-[-1]" : ""
          }`}
          autoPlay
          muted
          playsInline
        />
        {flash ? (
          <div className="pointer-events-none absolute inset-0 bg-white" />
        ) : null}

        <div className="relative z-10 flex items-start justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-black/55 text-white"
            aria-label="Close camera"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
          <p className="max-w-[16rem] pt-2 text-center text-sm font-medium text-white">
            {instruction}
          </p>
          <button
            type="button"
            onClick={() =>
              setFacing((current) =>
                current === "environment" ? "user" : "environment",
              )
            }
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-black/55 text-white"
            aria-label={
              facing === "environment"
                ? "Switch to front camera"
                : "Switch to rear camera"
            }
          >
            <SwitchCamera className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="relative z-10 mt-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-8">
          {error ? (
            <div
              role="alert"
              className="mb-4 rounded-xl bg-black/70 px-4 py-3 text-center text-sm text-white"
            >
              <p className="font-semibold">{error.title}</p>
              {error.detail ? (
                <p className="mt-1 text-sm leading-5 text-white/85">{error.detail}</p>
              ) : null}
              <button
                type="button"
                onClick={onUseDeviceCamera}
                className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-white px-4 text-sm font-semibold text-slate-900"
              >
                Use device camera
              </button>
            </div>
          ) : (
            <p className="mb-4 text-center text-xs text-white/80">
              {facing === "user"
                ? "Front camera. Switch if you want the rear lens."
                : "Rear camera. Switch if you want the front lens."}
            </p>
          )}
          <div className="flex items-center justify-center gap-10">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-lg px-3 text-sm font-medium text-white"
            >
              Done
            </button>
            <button
              type="button"
              onClick={() => void handleShutter()}
              disabled={!ready || busy || Boolean(error)}
              aria-label="Take photograph"
              className="flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full border-[6px] border-white bg-white/15 disabled:opacity-40"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-900">
                <Camera className="h-6 w-6" aria-hidden="true" />
              </span>
            </button>
            <span className="w-12" aria-hidden="true" />
          </div>
        </div>
      </div>
    </dialog>
  );
}
