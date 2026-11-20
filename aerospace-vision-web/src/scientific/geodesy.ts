/**
 * WGS84 geodesy — independent of Three.js so it can be unit tested.
 * All lengths in metres, angles in radians unless the name says Deg.
 */

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
export const OMEGA_EARTH = 7.292115e-5;

export interface Geodetic {
  latRad: number;
  lonRad: number;
  altM: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Geodetic (WGS84) -> ECEF, metres. */
export function geodeticToEcef(latDeg: number, lonDeg: number, altM: number): Vec3 {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const sin = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sin * sin);
  return {
    x: (n + altM) * Math.cos(lat) * Math.cos(lon),
    y: (n + altM) * Math.cos(lat) * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + altM) * sin,
  };
}

/** ECEF -> geodetic (WGS84) using Bowring's closed-form latitude. */
export function ecefToGeodetic(x: number, y: number, z: number): Geodetic {
  const p = Math.hypot(x, y);
  const lonRad = Math.atan2(y, x);
  if (p < 1e-9) {
    return { latRad: Math.sign(z) * Math.PI * 0.5, lonRad, altM: Math.abs(z) - WGS84_B };
  }
  const ep2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const latRad = Math.atan2(
    z + ep2 * WGS84_B * st * st * st,
    p - WGS84_E2 * WGS84_A * ct * ct * ct,
  );
  const sin = Math.sin(latRad);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sin * sin);
  const altM = p / Math.cos(latRad) - n;
  return { latRad, lonRad, altM };
}

export function ecefToLatLonAlt(x: number, y: number, z: number) {
  const g = ecefToGeodetic(x, y, z);
  return { latDeg: g.latRad * R2D, lonDeg: g.lonRad * R2D, altM: g.altM };
}

/** Local East-North-Up basis at a geodetic location, expressed in ECEF. */
export function enuBasis(latDeg: number, lonDeg: number) {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return {
    east: { x: -so, y: co, z: 0 },
    north: { x: -sl * co, y: -sl * so, z: cl },
    up: { x: cl * co, y: cl * so, z: sl },
  };
}

/** Rotate an ECI vector into ECEF at elapsed time t (ECI == ECEF at t=0). */
export function eciToEcef(v: Vec3, t: number): Vec3 {
  const a = -OMEGA_EARTH * t;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
}

/** Central-angle great-circle distance between two geodetic points (rad). */
export function greatCircleAngle(
  lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number,
): number {
  const p1 = lat1Deg * D2R;
  const p2 = lat2Deg * D2R;
  const dp = p2 - p1;
  const dl = (lon2Deg - lon1Deg) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Geodesic distance on the WGS84 ellipsoid, metres (great-circle on mean R). */
export function surfaceDistanceM(
  lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number,
): number {
  return greatCircleAngle(lat1Deg, lon1Deg, lat2Deg, lon2Deg) * WGS84_A;
}
