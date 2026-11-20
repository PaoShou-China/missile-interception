import { describe, expect, it } from "vitest";
import { TrajectorySampler } from "../../src/scientific/interpolate";
import type { TrajectorySample } from "../../src/scientific/types";

function sample(t: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): TrajectorySample {
  return {
    t,
    position: { x, y, z },
    velocity: { x: vx, y: vy, z: vz },
    attitude: { w: 1, x: 0, y: 0, z: 0 },
    latDeg: 0, lonDeg: 0, altM: z,
    speedMS: Math.hypot(vx, vy, vz),
    mach: 0, qPa: 0, loadG: 0, loadCmdG: 0, massKg: 1000,
    fovDeg: 0, rangeM: 0, phase: "midcourse", seekerLock: false, handover: false,
  };
}

describe("TrajectorySampler", () => {
  it("recovers every original position exactly", () => {
    const samples = [
      sample(0, 0, 0, 0, 10, 0, 0),
      sample(1, 10, 2, 1, 12, 4, 0),
      sample(2, 26, 9, 4, 8, 3, 1),
    ];
    const s = new TrajectorySampler(samples);
    for (const p of samples) {
      const out = s.sampleAt(p.t);
      expect(out.position.x).toBeCloseTo(p.position.x, 9);
      expect(out.position.y).toBeCloseTo(p.position.y, 9);
      expect(out.position.z).toBeCloseTo(p.position.z, 9);
    }
  });

  it("is exact for constant-velocity motion", () => {
    const samples = [sample(0, 0, 0, 0, 100, 20, -5), sample(10, 1000, 200, -50, 100, 20, -5)];
    const s = new TrajectorySampler(samples);
    for (const t of [0.5, 2.5, 7.25]) {
      const out = s.sampleAt(t);
      expect(out.position.x).toBeCloseTo(100 * t, 8);
      expect(out.position.y).toBeCloseTo(20 * t, 8);
      expect(out.position.z).toBeCloseTo(-5 * t, 8);
    }
  });

  it("matches the node velocity and stays finite between nodes", () => {
    const samples = [sample(0, 0, 0, 0, 1000, 0, 0), sample(1, 1000, 20, 5, 1000, 40, 10)];
    const s = new TrajectorySampler(samples);
    const out = s.sampleAt(0.5);
    expect(out.position.x).toBeCloseTo(500, 6);
    expect(Number.isFinite(out.position.y)).toBe(true);
    // Implied average speed is within 2% of the node speed.
    const speed = Math.hypot(out.velocity.x, out.velocity.y, out.velocity.z);
    expect(speed).toBeGreaterThan(950);
    expect(speed).toBeLessThan(1050);
  });

  it("clamps outside the time window instead of extrapolating", () => {
    const s = new TrajectorySampler([sample(10, 0, 0, 0), sample(20, 5, 0, 0, 0.5)]);
    expect(s.sampleAt(-100).position.x).toBe(0);
    expect(s.sampleAt(1e6).position.x).toBe(5);
    expect(s.sampleAt(-100).t).toBe(10);
  });

  it("does not interpolate across a gap: each segment is bounded by its neighbours", () => {
    const samples = [sample(0, 0, 0, 0), sample(1, 10, 0, 0), sample(100, 2000, 0, 0)];
    const s = new TrajectorySampler(samples);
    expect(s.sampleAt(0.99).position.x).toBeLessThan(10.1);
    expect(s.sampleAt(50).position.x).toBeGreaterThan(500);
    expect(s.sampleAt(50).position.x).toBeLessThan(1100);
  });

  it("normalizes attitude output", () => {
    const a = sample(0, 0, 0, 0);
    a.attitude = { w: 0.7, x: 0.1, y: 0.2, z: 0.1 };
    const b = sample(1, 1, 0, 0);
    b.attitude = { w: 0.2, x: 0.9, y: -0.1, z: 0.3 };
    const s = new TrajectorySampler([a, b]);
    const out = s.sampleAt(0.37);
    expect(Math.hypot(out.attitude.w, out.attitude.x, out.attitude.y, out.attitude.z)).toBeCloseTo(1, 12);
  });
});
