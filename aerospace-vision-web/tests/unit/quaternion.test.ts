import { describe, expect, it } from "vitest";
import {
  normalizeQuat, quatMultiply, quatFromAxisAngle, quatRotate, slerp, quatDot,
} from "../../src/scientific/quaternion";

const near = (a: { w: number; x: number; y: number; z: number }, b: typeof a) =>
  Math.hypot(a.w - b.w, a.x - b.x, a.y - b.y, a.z - b.z);

describe("quaternion conventions", () => {
  it("rotates body +x into body +y with a +90 deg z rotation", () => {
    const q = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
    const r = quatRotate(q, { x: 1, y: 0, z: 0 });
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
  });

  it("composes rotations in Hamilton order (a then b applied to the vector as a*b)", () => {
    const qx = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    const qz = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
    const combined = quatMultiply(qz, qx);
    const r = quatRotate(combined, { x: 1, y: 0, z: 0 });
    // Rotate +x about x (unchanged), then about z -> +y.
    expect(r.y).toBeCloseTo(1, 12);
  });

  it("normalizes degenerate quaternions safely", () => {
    const q = normalizeQuat({ w: 0, x: 0, y: 0, z: 0 });
    expect(q).toEqual({ w: 1, x: 0, y: 0, z: 0 });
  });

  describe("slerp", () => {
    const a = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0);
    const b = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);

    it("returns exact endpoints", () => {
      expect(near(slerp(a, b, 0), a)).toBeLessThan(1e-12);
      expect(near(slerp(a, b, 1), b)).toBeLessThan(1e-12);
    });

    it("produces a unit quaternion at any parameter", () => {
      for (let u = 0; u <= 1.0001; u += 0.1) {
        const q = slerp(a, b, u);
        expect(Math.hypot(q.w, q.x, q.y, q.z)).toBeCloseTo(1, 12);
      }
    });

    it("takes the short arc for a negated endpoint", () => {
      const neg = { w: -b.w, x: -b.x, y: -b.y, z: -b.z };
      const mid = slerp(a, neg, 0.5);
      const expected = slerp(a, b, 0.5);
      expect(Math.abs(quatDot(mid, expected))).toBeCloseTo(1, 12);
      expect(quatDot(mid, a)).toBeGreaterThan(0);
    });

    it("interpolates a quarter turn at the geometric midpoint", () => {
      const mid = slerp(a, b, 0.5);
      const r = quatRotate(mid, { x: 0, y: 0, z: 1 });
      expect(r.x).toBeCloseTo(Math.SQRT1_2, 12);
      expect(r.z).toBeCloseTo(Math.SQRT1_2, 12);
    });
  });
});
