import type { QuaternionTuple } from "./types";

/**
 * Body attitude relative to the local NED frame.
 *
 * R_ned_body = R_ned_ecef^T * R_ecef_body, decomposed as ZYX
 * (yaw about down, pitch about east, roll about north).
 * This is a display observable; the stored attitude remains BODY->ECEF.
 */
export function bodyToNedEuler(
  q: QuaternionTuple,
  latDeg: number,
  lonDeg: number,
): { rollDeg: number; pitchDeg: number; yawDeg: number } {
  const w = q.w, x = q.x, y = q.y, z = q.z;
  const n = Math.hypot(w, x, y, z) || 1;
  const qw = w / n, qx = x / n, qy = y / n, qz = z / n;

  // BODY -> ECEF
  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qw * qz);
  const r02 = 2 * (qx * qz + qw * qy);
  const r10 = 2 * (qx * qy + qw * qz);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qw * qx);
  const r20 = 2 * (qx * qz - qw * qy);
  const r21 = 2 * (qy * qz + qw * qx);
  const r22 = 1 - 2 * (qx * qx + qy * qy);

  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const so = Math.sin(lon), co = Math.cos(lon);
  // ENU basis in ECEF
  const e = [-so, co, 0];
  const nn = [-sl * co, -sl * so, cl];
  const u = [cl * co, cl * so, sl];
  // NED basis
  const nB = nn;
  const eB = e;
  const dB = [-u[0], -u[1], -u[2]];

  const R = [
    [r00, r01, r02],
    [r10, r11, r12],
    [r20, r21, r22],
  ];
  const basis = [nB, eB, dB];
  // R_ned_body[i][j] = sum_k basis[i][k] * R_ecef_body[k][j]
  const m: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      m[i][j] = basis[i][0] * R[0][j] + basis[i][1] * R[1][j] + basis[i][2] * R[2][j];
    }
  }
  const pitch = -Math.asin(Math.max(-1, Math.min(1, m[2][0])));
  const roll = Math.atan2(m[2][1], m[2][2]);
  const yaw = Math.atan2(m[1][0], m[0][0]);
  const d = 180 / Math.PI;
  return { rollDeg: roll * d, pitchDeg: pitch * d, yawDeg: yaw * d };
}
