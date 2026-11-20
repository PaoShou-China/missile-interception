import { Component, useEffect, type ReactNode } from "react";
import { SceneCanvas } from "../scene/SceneCanvas";
import { TopBar } from "../components/TopBar";
import { MissionPanel } from "../components/MissionPanel";
import { TelemetryPanel } from "../components/TelemetryPanel";
import { ChartsPanel } from "../components/ChartsPanel";
import { Timeline } from "../components/Timeline";
import { CameraDock } from "../components/CameraDock";
import { CinematicOverlay } from "../components/CinematicOverlay";
import { LoadingScreen } from "../components/LoadingScreen";
import { loadScenario } from "../scientific/scenario";
import { TrajectorySampler } from "../scientific/interpolate";
import { useAppStore } from "../state/store";

class RenderErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fatal">
          <h2>3D renderer unavailable</h2>
          <p>{this.state.error.message}</p>
          <p>This build requires WebGL 2. Try a current desktop browser with hardware acceleration enabled.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const status = useAppStore((s) => s.status);
  const setRuntime = useAppStore((s) => s.setRuntime);
  const setStatus = useAppStore((s) => s.setStatus);
  const presentation = useAppStore((s) => s.presentation);
  const hudVisible = useAppStore((s) => s.hudVisible);
  const panels = useAppStore((s) => s.panels);
  const runtime = useAppStore((s) => s.runtime);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    loadScenario()
      .then(({ manifest, missile, target }) => {
        if (cancelled) return;
        setRuntime({
          manifest,
          missile,
          target,
          missileSampler: new TrajectorySampler(missile),
          targetSampler: new TrajectorySampler(target),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error", err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [setRuntime, setStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
      const s = useAppStore.getState();
      if (!s.runtime) return;
      if (e.code === "Space") { e.preventDefault(); s.toggle(); }
      else if (e.key === "ArrowRight") { s.step(e.shiftKey ? 30 : 5); }
      else if (e.key === "ArrowLeft") { s.step(e.shiftKey ? -30 : -5); }
      else if (e.key === "r" || e.key === "R") { s.reset(); }
      else if (e.key === "Escape" && s.presentation === "cinematic") { s.setPresentation("scientific"); }
      else if (e.key === "1") s.setCameraMode("earth");
      else if (e.key === "2") s.setCameraMode("chase");
      else if (e.key === "3") s.setCameraMode("top");
      else if (e.key === "4") s.setCameraMode("target");
      else if (e.key === "5") s.setCameraMode("free");
      else if (e.key === "h" || e.key === "H") s.setHudVisible(!s.hudVisible);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showUI = status === "ready" && hudVisible && presentation === "scientific";

  return (
    <div className={`app-shell ${presentation === "cinematic" ? "is-cinematic" : ""}`}>
      <RenderErrorBoundary>
        <SceneCanvas />
      </RenderErrorBoundary>

      <div className="vignette" aria-hidden />

      {runtime && <TopBar />}

      {showUI && (
        <>
          <aside className="rail rail--left">
            <MissionPanel />
          </aside>
          <aside className="rail rail--right">
            <TelemetryPanel />
            {panels.charts && <ChartsPanel />}
          </aside>
          <CameraDock />
          <Timeline />
        </>
      )}

      {runtime && presentation === "cinematic" && <CinematicOverlay />}
      <LoadingScreen />
    </div>
  );
}

