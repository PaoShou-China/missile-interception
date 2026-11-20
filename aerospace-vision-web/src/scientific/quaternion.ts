/**
 * Quaternion utilities using the frozen scalar-first [w, x, y, z] convention.
 * Kept free of Three.js imports so the same math is unit-testable.
 */
import type { QuaternionTuple, Vector3Tuple } from "./types";

export function normalizeQuat(q: QuaternionTuple): QuaternionTuple {
  const n = Math.hypot(q.w, q.x, q.y, q.z);
  if (n < 1e-12) return { w: 1, x: 0, y: 0, z: 0 };
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

export function quatDot(a: QuaternionTuple, b: QuaternionTuple): number {
  return a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
}

export function quatConjugate(q: QuaternionTuple): QuaternionTuple {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

/** Hamilton product a ⊗ b (rotates by b first, then a). */
export function quatMultiply(a: QuaternionTuple, b: QuaternionTuple): QuaternionTuple {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatFromAxisAngle(axis: Vector3Tuple, angleRad: number): QuaternionTuple {
  const n = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const s = Math.sin(angleRad / 2) / n;
  return { w: Math.cos(angleRad / 2), x: axis.x * s, y: axis.y * s, z: axis.z * s };
}

/** Rotate a vector by a unit quaternion (BODY -> ECEF for our payload). */
export function quatRotate(q: QuaternionTuple, v: Vector3Tuple): Vector3Tuple {
  const { w, x, y, z } = normalizeQuat(q);
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

/**
 * Spherical linear interpolation along the shortest arc.
 * Endpoints are returned exactly (up to normalization) so original samples
 * are always recoverable.
 */
export function slerp(
  a: QuaternionTuple,
  b: QuaternionTuple,
  u: number,
): QuaternionTuple {
  if (u <= 0) return normalizeQuat(a);
  if (u >= 1) return normalizeQuat(b);
  let d = quatDot(a, b);
  let bb = b;
  if (d < 0) {
    bb = { w: -b.w, x: -b.x, y: -b.y, z: -b.z };
    d = -d;
  }
  if (d > 0.9995) {
    return normalizeQuat({
      w: a.w + (bb.w - a.w) * u,
      x: a.x + (bb.x - a.x) * u,
      y: a.y + (bb.y - a.y) * u,
      z: a.z + (bb.z - a.z) * u,
    });
  }
  const theta0 = Math.acos(Math.min(1, Math.max(-1, d)));
  const theta = theta0 * u;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - d * sinTheta / sinTheta0;
  const s1 = sinTheta / sinTheta0;
  return normalizeQuat({
    w: a.w * s0 + bb.w * s1,
    x: a.x * s0 + bb.x * s1,
    y: a.y * s0 + bb.y * s1,
    z: a.z * s0 + bb.z * s1,
  });
}

/** Convert our payload quaternion to a Three.js-style tuple [x, y, z, w]. */
export function toThreeQuat(q: QuaternionTuple): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}
