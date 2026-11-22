/** Camera modes. The order defines the numeric keyboard shortcuts (1..4). */
export const CAMERA_MODES = [
  "earth",
  "chase",
  "target",
  "closeup",
] as const;

export type CameraMode = (typeof CAMERA_MODES)[number];

/** The merged close-up rides on the interceptor body frame. */
export const BODY_CAMERAS: CameraMode[] = ["closeup"];
