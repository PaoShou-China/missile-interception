import { describe, expect, it } from "vitest";
import { bodyToNedEuler } from "../../src/scientific/attitude";
import type { QuaternionTuple } from "../../src/scientific/types";

/** DCM -> quaternion, independent implementation for the test. */
function dcmToQuat(m: number[][]): QuaternionTuple {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let w = 0, x = 0, y = 0, z = 0;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s; x = s / 4; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = s / 4; z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = s / 4;
  }
  const n = Math.hypot(w, x, y, z);
  return { w: w / n, x: x / n, y: y / n, z: z / n };
}

function mul(a: number[][], b: number[][]) {
  return a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
}

describe("body -> local NED attitude extraction", () => {
  it("recovers a known yaw / pitch / roll at a non-trivial latitude", () => {
    const lat = 35, lon = 118;
    const yaw = (30 * Math.PI) / 180;
    const pitch = (10 * Math.PI) / 180;
    const roll = (-15 * Math.PI) / 180;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const Rz = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]];
    const Ry = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]];
    const Rx = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]];
    const nedBody = mul(mul(Rz, Ry), Rx);

    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    const R = [
      [-sl * co, -so, -cl * co],
      [-sl * so, co, -cl * so],
      [cl, 0, -sl],
    ]; // columns: north, east, down (NED) in ECEF
    const ecefBody = mul(R, nedBody);

    const q = dcmToQuat(ecefBody);
    const out = bodyToNedEuler(q, lat, lon);
    expect(out.yawDeg).toBeCloseTo(30, 6);
    expect(out.pitchDeg).toBeCloseTo(10, 6);
    expect(out.rollDeg).toBeCloseTo(-15, 6);
  });

  it("stays finite near the pitch singularity", () => {
    const q: QuaternionTuple = { w: Math.SQRT1_2, x: 0, y: 0, z: Math.SQRT1_2 };
    const out = bodyToNedEuler(q, 40, 110);
    expect(Number.isFinite(out.rollDeg)).toBe(true);
    expect(Number.isFinite(out.pitchDeg)).toBe(true);
    expect(Number.isFinite(out.yawDeg)).toBe(true);
  });
});
