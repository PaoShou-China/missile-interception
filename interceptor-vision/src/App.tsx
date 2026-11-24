import { useEffect } from "react";
import { SceneCanvas } from "./scene/Scene";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { Transport } from "./components/Transport";
import { GalleryOverlay } from "./components/GalleryOverlay";
import { ChartsOverlay } from "./components/ChartsOverlay";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { useApp } from "./state";
import { loadTelemetry } from "./data/telemetry";
import { toggleDataPlay } from "./data/telemetry";
import { OrbitalScene } from "./orbital/OrbitalScene";
import { CinematicOverlay } from "./orbital/components/CinematicOverlay";
import { useAppStore as useOrbitalStore } from "./orbital/state/store";

export function App() {
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const fullscreenRequest = useApp((s) => s.fullscreenRequest);
  const galleryOpen = useApp((s) => s.galleryOpen);
  const chartsOpen = useApp((s) => s.chartsOpen);
  const ready = useApp((s) => s.ready);
  const sceneMode = useApp((s) => s.sceneMode);
  const orbitalPresentation = useOrbitalStore((s) => s.presentation);
  const cinematic = sceneMode === "orbital" && orbitalPresentation === "cinematic";

  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => {
      void loadTelemetry().catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(id);
  }, [ready]);

  useEffect(() => {
    document.documentElement.lang = useApp.getState().lang === "zh" ? "zh-CN" : "en";
  }, []);

  useEffect(() => {
    if (fullscreenRequest === 0) return;
    const root = document.documentElement;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void root.requestFullscreen?.().catch(() => undefined);
    }
  }, [fullscreenRequest]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      const target = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (s.sceneMode === "orbital" && useOrbitalStore.getState().presentation !== "cinematic") {
          toggleDataPlay();
        } else {
          s.setPlaying(!s.playing);
        }
      } else if (e.key === "Escape" && s.galleryOpen) {
        s.setGalleryOpen(false);
      } else if (e.key === "Escape" && s.chartsOpen) {
        s.setChartsOpen(false);
      } else if (e.key === "Escape" && useOrbitalStore.getState().presentation === "cinematic") {
        useOrbitalStore.getState().setPresentation("scientific");
      } else if (e.key.toLowerCase() === "s") {
        s.requestScreenshot();
      } else if (e.key.toLowerCase() === "f") {
        s.requestFullscreen();
      } else if (e.key.toLowerCase() === "h") {
        s.toggleLeft();
        s.toggleRight();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`app-shell ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`}>
      {sceneMode === "orbital" ? <OrbitalScene /> : <SceneCanvas />}
      <div className="vignette" aria-hidden />
      {!cinematic && (
        <>
          <TopBar />
          <LeftPanel />
          <RightPanel />
          <Transport />
        </>
      )}
      {cinematic && <CinematicOverlay />}
      {galleryOpen && <GalleryOverlay />}
      {chartsOpen && <ChartsOverlay />}
      <LoadingOverlay />
    </div>
  );
}
