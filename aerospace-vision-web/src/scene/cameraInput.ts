/**
 * User camera manipulation shared by every scientific camera mode.
 *
 * The automatic rig computes a framing each frame; these offsets are applied
 * on top of it so the viewer can orbit and zoom without losing the tracked
 * vehicle. `free` mode uses OrbitControls instead and ignores this state.
 */
export const cameraInput = {
  yaw: 0,
  pitch: 0,
  zoom: 1,
};

export function resetCameraInput() {
  cameraInput.yaw = 0;
  cameraInput.pitch = 0;
  cameraInput.zoom = 1;
}
