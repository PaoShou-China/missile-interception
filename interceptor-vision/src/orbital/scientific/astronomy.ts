/**
 * Low-precision astronomy used for lighting and sky placement only.
 *
 * Inputs are a declared demonstration epoch (UTC) and elapsed simulation
 * seconds. Outputs are unit direction vectors in the WGS84 ECEF frame.
 * These functions never feed the trajectory solution and are not an ephemeris
 * suitable for navigation.
 *
 * Solar position: NOAA low-precision solar coordinates.
 * Lunar position: Meeus-style truncated series (a few dominant terms).
 */

const DEG = Math.PI / 180;
const EPS_J2000 = 23.4392911;

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;

export interface EcefDirection {
  x: number;
  y: number;
  z: number;
  /** Geocentric right ascension / declination, degrees (diagnostics). */
  raDeg: number;
  decDeg: number;
}

function julianDay(ms: number): number {
  return ms / 86400000 + 2440587.5;
}

function gmstDeg(jd: number): number {
  const d = jd - 2451545.0;
  return norm360(280.46061837 + 360.98564736629 * d);
}

function eclipticToEcef(lambdaDeg: number, betaDeg: number, jd: number): EcefDirection {
  const lambda = lambdaDeg * DEG;
  const beta = betaDeg * DEG;
  const eps = (EPS_J2000 - 0.0000004 * (jd - 2451545.0)) * DEG;

  const xe = Math.cos(beta) * Math.cos(lambda);
  const ye = Math.cos(eps) * Math.cos(beta) * Math.sin(lambda) - Math.sin(eps) * Math.sin(beta);
  const ze = Math.sin(eps) * Math.cos(beta) * Math.sin(lambda) + Math.cos(eps) * Math.sin(beta);

  const ra = Math.atan2(ye, xe);
  const dec = Math.asin(Math.max(-1, Math.min(1, ze)));
  const g = gmstDeg(jd) * DEG;

  // ECEF = Rz(-GMST) * ECI
  const x = Math.cos(g) * xe + Math.sin(g) * ye;
  const y = -Math.sin(g) * xe + Math.cos(g) * ye;
  const z = ze;
  const n = Math.hypot(x, y, z) || 1;
  return {
    x: x / n,
    y: y / n,
    z: z / n,
    raDeg: norm360(ra / DEG),
    decDeg: dec / DEG,
  };
}

/** Sun direction in ECEF at a UTC instant. */
export function sunDirectionEcef(ms: number): EcefDirection {
  const jd = julianDay(ms);
  const d = jd - 2451545.0;
  const meanLong = norm360(280.460 + 0.9856474 * d);
  const meanAnom = norm360(357.528 + 0.9856003 * d) * DEG;
  const lambda = meanLong + 1.915 * Math.sin(meanAnom) + 0.020 * Math.sin(2 * meanAnom);
  return eclipticToEcef(lambda, 0, jd);
}

/** Moon direction in ECEF at a UTC instant (geocentric, low precision). */
export function moonDirectionEcef(ms: number): EcefDirection {
  const jd = julianDay(ms);
  const d = jd - 2451545.0;
  const L = 218.316 + 13.176396 * d; // mean longitude
  const M = (134.963 + 13.064993 * d) * DEG; // mean anomaly
  const F = (93.272 + 13.229350 * d) * DEG; // argument of latitude
  const lambda = L + 6.289 * Math.sin(M);
  const beta = 5.128 * Math.sin(F);
  return eclipticToEcef(lambda, beta, jd);
}

export interface SkyState {
  sun: EcefDirection;
  moon: EcefDirection;
  /** Sun elevation at the supplied site, degrees. */
  sunElevationDeg: number;
  isDay: boolean;
  /** Site used for the elevation diagnostic. */
  site: { latDeg: number; lonDeg: number };
}

/**
 * Sky state for a declared demo epoch plus elapsed simulation seconds.
 * The optional site defaults to the inland launch datum; pass the manifest's
 * own `launchSite` so the elevation diagnostic never drifts from the data.
 */
export function skyStateAt(
  demoUtc: string,
  elapsedS: number,
  site: { latDeg: number; lonDeg: number } = { latDeg: 40, lonDeg: 110 },
): SkyState {
  const base = Date.parse(demoUtc);
  const ms = (Number.isFinite(base) ? base : Date.UTC(2026, 10, 20, 2, 0, 0)) + elapsedS * 1000;
  const sun = sunDirectionEcef(ms);
  const moon = moonDirectionEcef(ms);

  const lat = site.latDeg * DEG;
  const lon = site.lonDeg * DEG;
  const up = {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.cos(lat) * Math.sin(lon),
    z: Math.sin(lat),
  };
  const dot = sun.x * up.x + sun.y * up.y + sun.z * up.z;
  const sunElevationDeg = Math.asin(Math.max(-1, Math.min(1, dot))) / DEG;

  return { sun, moon, sunElevationDeg, isDay: sunElevationDeg > 0, site };
}
