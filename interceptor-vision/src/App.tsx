import { useEffect } from "react";
import { SceneCanvas } from "./scene/Scene";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { Transport } from "./components/Transport";
import { GalleryOverlay } from "./components/GalleryOverlay";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { useApp } from "./state";

export function App() {
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const fullscreenRequest = useApp((s) => s.fullscreenRequest);
  const galleryOpen = useApp((s) => s.galleryOpen);

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
        s.setPlaying(!s.playing);
      } else if (e.key === "Escape" && s.galleryOpen) {
        s.setGalleryOpen(false);
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
      <SceneCanvas />
      <div className="vignette" aria-hidden />
      <TopBar />
      <LeftPanel />
      <RightPanel />
      <Transport />
      {galleryOpen && <GalleryOverlay />}
      <LoadingOverlay />
    </div>
  );
}
