/** Camera modes. The order defines the numeric keyboard shortcuts (1..0). */
export const CAMERA_MODES = [
  "earth",
  "top",
  "chase",
  "launch",
  "target",
  "free",
  "fin",
  "engine",
  "attitude",
  "seeker",
] as const;

export type CameraMode = (typeof CAMERA_MODES)[number];

/** Close-up modes ride on the interceptor body frame. */
export const BODY_CAMERAS: CameraMode[] = ["fin", "engine", "attitude", "seeker"];
