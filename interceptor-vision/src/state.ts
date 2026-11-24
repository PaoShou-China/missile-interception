import { create } from "zustand";
import type { Telemetry } from "./data/telemetry";
import { dataClock } from "./data/dataClock";

export type TimeOfDay = "day" | "dusk" | "night";
export type Quality = "performance" | "balanced" | "cinematic";
export type CameraMode = "macro" | "meso" | "micro" | "chase" | "top" | "cinematic" | "free";
export type Livery = "sky" | "sunrise" | "arctic";
export type Lang = "zh" | "en";

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

interface AppState {
  lang: Lang;
  setLang: (l: Lang) => void;

  ready: boolean;
  setReady: (v: boolean) => void;

  timeOfDay: TimeOfDay;
  setTimeOfDay: (t: TimeOfDay) => void;

  quality: Quality;
  setQuality: (q: Quality) => void;

  cameraMode: CameraMode;
  setCameraMode: (m: CameraMode) => void;

  livery: Livery;
  setLivery: (l: Livery) => void;

  cloudDensity: number;
  setCloudDensity: (v: number) => void;

  haze: number;
  setHaze: (v: number) => void;

  exposure: number;
  setExposure: (v: number) => void;

  shadows: boolean;
  setShadows: (v: boolean) => void;

  horizon: boolean;
  setHorizon: (v: boolean) => void;

  leftOpen: boolean;
  rightOpen: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;

  /** Cinematic transport (shared by the live camera path). */
  playing: boolean;
  time: number;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;

  /** Validated telemetry replay (loaded lazily after the first frame). */
  telemetry: Telemetry | null;
  dataStatus: "idle" | "loading" | "ready" | "error";
  dataTime: number;
  dataPlaying: boolean;
  dataRate: number;
  chartsOpen: boolean;
  setTelemetry: (t: Telemetry | null) => void;
  setDataStatus: (s: "idle" | "loading" | "ready" | "error") => void;
  setDataTime: (t: number) => void;
  setDataPlaying: (p: boolean) => void;
  setDataRate: (r: number) => void;
  setChartsOpen: (v: boolean) => void;

  galleryOpen: boolean;
  setGalleryOpen: (v: boolean) => void;

  screenshotRequest: number;
  requestScreenshot: () => void;

  fullscreenRequest: number;
  requestFullscreen: () => void;

  fps: number;
  setFps: (v: number) => void;

  resetViewRequest: number;
  requestResetView: () => void;
}

export const useApp = create<AppState>((set) => ({
  lang: (localStorage.getItem("cav.lang") as Lang) || "zh",
  setLang: (lang) => {
    localStorage.setItem("cav.lang", lang);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    set({ lang });
  },

  ready: false,
  setReady: (ready) => set({ ready }),

  timeOfDay: "day",
  setTimeOfDay: (timeOfDay) => set({ timeOfDay }),

  quality: "balanced",
  setQuality: (quality) => set({ quality }),

  cameraMode: "meso",
  setCameraMode: (cameraMode) => set({ cameraMode }),

  livery: "sky",
  setLivery: (livery) => set({ livery }),

  cloudDensity: 0.6,
  setCloudDensity: (cloudDensity) => set({ cloudDensity }),

  haze: 0.45,
  setHaze: (haze) => set({ haze }),

  exposure: 1.05,
  setExposure: (exposure) => set({ exposure }),

  shadows: true,
  setShadows: (shadows) => set({ shadows }),

  horizon: true,
  setHorizon: (horizon) => set({ horizon }),

  leftOpen: true,
  rightOpen: true,
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),

  playing: true,
  time: 0,
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),

  telemetry: null,
  dataStatus: "idle",
  dataTime: 0,
  dataPlaying: false,
  dataRate: 20,
  chartsOpen: false,
  setTelemetry: (telemetry) => set({ telemetry }),
  setDataStatus: (dataStatus) => set({ dataStatus }),
  setDataTime: (dataTime) => {
    dataClock.t = dataTime;
    set({ dataTime });
  },
  setDataPlaying: (dataPlaying) => {
    dataClock.playing = dataPlaying;
    set({ dataPlaying });
  },
  setDataRate: (dataRate) => {
    dataClock.rate = dataRate;
    set({ dataRate });
  },
  setChartsOpen: (chartsOpen) => set({ chartsOpen }),

  galleryOpen: false,
  setGalleryOpen: (galleryOpen) => set({ galleryOpen }),

  screenshotRequest: 0,
  requestScreenshot: () => set((s) => ({ screenshotRequest: s.screenshotRequest + 1 })),

  fullscreenRequest: 0,
  requestFullscreen: () => set((s) => ({ fullscreenRequest: s.fullscreenRequest + 1 })),

  fps: 60,
  setFps: (fps) => set({ fps }),

  resetViewRequest: 0,
  requestResetView: () => set((s) => ({ resetViewRequest: s.resetViewRequest + 1 })),
}));
