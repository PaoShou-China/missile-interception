/**
 * Cinematic presentation timeline.
 *
 * This timeline is independent of simulation time: the whole mission is mapped
 * onto a fixed 180-second wall duration. Shots are selected by wall time, so
 * the film always runs for three minutes regardless of the mission duration.
 * Nothing here modifies the trajectory data.
 */
import type { CameraMode } from "../state/cameraModes";
import type { PhaseSegment } from "../scientific/types";

export const CINEMATIC_WALL_S = 180;

/**
 * Wall-time budget per mission phase. Boost and terminal are shown slowly,
 * midcourse is compressed, so the three phases visibly play at different
 * speeds inside the fixed three-minute film.
 */
const PHASE_WALL: Record<string, [number, number]> = {
  boost: [0, 60],
  midcourse: [60, 142],
  terminal: [142, 180],
  coast: [60, 142],
};

export interface CinematicSegment {
  phase: string;
  startT: number;
  endT: number;
  startWall: number;
  endWall: number;
}

export function cinematicSegments(phases: PhaseSegment[]): CinematicSegment[] {
  return phases.map((p) => {
    const [startWall, endWall] = PHASE_WALL[p.phase] ?? [0, CINEMATIC_WALL_S];
    return { phase: p.phase, startT: p.startT, endT: p.endT, startWall, endWall };
  });
}

/** Map wall seconds to simulation seconds using the per-phase budget. */
export function wallToSim(wall: number, phases: PhaseSegment[]): number {
  const segs = cinematicSegments(phases);
  if (!segs.length) return wall;
  const clamped = Math.min(CINEMATIC_WALL_S, Math.max(0, wall));
  const seg = segs.find((s) => clamped >= s.startWall && clamped <= s.endWall) ?? segs[segs.length - 1];
  const f = (clamped - seg.startWall) / Math.max(1e-6, seg.endWall - seg.startWall);
  return seg.startT + Math.min(1, Math.max(0, f)) * (seg.endT - seg.startT);
}

/** Inverse mapping, used by the overlay and the camera rig. */
export function simToWall(t: number, phases: PhaseSegment[]): number {
  const segs = cinematicSegments(phases);
  if (!segs.length) return 0;
  const seg = segs.find((s) => t >= s.startT && t <= s.endT) ?? (t < segs[0].startT ? segs[0] : segs[segs.length - 1]);
  const span = seg.endT - seg.startT;
  const f = span > 0 ? (t - seg.startT) / span : 0;
  return Math.min(CINEMATIC_WALL_S, Math.max(0, seg.startWall + Math.min(1, Math.max(0, f)) * (seg.endWall - seg.startWall)));
}

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
    endWall: 22,
    mode: "launch",
    distance: 0.055,
    titleKey: "cinematic.shot.ignition.title",
    captionKey: "cinematic.shot.ignition.caption",
  },
  {
    id: "boost",
    startWall: 22,
    endWall: 60,
    mode: "chase",
    distance: 0.04,
    titleKey: "cinematic.shot.boost.title",
    captionKey: "cinematic.shot.boost.caption",
  },
  {
    id: "control",
    startWall: 60,
    endWall: 82,
    mode: "fin",
    distance: 1,
    titleKey: "cinematic.shot.control.title",
    captionKey: "cinematic.shot.control.caption",
  },
  {
    id: "midcourse",
    startWall: 82,
    endWall: 122,
    mode: "earth",
    distance: 1,
    titleKey: "cinematic.shot.midcourse.title",
    captionKey: "cinematic.shot.midcourse.caption",
  },
  {
    id: "guidance",
    startWall: 122,
    endWall: 142,
    mode: "attitude",
    distance: 1,
    titleKey: "cinematic.shot.guidance.title",
    captionKey: "cinematic.shot.guidance.caption",
  },
  {
    id: "terminal",
    startWall: 142,
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
