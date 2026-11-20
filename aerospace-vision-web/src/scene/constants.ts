/** Scene constants. Renderer units are kilometres in the ECEF frame. */
import { WGS84_A, WGS84_B } from "../scientific/geodesy";

export const KM = 1 / 1000;
export const EARTH_A_KM = WGS84_A * KM;
export const EARTH_B_KM = WGS84_B * KM;
export const EARTH_MEAN_KM = 6371.0;
/** First eccentricity squared of WGS84. */
export const WGS84_E2_KM = 0.00669437999014;

export const COLORS = {
  accent: "#ffb257",
  accentSoft: "#ffd9a0",
  cyan: "#63e6ff",
  cyanSoft: "#b6f4ff",
  danger: "#ff6b6b",
  earthAtmosphere: "#3d8bff",
  space: "#02040a",
};

/** Sun direction in ECEF, used only for scene lighting (not astrodynamics). */
export const SUN_DIR = (() => {
  const lat = (24 * Math.PI) / 180;
  const lon = (96 * Math.PI) / 180;
  const v = {
    x: Math.cos(lat) * Math.cos(lon) + 0.28,
    y: Math.cos(lat) * Math.sin(lon) - 0.18,
    z: Math.sin(lat) + 0.42,
  };
  const n = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / n, y: v.y / n, z: v.z / n };
})();

export const ASSET_BASE = `${import.meta.env.BASE_URL}textures/`;
