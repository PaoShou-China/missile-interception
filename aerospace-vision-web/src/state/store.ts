/**
 * Shared application state. The authoritative time lives in `simClock`
 * (a single SimulationClock instance); the store only mirrors it for UI
 * rendering at a throttled rate. 3D consumers read `simClock.time` directly
 * inside useFrame, so they never depend on React render cadence.
 */
import { create } from "zustand";
import type { ScenarioManifest, TrajectorySample } from "../scientific/types";
import { SimulationClock } from "../scientific/clock";
import { TrajectorySampler } from "../scientific/interpolate";
import type { CameraMode } from "./cameraModes";

export type { CameraMode };
export type PresentationMode = "scientific" | "cinematic" | "charts";
export type QualityLevel = "high" | "medium" | "low";
export type SidePanel = "mission" | "telemetry" | "charts";

export interface ScenarioRuntime {
  manifest: ScenarioManifest;
  missile: TrajectorySample[];
  target: TrajectorySample[];
  missileSampler: TrajectorySampler;
  targetSampler: TrajectorySampler;
}

export const simClock = new SimulationClock(0, 1);
/** Scientific-mode playback rate saved when cinematic mode takes over. */
let scientificRate = 20;

interface AppStore {
  runtime: ScenarioRuntime | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  time: number;
  start: number;
  end: number;
  rate: number;
  playing: boolean;
  cameraMode: CameraMode;
  presentation: PresentationMode;
  quality: QualityLevel;
  panels: Record<SidePanel, boolean>;
  mobilePanel: SidePanel;
  loadingProgress: number;
  hudVisible: boolean;
  trackEmphasis: boolean;

  setRuntime: (r: ScenarioRuntime) => void;
  setStatus: (s: "loading" | "ready" | "error", error?: string | null) => void;
  setProgress: (p: number) => void;
  syncTime: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setRate: (r: number) => void;
  seek: (t: number) => void;
  seekFraction: (f: number) => void;
  step: (dt: number) => void;
  reset: () => void;
  setCameraMode: (m: CameraMode) => void;
  setPresentation: (m: PresentationMode) => void;
  setQuality: (q: QualityLevel) => void;
  togglePanel: (p: SidePanel) => void;
  setMobilePanel: (p: SidePanel) => void;
  setHudVisible: (v: boolean) => void;
  toggleTrackEmphasis: () => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  runtime: null,
  status: "loading",
  error: null,
  time: 0,
  start: 0,
  end: 1,
  rate: 20,
  playing: false,
  cameraMode: "earth",
  presentation: "scientific",
  quality: "high",
  panels: { mission: true, telemetry: true, charts: true },
  mobilePanel: "telemetry",
  loadingProgress: 0,
  hudVisible: true,
  trackEmphasis: true,

  setRuntime: (runtime) => {
    const { startS, endS } = runtime.manifest.time;
    simClock.start = startS;
    simClock.end = endS;
    simClock.seek(startS);
    simClock.setRate(get().rate);
    set({
      runtime,
      start: startS,
      end: endS,
      time: startS,
      status: "ready",
      loadingProgress: 1,
      cameraMode: "earth",
    });
  },
  setStatus: (status, error = null) => set({ status, error }),
  setProgress: (loadingProgress) => set({ loadingProgress }),
  syncTime: () => set({ time: simClock.time, playing: simClock.playing }),

  play: () => { simClock.play(); set({ playing: true }); },
  pause: () => { simClock.pause(); set({ playing: false }); },
  toggle: () => {
    simClock.toggle();
    set({ playing: simClock.playing, time: simClock.time });
  },
  setRate: (rate) => {
    simClock.setRate(rate);
    set({ rate: simClock.rate });
  },
  seek: (t) => {
    simClock.seek(t);
    set({ time: simClock.time });
  },
  seekFraction: (f) => {
    simClock.seekFraction(f);
    set({ time: simClock.time });
  },
  step: (dt) => {
    simClock.step(dt);
    set({ time: simClock.time, playing: false });
  },
  reset: () => {
    simClock.reset();
    set({ time: simClock.time, playing: false });
  },
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setPresentation: (presentation) => {
    if (presentation === "cinematic") {
      scientificRate = get().rate;
      simClock.seek(simClock.start);
      simClock.play();
      set({ presentation, time: simClock.time, playing: true });
    } else if (presentation === "charts") {
      const wasPlaying = simClock.playing;
      if (wasPlaying) scientificRate = get().rate;
      simClock.pause();
      set({ presentation, playing: false });
    } else {
      simClock.setRate(scientificRate);
      set({ presentation, playing: simClock.playing, rate: scientificRate });
    }
  },
  setQuality: (quality) => set({ quality }),
  togglePanel: (p) => set((s) => ({ panels: { ...s.panels, [p]: !s.panels[p] } })),
  setMobilePanel: (p) => set((s) => ({
    mobilePanel: p,
    panels: { ...s.panels, [p]: true },
  })),
  setHudVisible: (hudVisible) => set({ hudVisible }),
  toggleTrackEmphasis: () => set((s) => ({ trackEmphasis: !s.trackEmphasis })),
}));
