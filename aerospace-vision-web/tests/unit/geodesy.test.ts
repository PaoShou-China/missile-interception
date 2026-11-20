import { describe, expect, it } from "vitest";
import {
  WGS84_A, WGS84_B, ecefToGeodetic, ecefToLatLonAlt,
  geodeticToEcef, enuBasis, eciToEcef, surfaceDistanceM,
} from "../../src/scientific/geodesy";

describe("WGS84 geodesy", () => {
  it("places the equator / prime meridian on +X", () => {
    const p = geodeticToEcef(0, 0, 0);
    expect(p.x).toBeCloseTo(WGS84_A, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it("places the north pole at the semi-minor axis", () => {
    const p = geodeticToEcef(90, 0, 0);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(WGS84_B, 6);
  });

  it("round-trips geodetic <-> ECEF to sub-millimetre", () => {
    const pts = [
      [40, 110, 0], [28, 126, 15240], [-33.9, 151.2, 58],
      [64.1, -21.9, 1200], [0, 0, 8848], [-89.9, 45, 3000],
    ];
    for (const [lat, lon, alt] of pts) {
      const p = geodeticToEcef(lat, lon, alt);
      const g = ecefToLatLonAlt(p.x, p.y, p.z);
      const back = geodeticToEcef(g.latDeg, g.lonDeg, g.altM);
      expect(Math.hypot(back.x - p.x, back.y - p.y, back.z - p.z)).toBeLessThan(1e-5);
      expect(g.altM).toBeCloseTo(alt, 4);
    }
  });

  it("returns a right-handed orthonormal ENU basis", () => {
    const { east, north, up } = enuBasis(35, 118);
    const dot = (a: typeof east, b: typeof east) => a.x * b.x + a.y * b.y + a.z * b.z;
    expect(dot(east, north)).toBeCloseTo(0, 12);
    expect(dot(east, up)).toBeCloseTo(0, 12);
    expect(dot(north, up)).toBeCloseTo(0, 12);
    expect(dot(east, east)).toBeCloseTo(1, 12);
    // E x N = U
    const cx = east.y * north.z - east.z * north.y;
    const cy = east.z * north.x - east.x * north.z;
    const cz = east.x * north.y - east.y * north.x;
    expect(cx).toBeCloseTo(up.x, 12);
    expect(cy).toBeCloseTo(up.y, 12);
    expect(cz).toBeCloseTo(up.z, 12);
  });

  it("rotates ECI into ECEF by -omega*t", () => {
    const v = { x: 1, y: 0, z: 0 };
    const r = eciToEcef(v, (Math.PI / 2) / 7.292115e-5); // quarter turn
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(-1, 9);
  });

  it("computes a plausible surface distance for the scenario", () => {
    // 40N110E -> 28N126E is about 1800-1900 km.
    const d = surfaceDistanceM(40, 110, 28, 126);
    expect(d / 1000).toBeGreaterThan(1700);
    expect(d / 1000).toBeLessThan(2000);
  });

  it("is stable at the poles (no NaN)", () => {
    const g = ecefToGeodetic(0, 0, WGS84_B + 100);
    expect(Number.isFinite(g.latRad)).toBe(true);
    expect(Number.isFinite(g.altM)).toBe(true);
    expect(g.latRad).toBeCloseTo(Math.PI / 2, 6);
  });
});
