export type CameraFacing = "user" | "environment";

/**
 * Laptop / desktop: front camera (the one that faces the operator holding
 * a pack up to the screen). Phone: rear camera.
 */
export function defaultCameraFacing(): CameraFacing {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "user";
  }
  try {
    if (window.matchMedia("(pointer: coarse) and (hover: none)").matches) {
      return "environment";
    }
  } catch {
    return "user";
  }
  return "user";
}

export function liveCameraAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}
