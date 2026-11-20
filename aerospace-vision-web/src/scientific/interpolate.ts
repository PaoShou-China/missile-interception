/**
 * Deterministic trajectory sampler.
 *
 * - Position: cubic Hermite between consecutive samples, with the telemetry
 *   ECEF velocity supplied as the tangent. This reproduces every sample exactly
 *   and preserves the physically meaningful velocity at the nodes.
 * - Attitude: shortest-arc quaternion SLERP, normalized.
 * - Scalars: linear interpolation.
 *
 * The sampler never interpolates across a gap: each segment is bounded by two
 * consecutive telemetry samples, so discontinuities are not smoothed over.
 */
import type { Phase, TrajectorySample } from "./types";
import { normalizeQuat, slerp } from "./quaternion";

export interface SampledState {
  t: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  attitude: { w: number; x: number; y: number; z: number };
  latDeg: number;
  lonDeg: number;
  altM: number;
  speedMS: number;
  mach: number;
  qPa: number;
  loadG: number;
  loadCmdG: number;
  massKg: number;
  fovDeg: number;
  rangeM: number;
  phase: Phase;
  seekerLock: boolean;
  handover: boolean;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

function hermite(
  p0: number, p1: number, v0: number, v1: number, dt: number, u: number,
): number {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return h00 * p0 + h10 * dt * v0 + h01 * p1 + h11 * dt * v1;
}

export class TrajectorySampler {
  readonly samples: TrajectorySample[];
  readonly t0: number;
  readonly t1: number;

  constructor(samples: TrajectorySample[]) {
    if (samples.length < 2) throw new Error("TrajectorySampler needs >= 2 samples");
    this.samples = samples;
    this.t0 = samples[0].t;
    this.t1 = samples[samples.length - 1].t;
  }

  /** Index of the last sample with t <= time (0..n-2). */
  private segmentIndex(t: number): number {
    const s = this.samples;
    let lo = 0;
    let hi = s.length - 1;
    if (t <= s[0].t) return 0;
    if (t >= s[hi].t) return s.length - 2;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  sampleAt(time: number): SampledState {
    const t = Math.min(this.t1, Math.max(this.t0, time));
    const s = this.samples;
    const i = this.segmentIndex(t);
    const a = s[i];
    const b = s[i + 1];
    const dt = b.t - a.t;
    const u = dt > 1e-12 ? (t - a.t) / dt : 0;
    const attitude = slerp(a.attitude, b.attitude, u);

    return {
      t,
      position: {
        x: hermite(a.position.x, b.position.x, a.velocity.x, b.velocity.x, dt, u),
        y: hermite(a.position.y, b.position.y, a.velocity.y, b.velocity.y, dt, u),
        z: hermite(a.position.z, b.position.z, a.velocity.z, b.velocity.z, dt, u),
      },
      velocity: {
        x: lerp(a.velocity.x, b.velocity.x, u),
        y: lerp(a.velocity.y, b.velocity.y, u),
        z: lerp(a.velocity.z, b.velocity.z, u),
      },
      attitude: normalizeQuat(attitude),
      latDeg: lerp(a.latDeg, b.latDeg, u),
      lonDeg: lerp(a.lonDeg, b.lonDeg, u),
      altM: hermite(a.altM, b.altM, 0, 0, dt, u),
      speedMS: lerp(a.speedMS, b.speedMS, u),
      mach: lerp(a.mach, b.mach, u),
      qPa: lerp(a.qPa, b.qPa, u),
      loadG: lerp(a.loadG, b.loadG, u),
      loadCmdG: lerp(a.loadCmdG, b.loadCmdG, u),
      massKg: lerp(a.massKg, b.massKg, u),
      fovDeg: lerp(a.fovDeg, b.fovDeg, u),
      rangeM: lerp(a.rangeM, b.rangeM, u),
      phase: u < 0.5 ? a.phase : b.phase,
      seekerLock: u < 0.5 ? a.seekerLock : b.seekerLock,
      handover: u < 0.5 ? a.handover : b.handover,
    };
  }

  /** Index of the sample at or immediately before ``time``. */
  indexAt(time: number): number {
    return this.segmentIndex(Math.min(this.t1, Math.max(this.t0, time)));
  }
}

/** Great-circle surface track length up to each sample, metres. */
export function cumulativeDistanceM(samples: TrajectorySample[]): number[] {
  const out = new Array<number>(samples.length).fill(0);
  let acc = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].position;
    const b = samples[i].position;
    acc += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    out[i] = acc;
  }
  return out;
}
