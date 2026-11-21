/** Camera modes. The order defines the numeric keyboard shortcuts (1..6). */
export const CAMERA_MODES = [
  "earth",
  "chase",
  "target",
  "fin",
  "engine",
  "attitude",
] as const;

export type CameraMode = (typeof CAMERA_MODES)[number];

/** Close-up modes ride on the interceptor body frame. */
export const BODY_CAMERAS: CameraMode[] = ["fin", "engine", "attitude"];
