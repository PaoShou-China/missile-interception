import * as THREE from "three";
import { getTelemetry, sampleAt, type Sample } from "../data/telemetry";

const EARTH_R = 6_371_000;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

/** Nearest target sample (the payload stores 240 of them, ~2.8 s apart). */
export function sampleTarget(samples: Sample[], t: number): Sample | null {
  if (samples.length === 0) return null;
  if (t <= samples[0].t) return samples[0];
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1];
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const k = (t - a.t) / (b.t - a.t || 1);
  const lerp = (x: number, y: number) => x + (y - x) * k;
  return {
    ...a,
    latDeg: lerp(a.latDeg, b.latDeg),
    lonDeg: lerp(a.lonDeg, b.lonDeg),
    altM: lerp(a.altM, b.altM),
  };
}

/**
 * Target position in the missile's local scene frame (x east, y up, z south),
 * matching the trajectory overlay. The curvature drop keeps distant samples on
 * the globe instead of letting them float above the horizon.
 */
export function targetLocalAt(t: number, out: THREE.Vector3): number | null {
  const tel = getTelemetry();
  if (!tel) return null;
  const target = sampleTarget(tel.targetSamples, t);
  const cur = sampleAt(t);
  if (!target || !cur) return null;
  const cos = Math.cos((cur.latDeg * Math.PI) / 180);
  const x = (target.lonDeg - cur.lonDeg) * M_PER_DEG_LON * cos;
  const z = -(target.latDeg - cur.latDeg) * M_PER_DEG_LAT;
  const drop = (x * x + z * z) / (2 * EARTH_R);
  out.set(x, target.altM - cur.altM - drop, z);
  return out.length();
}
