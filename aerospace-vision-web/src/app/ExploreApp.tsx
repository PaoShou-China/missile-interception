import { Component, useEffect, type ReactNode } from "react";
import { SceneCanvas } from "../scene/SceneCanvas";
import { TopBar } from "../components/TopBar";
import { MissionPanel } from "../components/MissionPanel";
import { TelemetryPanel } from "../components/TelemetryPanel";
import { ChartsView } from "../components/ChartsView";
import { Timeline } from "../components/Timeline";
import { CameraDock } from "../components/CameraDock";
import { CinematicOverlay } from "../components/CinematicOverlay";
import { LoadingScreen } from "../components/LoadingScreen";
import { loadScenarioCached } from "../scientific/scenario";
import { TrajectorySampler } from "../scientific/interpolate";
import { useAppStore } from "../state/store";
import { useI18n } from "../i18n";
import { CAMERA_MODES } from "../state/cameraModes";
import { resetCameraInput } from "../scene/cameraInput";

class RenderErrorBoundary extends Component<{ children: ReactNode; title: string; body: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fatal">
          <h2>{this.props.title}</h2>
          <p>{this.state.error.message}</p>
          <p>{this.props.body}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ExploreApp() {
  const status = useAppStore((s) => s.status);
  const setRuntime = useAppStore((s) => s.setRuntime);
  const setStatus = useAppStore((s) => s.setStatus);
  const presentation = useAppStore((s) => s.presentation);
  const hudVisible = useAppStore((s) => s.hudVisible);
  const mobilePanel = useAppStore((s) => s.mobilePanel);
  const setMobilePanel = useAppStore((s) => s.setMobilePanel);
  const runtime = useAppStore((s) => s.runtime);
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    loadScenarioCached()
      .then(({ manifest, missile, target }) => {
        if (cancelled) return;
        setRuntime({
          manifest,
          missile,
          target,
          missileSampler: new TrajectorySampler(missile),
          targetSampler: new TrajectorySampler(target),
        });
        // Deep-link hydration (?t=...&view=...&rate=...&xray=1) from search or hash query.
        const hashQ = window.location.hash.includes("?") ? window.location.hash.split("?")[1] : "";
        const params = new URLSearchParams(hashQ || window.location.search);
        const st = useAppStore.getState();
        const rawT = Number(params.get("t"));
        if (params.has("t") && Number.isFinite(rawT)) st.seek(rawT);
        const view = params.get("view");
        if (view && (CAMERA_MODES as readonly string[]).includes(view)) {
          st.setCameraMode(view as (typeof CAMERA_MODES)[number]);
        }
        const rawRate = Number(params.get("rate"));
        if (params.has("rate") && Number.isFinite(rawRate) && rawRate > 0) st.setRate(rawRate);
        if (params.get("xray") === "1") st.setXrayMode(true);
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
      else if (e.key === "h" || e.key === "H") s.setHudVisible(!s.hudVisible);
      else if (e.key === "x" || e.key === "X") s.toggleXrayMode();
      else {
        const idx = Number(e.key);
        if (idx >= 1 && idx <= CAMERA_MODES.length) s.setCameraMode(CAMERA_MODES[idx - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showScientificUI = status === "ready" && hudVisible && presentation === "scientific";
  const showTimeline = status === "ready" && hudVisible && presentation !== "cinematic";

  return (
    <div className={`app-shell ${presentation === "cinematic" ? "is-cinematic" : ""} mobile-${mobilePanel}`}>
      <RenderErrorBoundary title="3D renderer unavailable" body={t("loading.webgl")}>
        <SceneCanvas
          missileLabel={t("entity.interceptor")}
          targetLabel={t("entity.target")}
          launchLabel={t("entity.launchSite")}
          targetDatumLabel={t("entity.targetDatum")}
        />
      </RenderErrorBoundary>

      <div className="vignette" aria-hidden />

      {runtime && <TopBar />}

      {showScientificUI && (
        <>
          <div className="mobile-tabs" role="tablist" aria-label={t("telemetry.eyebrow")}>
            {(["mission", "telemetry"] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={mobilePanel === p}
                className={mobilePanel === p ? "is-active" : ""}
                onClick={() => setMobilePanel(p)}
              >
                {t(`mobile.${p}`)}
              </button>
            ))}
          </div>
          <aside className="rail rail--left">
            <MissionPanel />
          </aside>
          <aside className="rail rail--right">
            <TelemetryPanel />
          </aside>
          <CameraDock />
          <div className="camera-help">
            <span>{t("camera.hint")}</span>
            <button type="button" onClick={resetCameraInput}>{t("camera.reset")}</button>
          </div>
        </>
      )}

      {status === "ready" && presentation === "charts" && <ChartsView />}
      {showTimeline && <Timeline />}

      {runtime && presentation === "cinematic" && <CinematicOverlay />}
      <LoadingScreen />
    </div>
  );
}
