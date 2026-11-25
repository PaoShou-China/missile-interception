import { useEffect } from "react";
import { SceneCanvas } from "./scene/Scene";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { Transport } from "./components/Transport";
import { GalleryOverlay } from "./components/GalleryOverlay";
import { ChartsOverlay } from "./components/ChartsOverlay";
import { MethodsOverlay } from "./components/MethodsOverlay";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { MapCredit } from "./components/MapCredit";
import { useApp } from "./state";
import type { CameraMode } from "./state";
import { useT } from "./i18n";
import { loadTelemetry, seekDataTime, toggleDataPlay } from "./data/telemetry";

export function App() {
  const t = useT();
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const compact = useApp((s) => s.compact);
  const fullscreenRequest = useApp((s) => s.fullscreenRequest);
  const galleryOpen = useApp((s) => s.galleryOpen);
  const chartsOpen = useApp((s) => s.chartsOpen);
  const methodsOpen = useApp((s) => s.methodsOpen);
  const ready = useApp((s) => s.ready);

  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => {
      void loadTelemetry()
        .then((tel) => {
          // Deep links (?t=seconds&view=meso) win; otherwise open on the midcourse
          // arc because the launch instant reads as a vertical spike.
          const params = new URLSearchParams(window.location.search);
          const rawT = Number(params.get("t"));
          const t = params.has("t") && Number.isFinite(rawT)
            ? Math.min(tel.end, Math.max(tel.start, rawT))
            : Math.min(300, Math.max(0, tel.end - 1));
          seekDataTime(t);
          const view = params.get("view");
          if (view && ["macro", "meso", "micro", "chase", "top", "cinematic", "free"].includes(view)) {
            useApp.getState().setCameraMode(view as CameraMode);
          }
        })
        .catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(id);
  }, [ready]);

  useEffect(() => {
    document.documentElement.lang = useApp.getState().lang === "zh" ? "zh-CN" : "en";
  }, []);

  // Phones get the rails as drawers: start closed so the scene is visible, and
  // keep the flag in sync when the window crosses the breakpoint.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => {
      const next = mq.matches;
      useApp.setState({ compact: next, leftOpen: !next, rightOpen: !next });
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
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
        toggleDataPlay();
      } else if (e.key === "Escape" && s.galleryOpen) {
        s.setGalleryOpen(false);
      } else if (e.key === "Escape" && s.chartsOpen) {
        s.setChartsOpen(false);
      } else if (e.key === "Escape" && s.methodsOpen) {
        s.setMethodsOpen(false);
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
      <div className="scene-layer">
        <SceneCanvas />
      </div>
      <div className="vignette" aria-hidden />
      <TopBar />
      {compact && (leftOpen || rightOpen) && (
        <button
          type="button"
          className="rail-backdrop"
          aria-label={t("close")}
          onClick={() => useApp.setState({ leftOpen: false, rightOpen: false })}
        />
      )}
      <LeftPanel />
      <RightPanel />
      <Transport />
      <MapCredit />
      {galleryOpen && <GalleryOverlay />}
      {chartsOpen && <ChartsOverlay />}
      {methodsOpen && <MethodsOverlay />}
      <LoadingOverlay />
    </div>
  );
}
