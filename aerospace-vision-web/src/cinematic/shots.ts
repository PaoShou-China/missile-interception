/**
 * Cinematic presentation timeline.
 *
 * This timeline is independent of simulation time: the whole mission is mapped
 * onto a fixed 180-second wall duration. Shots are selected by wall time, so
 * the film always runs for three minutes regardless of the mission duration.
 * Nothing here modifies the trajectory data.
 */
import type { CameraMode } from "../state/cameraModes";

export const CINEMATIC_WALL_S = 180;

export interface CinematicShot {
  id: string;
  /** Wall-clock start, seconds into the film. */
  startWall: number;
  endWall: number;
  mode: CameraMode;
  /** Camera distance multiplier used by the rig. */
  distance: number;
  /** i18n keys for the caption. */
  titleKey: string;
  captionKey: string;
}

export const CINEMATIC_SHOTS: CinematicShot[] = [
  {
    id: "ignition",
    startWall: 0,
    endWall: 24,
    mode: "launch",
    distance: 0.055,
    titleKey: "cinematic.shot.ignition.title",
    captionKey: "cinematic.shot.ignition.caption",
  },
  {
    id: "boost",
    startWall: 24,
    endWall: 58,
    mode: "chase",
    distance: 0.04,
    titleKey: "cinematic.shot.boost.title",
    captionKey: "cinematic.shot.boost.caption",
  },
  {
    id: "control",
    startWall: 58,
    endWall: 82,
    mode: "fin",
    distance: 1,
    titleKey: "cinematic.shot.control.title",
    captionKey: "cinematic.shot.control.caption",
  },
  {
    id: "midcourse",
    startWall: 82,
    endWall: 118,
    mode: "earth",
    distance: 1,
    titleKey: "cinematic.shot.midcourse.title",
    captionKey: "cinematic.shot.midcourse.caption",
  },
  {
    id: "guidance",
    startWall: 118,
    endWall: 146,
    mode: "top",
    distance: 1,
    titleKey: "cinematic.shot.guidance.title",
    captionKey: "cinematic.shot.guidance.caption",
  },
  {
    id: "terminal",
    startWall: 146,
    endWall: CINEMATIC_WALL_S,
    mode: "target",
    distance: 0.5,
    titleKey: "cinematic.shot.terminal.title",
    captionKey: "cinematic.shot.terminal.caption",
  },
];

export function shotAtWall(wall: number): CinematicShot {
  for (let i = CINEMATIC_SHOTS.length - 1; i >= 0; i--) {
    if (wall >= CINEMATIC_SHOTS[i].startWall) return CINEMATIC_SHOTS[i];
  }
  return CINEMATIC_SHOTS[0];
}

/** Map wall seconds to simulation seconds (linear across the mission). */
export function wallToSim(wall: number, start: number, end: number): number {
  const f = Math.min(1, Math.max(0, wall / CINEMATIC_WALL_S));
  return start + f * (end - start);
}

/** Inverse mapping, used by the overlay to show the presentation clock. */
export function simToWall(t: number, start: number, end: number): number {
  const span = end - start;
  if (!(span > 0)) return 0;
  return Math.min(CINEMATIC_WALL_S, Math.max(0, ((t - start) / span) * CINEMATIC_WALL_S));
}
