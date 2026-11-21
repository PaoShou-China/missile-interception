/** Camera modes. The order defines the numeric keyboard shortcuts (1..8). */
export const CAMERA_MODES = [
  "earth",
  "chase",
  "launch",
  "target",
  "fin",
  "engine",
  "attitude",
  "seeker",
] as const;

export type CameraMode = (typeof CAMERA_MODES)[number];

/** Close-up modes ride on the interceptor body frame. */
export const BODY_CAMERAS: CameraMode[] = ["fin", "engine", "attitude", "seeker"];
