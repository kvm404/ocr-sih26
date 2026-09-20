/**
 * Client-side photo normalization for the vision model.
 *
 * Phone photos arrive as JPEG, PNG, WebP, HEIC/HEIF, or other types, and the
 * model server only accepts base64-encoded JPEG/PNG image data (anything else
 * fails with "'url' field must be a base64 encoded image"). Every photo sent
 * to the model is therefore re-encoded as a bounded JPEG. Original bytes stay
 * untouched in IndexedDB evidence — only the transmitted copy is converted.
 *
 * All functions require a browser (canvas / createImageBitmap).
 */

import { log } from "./log";

/** Longest edge of the transmitted image; keeps phone photos small and fast. */
export const MODEL_IMAGE_MAX_DIM = 1600;

/** JPEG quality for the transmitted copy (originals are unaffected). */
export const MODEL_IMAGE_QUALITY = 0.95;

function canvasToJpegDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("The browser could not encode the photo as JPEG."));
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read the encoded photo."));
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(new Error("Could not read the encoded photo."));
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      MODEL_IMAGE_QUALITY,
    );
  });
}

/**
 * Convert any renderable photo blob to a `data:image/jpeg;base64,...` URL
 * bounded to MODEL_IMAGE_MAX_DIM on the longest edge (aspect preserved).
 * Throws when the browser cannot decode or encode the image.
 */
export async function photoBlobToJpegDataUrl(blob: Blob): Promise<string> {
  if (typeof createImageBitmap === "undefined" || typeof document === "undefined") {
    throw new Error("Photo conversion needs a browser with canvas support.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("image", "decode_failed", "Browser could not decode the photo", {
      data: { type: blob.type, size: blob.size, cause: message },
    });
    throw new Error("This photo format cannot be opened in the browser — try a JPEG or PNG photo.");
  }
  try {
    const scale = Math.min(1, MODEL_IMAGE_MAX_DIM / Math.max(1, Math.max(bitmap.width, bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The browser canvas is unavailable.");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await canvasToJpegDataUrl(canvas);
  } finally {
    bitmap.close();
  }
}
