import * as THREE from "three";
import type { CameraMode, Livery, TimeOfDay } from "../state";

export const ASSET_BASE = `${import.meta.env.BASE_URL}assets/`;

/**
 * Cache-busting version for the long-lived asset filenames. Bump it whenever
 * the Blender pipeline rewrites a GLB, HDRI or texture in place.
 */
export const ASSET_VERSION = "3";

export const asset = (file: string) => `${ASSET_BASE}${file}?v=${ASSET_VERSION}`;

export const MISSILE_LODS = [
  asset("interceptor-lod0.glb"),
  asset("interceptor-lod1.glb"),
  asset("interceptor-lod2.glb"),
];

export interface SkyPreset {
  label: TimeOfDay;
  sunDir: THREE.Vector3;
  sunColor: string;
  sunIntensity: number;
  moonDir: THREE.Vector3;
  moonIntensity: number;
  zenith: string;
  horizon: string;
  hazeColor: string;
  ground: string;
  envIntensity: number;
  exposure: number;
  stars: number;
  cloudTint: string;
  cloudOpacity: number;
}

export const SKY_PRESETS: Record<TimeOfDay, SkyPreset> = {
  day: {
    label: "day",
    sunDir: new THREE.Vector3(-0.42, 0.72, -0.55).normalize(),
    sunColor: "#fff4e2",
    sunIntensity: 2.15,
    moonDir: new THREE.Vector3(0.4, -0.5, 0.7).normalize(),
    moonIntensity: 0,
    zenith: "#0b2340",
    horizon: "#9cc0dd",
    hazeColor: "#a8c6dd",
    ground: "#6c7a88",
    envIntensity: 0.72,
    exposure: 0.95,
    stars: 0,
    cloudTint: "#dfe7ee",
    cloudOpacity: 0.5,
  },
  dusk: {
    label: "dusk",
    sunDir: new THREE.Vector3(-0.88, 0.1, -0.46).normalize(),
    sunColor: "#ffad74",
    sunIntensity: 1.9,
    moonDir: new THREE.Vector3(0.4, -0.2, 0.8).normalize(),
    moonIntensity: 0,
    zenith: "#0d1a33",
    horizon: "#d9814f",
    hazeColor: "#c58b6c",
    ground: "#5b616b",
    envIntensity: 0.66,
    exposure: 1.02,
    stars: 0.18,
    cloudTint: "#e6b696",
    cloudOpacity: 0.46,
  },
  night: {
    label: "night",
    sunDir: new THREE.Vector3(-0.5, -0.28, -0.4).normalize(),
    sunColor: "#5c7bb5",
    sunIntensity: 0.1,
    moonDir: new THREE.Vector3(-0.35, 0.48, -0.8).normalize(),
    moonIntensity: 1.35,
    zenith: "#02040a",
    horizon: "#111d30",
    hazeColor: "#0d1726",
    ground: "#111a26",
    envIntensity: 0.5,
    exposure: 1.35,
    stars: 1,
    cloudTint: "#6b7d99",
    cloudOpacity: 0.5,
  },
};

/** Missile finishes: body paint plus the accent used on fins and the stripe. */
export const LIVERY: Record<Livery, { paint: string; accent: string }> = {
  sky: { paint: "#c7d1da", accent: "#1f8fb0" },
  sunrise: { paint: "#c0c6cb", accent: "#b8542c" },
  arctic: { paint: "#828b94", accent: "#3f4a55" },
};

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export const CAMERA_POSES: Record<Exclude<CameraMode, "cinematic" | "free">, CameraPose> = {
  macro: {
    position: [24, 20, 108],
    target: [0, -6, -30],
    fov: 46,
  },
  meso: {
    position: [7.6, 0.3, 6.9],
    target: [0, 1.5, 0],
    fov: 34,
  },
  micro: {
    position: [5.9, 1.15, 2.75],
    target: [2.15, 0.3, 0.15],
    fov: 34,
  },
};

/** Camera spline for the cinematic mode, sampled over CINEMATIC_SECONDS. */
export const CINEMATIC_SECONDS = 24;

export const CINEMATIC_PATH: CameraPose[] = [
  { position: [11.5, 3.2, 10.5], target: [0, 0, 0], fov: 38 },
  { position: [6.2, 1.2, 5.2], target: [0.4, 0, 0], fov: 36 },
  { position: [2.6, 0.5, 3.1], target: [1.2, 0, 0.2], fov: 33 },
  { position: [0.2, 0.9, 2.6], target: [2.2, 0, 0], fov: 31 },
  { position: [-2.4, 1.3, 3.0], target: [-1.8, 0, 0.2], fov: 31 },
  { position: [-4.6, 1.5, 3.8], target: [-2.6, -0.05, 0.4], fov: 30 },
  { position: [-6.2, 2.4, 5.6], target: [-2.2, 0, 0], fov: 33 },
  { position: [-9.5, 4.6, 11.5], target: [-1, -0.2, 0], fov: 36 },
  { position: [-24, 16, 40], target: [0, -0.6, 0], fov: 38 },
  { position: [24, 20, 108], target: [0, -6, -30], fov: 46 },
];
