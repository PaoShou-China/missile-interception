import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScenarioManifest } from "../../src/scientific/types";
import { validateScenario } from "../../src/scientific/scenario";
import { TrajectorySampler } from "../../src/scientific/interpolate";
import { geodeticToEcef } from "../../src/scientific/geodesy";

const manifest = JSON.parse(
  readFileSync(new URL("../../public/data/missile-intercept/scenario.json", import.meta.url), "utf8"),
) as ScenarioManifest;

const missile = manifest.entities.find((e) => e.kind === "missile")!.samples!;
const target = manifest.entities.find((e) => e.kind === "target")!.samples!;

describe("scenario payload (scientific gate G1)", () => {
  it("passes structural and scientific validation", () => {
    const issues = validateScenario(manifest);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
    expect(manifest.schemaVersion).toBe("1.0.0");
    expect(manifest.frames.render).toBe("ECEF");
  });

  it("carries at least 1000 missile samples over the full mission", () => {
    expect(missile.length).toBeGreaterThan(1000);
    expect(target.length).toBeGreaterThan(100);
    expect(missile[0].t).toBe(0);
    expect(missile[missile.length - 1].t).toBeCloseTo(manifest.time.endS, 6);
  });

  it("has strictly monotonic time", () => {
    for (let i = 1; i < missile.length; i++) {
      expect(missile[i].t).toBeGreaterThan(missile[i - 1].t);
    }
  });

  it("reproduces geodetic coordinates from ECEF within 1 m", () => {
    let worst = 0;
    for (const s of missile) {
      const p = geodeticToEcef(s.latDeg, s.lonDeg, s.altM);
      worst = Math.max(worst, Math.hypot(p.x - s.position.x, p.y - s.position.y, p.z - s.position.z));
    }
    expect(worst).toBeLessThan(1);
  });

  it("keeps all attitude quaternions unit length", () => {
    for (const s of [...missile, ...target]) {
      const n = Math.hypot(s.attitude.w, s.attitude.x, s.attitude.y, s.attitude.z);
      expect(Math.abs(n - 1)).toBeLessThan(1e-5);
    }
  });

  it("starts on the launch site and ends near the target datum", () => {
    const launch = manifest.launchSite;
    const p0 = geodeticToEcef(launch.latDeg, launch.lonDeg, launch.altM);
    expect(Math.hypot(missile[0].position.x - p0.x, missile[0].position.y - p0.y, missile[0].position.z - p0.z)).toBeLessThan(2);

    const tgt = manifest.targetSite;
    const first = target[0];
    expect(first.latDeg).toBeCloseTo(tgt.latDeg, 1);
    expect(first.lonDeg).toBeCloseTo(tgt.lonDeg, 1);
    expect(first.altM).toBeCloseTo(tgt.altM, 0);
  });

  it("recovers every stored sample through the runtime sampler", () => {
    const sampler = new TrajectorySampler(missile);
    for (let i = 0; i < missile.length; i += 37) {
      const stored = missile[i];
      const out = sampler.sampleAt(stored.t);
      expect(out.position.x).toBeCloseTo(stored.position.x, 6);
      expect(out.position.y).toBeCloseTo(stored.position.y, 6);
      expect(out.position.z).toBeCloseTo(stored.position.z, 6);
      expect(Math.abs(out.attitude.w - stored.attitude.w)).toBeLessThan(1e-9);
    }
  });

  it("keeps interpolated motion consistent with telemetry speed", () => {
    const sampler = new TrajectorySampler(missile);
    let worst = 0;
    for (let t = 5; t < manifest.time.endS - 2; t += 7.3) {
      const a = sampler.sampleAt(t);
      const b = sampler.sampleAt(t + 0.02);
      const step = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z);
      const implied = step / 0.02;
      const expected = 0.5 * (a.speedMS + b.speedMS);
      worst = Math.max(worst, Math.abs(implied - expected) / Math.max(expected, 1));
    }
    expect(worst).toBeLessThan(0.03);
  });

  it("reports intercept metrics consistent with the sample set", () => {
    let minRange = Infinity;
    let minT = 0;
    for (const s of missile) {
      if (s.rangeM < minRange) { minRange = s.rangeM; minT = s.t; }
    }
    expect(manifest.metrics.missDistanceM).toBeCloseTo(minRange, 0);
    expect(manifest.metrics.interceptTimeS).toBeCloseTo(minT, 1);
    expect(manifest.events.some((e) => e.kind === "intercept")).toBe(true);
  });

  it("declares every phase segment within the mission duration", () => {
    for (const p of manifest.phases) {
      expect(p.startT).toBeGreaterThanOrEqual(0);
      expect(p.endT).toBeLessThanOrEqual(manifest.time.endS + 1e-6);
      expect(p.endT).toBeGreaterThan(p.startT);
    }
  });
});
