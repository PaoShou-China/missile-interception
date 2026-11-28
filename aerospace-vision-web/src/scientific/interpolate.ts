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
import type { BodyRatesRadS, FinDeflectionsRad, Phase, TrajectorySample } from "./types";
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
  /** Recorded fin deflections (rad). Zero when the source has no fin data. */
  finDeflectionsRad: FinDeflectionsRad;
  /** Recorded body rates (rad/s). Zero when the source has no rate data. */
  bodyRatesRadS: BodyRatesRadS;
  heatFluxMWm2?: number;
  wallTempK?: number;
  aspectDeg?: number;
  targetRcsM2?: number;
  radarSnrDb?: number;
  irSnrDb?: number;
  seekerAzDeg?: number;
  seekerElDeg?: number;
  wallTempEqK?: number;
  unstartFlag?: number;
  stageSep?: number;
  cgPos?: number;
  cpPos?: number;
  bodyForceX?: number;
  bodyForceY?: number;
  bodyForceZ?: number;
  decoyActive?: number;
  decoyAzDeg?: number;
  decoyElDeg?: number;
  immPCv?: number;
  immPCa?: number;
  immPCt?: number;
  fuzePk?: number;
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
      finDeflectionsRad: {
        up: lerp(a.finDeflectionsRad?.up ?? 0, b.finDeflectionsRad?.up ?? 0, u),
        down: lerp(a.finDeflectionsRad?.down ?? 0, b.finDeflectionsRad?.down ?? 0, u),
        left: lerp(a.finDeflectionsRad?.left ?? 0, b.finDeflectionsRad?.left ?? 0, u),
        right: lerp(a.finDeflectionsRad?.right ?? 0, b.finDeflectionsRad?.right ?? 0, u),
      },
      bodyRatesRadS: {
        p: lerp(a.bodyRatesRadS?.p ?? 0, b.bodyRatesRadS?.p ?? 0, u),
        q: lerp(a.bodyRatesRadS?.q ?? 0, b.bodyRatesRadS?.q ?? 0, u),
        r: lerp(a.bodyRatesRadS?.r ?? 0, b.bodyRatesRadS?.r ?? 0, u),
      },
      heatFluxMWm2: a.heatFluxMWm2 !== undefined && b.heatFluxMWm2 !== undefined ? lerp(a.heatFluxMWm2, b.heatFluxMWm2, u) : a.heatFluxMWm2,
      wallTempK: a.wallTempK !== undefined && b.wallTempK !== undefined ? lerp(a.wallTempK, b.wallTempK, u) : a.wallTempK,
      aspectDeg: a.aspectDeg !== undefined && b.aspectDeg !== undefined ? lerp(a.aspectDeg, b.aspectDeg, u) : a.aspectDeg,
      targetRcsM2: a.targetRcsM2 !== undefined && b.targetRcsM2 !== undefined ? lerp(a.targetRcsM2, b.targetRcsM2, u) : a.targetRcsM2,
      radarSnrDb: a.radarSnrDb !== undefined && b.radarSnrDb !== undefined ? lerp(a.radarSnrDb, b.radarSnrDb, u) : a.radarSnrDb,
      irSnrDb: a.irSnrDb !== undefined && b.irSnrDb !== undefined ? lerp(a.irSnrDb, b.irSnrDb, u) : a.irSnrDb,
      seekerAzDeg: a.seekerAzDeg !== undefined && b.seekerAzDeg !== undefined ? lerp(a.seekerAzDeg, b.seekerAzDeg, u) : a.seekerAzDeg,
      seekerElDeg: a.seekerElDeg !== undefined && b.seekerElDeg !== undefined ? lerp(a.seekerElDeg, b.seekerElDeg, u) : a.seekerElDeg,
      wallTempEqK: a.wallTempEqK !== undefined && b.wallTempEqK !== undefined ? lerp(a.wallTempEqK, b.wallTempEqK, u) : a.wallTempEqK,
      unstartFlag: u < 0.5 ? a.unstartFlag : b.unstartFlag,
      stageSep: u < 0.5 ? a.stageSep : b.stageSep,
      cgPos: a.cgPos !== undefined && b.cgPos !== undefined ? lerp(a.cgPos, b.cgPos, u) : a.cgPos,
      cpPos: a.cpPos !== undefined && b.cpPos !== undefined ? lerp(a.cpPos, b.cpPos, u) : a.cpPos,
      bodyForceX: a.bodyForceX !== undefined && b.bodyForceX !== undefined ? lerp(a.bodyForceX, b.bodyForceX, u) : a.bodyForceX,
      bodyForceY: a.bodyForceY !== undefined && b.bodyForceY !== undefined ? lerp(a.bodyForceY, b.bodyForceY, u) : a.bodyForceY,
      bodyForceZ: a.bodyForceZ !== undefined && b.bodyForceZ !== undefined ? lerp(a.bodyForceZ, b.bodyForceZ, u) : a.bodyForceZ,
      decoyActive: u < 0.5 ? a.decoyActive : b.decoyActive,
      decoyAzDeg: a.decoyAzDeg !== undefined && b.decoyAzDeg !== undefined ? lerp(a.decoyAzDeg, b.decoyAzDeg, u) : a.decoyAzDeg,
      decoyElDeg: a.decoyElDeg !== undefined && b.decoyElDeg !== undefined ? lerp(a.decoyElDeg, b.decoyElDeg, u) : a.decoyElDeg,
      immPCv: a.immPCv !== undefined && b.immPCv !== undefined ? lerp(a.immPCv, b.immPCv, u) : a.immPCv,
      immPCa: a.immPCa !== undefined && b.immPCa !== undefined ? lerp(a.immPCa, b.immPCa, u) : a.immPCa,
      immPCt: a.immPCt !== undefined && b.immPCt !== undefined ? lerp(a.immPCt, b.immPCt, u) : a.immPCt,
      fuzePk: a.fuzePk !== undefined && b.fuzePk !== undefined ? lerp(a.fuzePk, b.fuzePk, u) : a.fuzePk,
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
