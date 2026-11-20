/** Scene constants. Renderer units are kilometres in the ECEF frame. */
import { WGS84_A, WGS84_B } from "../scientific/geodesy";

export const KM = 1 / 1000;
export const EARTH_A_KM = WGS84_A * KM;
export const EARTH_B_KM = WGS84_B * KM;
export const EARTH_MEAN_KM = 6371.0;
/** First eccentricity squared of WGS84. */
export const WGS84_E2_KM = 0.00669437999014;

export const COLORS = {
  accent: "#37b9d8",
  accentSoft: "#9fe6f5",
  cyan: "#63e6ff",
  cyanSoft: "#b6f4ff",
  danger: "#ff6b6b",
  earthAtmosphere: "#3d8bff",
  space: "#02040a",
};

/** Sun/moon directions are computed per frame in `scientific/astronomy.ts`. */
export const ASSET_BASE = `${import.meta.env.BASE_URL}textures/`;
