import { describe, expect, it } from "vitest";
import { moonDirectionEcef, skyStateAt, sunDirectionEcef } from "../../src/scientific/astronomy";

const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe("astronomy (demo sky only)", () => {
  it("returns unit sun and moon directions in ECEF", () => {
    const sun = sunDirectionEcef(Date.UTC(2026, 10, 20, 2, 0, 0));
    const moon = moonDirectionEcef(Date.UTC(2026, 10, 20, 2, 0, 0));
    expect(len(sun)).toBeCloseTo(1, 6);
    expect(len(moon)).toBeCloseTo(1, 6);
  });

  it("places the sun near the equator at the March equinox", () => {
    const sun = sunDirectionEcef(Date.UTC(2026, 2, 20, 14, 46, 0));
    expect(Math.abs(sun.decDeg)).toBeLessThan(1.0);
  });

  it("reaches the obliquity at the June solstice", () => {
    const sun = sunDirectionEcef(Date.UTC(2026, 5, 21, 12, 0, 0));
    expect(sun.decDeg).toBeGreaterThan(22.5);
    expect(sun.decDeg).toBeLessThan(24.5);
  });

  it("gives a day/night state consistent with the declared epoch", () => {
    const noon = skyStateAt("2026-11-20T02:00:00Z", 0);
    expect(noon.isDay).toBe(true);
    const night = skyStateAt("2026-11-20T14:00:00Z", 0);
    expect(night.isDay).toBe(false);
  });

  it("uses the supplied launch site for the elevation diagnostic", () => {
    const east = skyStateAt("2026-11-20T02:00:00Z", 0, { latDeg: 40, lonDeg: 110 });
    const west = skyStateAt("2026-11-20T02:00:00Z", 0, { latDeg: 40, lonDeg: -100 });
    expect(east.site.lonDeg).toBe(110);
    expect(east.sunElevationDeg).toBeGreaterThan(0);
    expect(west.sunElevationDeg).toBeLessThan(0);
  });

  it("yields a different sky after elapsed simulation time", () => {
    const a = skyStateAt("2026-11-20T02:00:00Z", 0);
    const b = skyStateAt("2026-11-20T02:00:00Z", 672);
    expect(Math.abs(a.sun.x - b.sun.x) + Math.abs(a.sun.y - b.sun.y)).toBeGreaterThan(0.001);
  });
});
