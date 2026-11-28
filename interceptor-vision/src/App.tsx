import { useEffect, useState } from "react";
import { SceneCanvas } from "./scene/Scene";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { Transport } from "./components/Transport";
import { GalleryOverlay } from "./components/GalleryOverlay";
import { ChartsOverlay } from "./components/ChartsOverlay";
import { SeekerOverlay } from "./components/SeekerOverlay";
import { HudWindows } from "./components/HudWindows";
import { MethodsOverlay } from "./components/MethodsOverlay";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { MapCredit } from "./components/MapCredit";
import { useApp } from "./state";
import type { CameraMode } from "./state";
import { useT } from "./i18n";
import { dataClock, loadTelemetry, seekDataTime, toggleDataPlay } from "./data/telemetry";

function InterceptBanner() {
  const telemetry = useApp((s) => s.telemetry);
  const lang = useApp((s) => s.lang);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!telemetry) return;
    const id = window.setInterval(() => {
      const rem = telemetry.end - dataClock.t;
      setVisible(rem >= -0.5 && rem <= 1.2);
    }, 120);
    return () => window.clearInterval(id);
  }, [telemetry]);

  if (!visible || !telemetry) return null;
  const miss = telemetry.metrics.missDistanceM;
  const pk = telemetry.metrics.killProbability;
  const hit = miss != null && miss <= 15;

  return (
    <div className={`intercept-banner ${hit ? "is-hit" : "is-miss"}`} role="status">
      <span className="intercept-banner__dot" />
      <strong>{hit ? (lang === "zh" ? "拦截成功" : "INTERCEPT HIT") : (lang === "zh" ? "交会完成" : "CLOSEST APPROACH")}</strong>
      {miss != null && <span>{lang === "zh" ? `脱靶 ${miss.toFixed(2)} m` : `Miss ${miss.toFixed(2)} m`}</span>}
      {pk != null && <span>{`Pk ${(pk * 100).toFixed(1)}%`}</span>}
    </div>
  );
}

export function App() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const compact = useApp((s) => s.compact);
  const fullscreenRequest = useApp((s) => s.fullscreenRequest);
  const galleryOpen = useApp((s) => s.galleryOpen);
  const chartsOpen = useApp((s) => s.chartsOpen);
  const seekerOpen = useApp((s) => s.seekerOpen);
  const methodsOpen = useApp((s) => s.methodsOpen);
  const ready = useApp((s) => s.ready);
  const [welcome, setWelcome] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
          if (view && ["macro", "meso", "micro", "chase", "top", "target", "cinematic", "free"].includes(view)) {
            useApp.getState().setCameraMode(view as CameraMode);
          }
          if (params.get("xray") === "1") {
            useApp.getState().setXrayOpen(true);
          }
          const rawRate = Number(params.get("rate"));
          if (params.has("rate") && Number.isFinite(rawRate) && rawRate > 0) {
            useApp.getState().setDataRate(rawRate);
          }
          if (!useApp.getState().dataPlaying) toggleDataPlay();
          setWelcome(true);
          window.setTimeout(() => setWelcome(false), 3800);
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
      } else if (e.key === "Escape" && s.seekerOpen) {
        s.setSeekerOpen(false);
      } else if (e.key === "Escape" && s.methodsOpen) {
        s.setMethodsOpen(false);
      } else if (e.key === "Escape" && (s.hudSpace || s.hudRadar || s.hudIr || s.hudCharts)) {
        s.setHudSpace(false);
        s.setHudRadar(false);
        s.setHudIr(false);
        s.setHudCharts(false);
      } else if (e.key === "Escape" && shortcutsOpen) {
        setShortcutsOpen(false);
      } else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        setShortcutsOpen((v) => !v);
      } else if (e.key === "1") {
        s.setCameraMode("macro");
      } else if (e.key === "2") {
        s.setCameraMode("chase");
      } else if (e.key === "3") {
        s.setCameraMode("target");
      } else if (e.key === "4") {
        s.setCameraMode("free");
      } else if (e.key.toLowerCase() === "r") {
        s.setSeekerOpen(!s.seekerOpen);
      } else if (e.key.toLowerCase() === "x") {
        s.setXrayOpen(!s.xrayOpen);
      } else if (e.key.toLowerCase() === "g") {
        s.setHudSpace(!s.hudSpace);
      } else if (e.key.toLowerCase() === "i") {
        s.setHudIr(!s.hudIr);
      } else if (e.key.toLowerCase() === "c") {
        s.setHudCharts(!s.hudCharts);
      } else if (e.key.toLowerCase() === "w") {
        s.toggleCommandDeck();
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
      <InterceptBanner />
      {welcome && (
        <div className="welcome-toast" role="status">
          {lang === "zh"
            ? "拖动旋转视角 · 点击下方按钮一键看高光 · 按 ? 查看快捷键"
            : "Drag to orbit · Use Quick Jump below · Press ? for shortcuts"}
        </div>
      )}
      {shortcutsOpen && (
        <div className="shortcuts-backdrop" onClick={() => setShortcutsOpen(false)}>
          <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()} role="dialog">
            <div className="shortcuts-modal__head">
              <strong>{lang === "zh" ? "快捷键速查" : "Keyboard Shortcuts"}</strong>
              <button type="button" onClick={() => setShortcutsOpen(false)}>×</button>
            </div>
            <dl className="shortcuts-list">
              <div><dt>Space</dt><dd>{lang === "zh" ? "播放 / 暂停" : "Play / Pause"}</dd></div>
              <div><dt>1 / 2 / 3 / 4</dt><dd>{lang === "zh" ? "切换 宏观 / 尾追 / 目标 / 自由 视角" : "Switch Macro / Chase / Target / Free"}</dd></div>
              <div><dt>R</dt><dd>{lang === "zh" ? "打开 / 关闭 双模雷达与红外导引头" : "Toggle Dual-Mode Radar/IR Seeker"}</dd></div>
              <div><dt>H</dt><dd>{lang === "zh" ? "隐藏 / 显示 左右面板" : "Toggle Side Panels"}</dd></div>
              <div><dt>S / F</dt><dd>{lang === "zh" ? "高清截图 / 全屏切换" : "Screenshot / Fullscreen"}</dd></div>
              <div><dt>?</dt><dd>{lang === "zh" ? "打开 / 关闭 本快捷键面板" : "Toggle Shortcuts"}</dd></div>
            </dl>
          </div>
        </div>
      )}
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
      <HudWindows />
      {galleryOpen && <GalleryOverlay />}
      {chartsOpen && <ChartsOverlay />}
      {seekerOpen && <SeekerOverlay />}
      {methodsOpen && <MethodsOverlay />}
      <LoadingOverlay />
    </div>
  );
}
