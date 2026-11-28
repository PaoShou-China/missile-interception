import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { useManifest } from "./useManifest";
import { useAppStore, simClock } from "../state/store";
import { TrajectorySampler } from "../scientific/interpolate";
import { SceneCanvas } from "../scene/SceneCanvas";
import { SpaceBasedCard } from "../components/SpaceBasedCard";
import {
  MissBudgetWaterfallCard,
  PerformanceRadarCard,
  RcsPolarCard,
  SeekerThermalDualCard,
} from "../components/SensorAnalyticsCards";
import { AcademicChart } from "../components/AcademicChart";
import { Timeline } from "../components/Timeline";
import type { TrajectorySample } from "../scientific/types";
import type { CameraMode } from "../state/cameraModes";

type WinId = "globe" | "space" | "radar" | "ir" | "lines" | "summary";
type LineTab = "all" | "traj" | "load" | "ctrl" | "sensor" | "thermal" | "mass" | "imm";

function pairs(samples: TrajectorySample[], fn: (s: TrajectorySample) => number) {
  const stride = Math.max(1, Math.ceil(samples.length / 480));
  const out: [number, number][] = [];
  for (let i = 0; i < samples.length; i += stride) out.push([samples[i].t, fn(samples[i])]);
  const last = samples[samples.length - 1];
  out.push([last.t, fn(last)]);
  return out;
}

function sampleAtTime(samples: TrajectorySample[], t: number): TrajectorySample {
  if (t <= samples[0].t) return samples[0];
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1];
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(samples[hi].t - t) < Math.abs(t - samples[lo].t) ? samples[hi] : samples[lo];
}

export function MonitorPage() {
  const { t, lang } = useI18n();
  const { manifest } = useManifest();
  const runtime = useAppStore((s) => s.runtime);
  const setRuntime = useAppStore((s) => s.setRuntime);
  const time = useAppStore((s) => s.time);
  const playing = useAppStore((s) => s.playing);
  const seek = useAppStore((s) => s.seek);
  const cameraMode = useAppStore((s) => s.cameraMode);
  const setCameraMode = useAppStore((s) => s.setCameraMode);
  const xrayMode = useAppStore((s) => s.xrayMode);
  const toggleXrayMode = useAppStore((s) => s.toggleXrayMode);

  const [visible, setVisible] = useState<Record<WinId, boolean>>({
    globe: true,
    space: true,
    radar: true,
    ir: true,
    lines: true,
    summary: true,
  });
  const [expanded, setExpanded] = useState<WinId | null>(null);
  const [lineTab, setLineTab] = useState<LineTab>("all");

  // Hydrate shared 3D runtime once manifest is loaded so SceneCanvas & Timeline share one clock.
  useEffect(() => {
    if (!manifest) return;
    if (runtime && runtime.manifest.id === manifest.id) return;
    const missile = manifest.entities.find((e) => e.kind === "missile")?.samples ?? [];
    const target = manifest.entities.find((e) => e.kind === "target")?.samples ?? [];
    if (!missile.length) return;
    setRuntime({
      manifest,
      missile,
      target,
      missileSampler: new TrajectorySampler(missile),
      targetSampler: new TrajectorySampler(target),
    });
    // Start in terminal lock phase so Radar, MWIR, Space-Based Track and Globe are all immediately active.
    simClock.seek(Math.max(0, manifest.time.endS - 3.5));
    useAppStore.getState().syncTime();
  }, [manifest, runtime, setRuntime]);

  // Keep all 6 windows synchronized during playback (and drive simClock even when the 3D globe is closed).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let prev = performance.now();
    let lastSync = prev;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      if (!visible.globe) {
        simClock.tick(dt);
      }
      if (now - lastSync >= 80) {
        lastSync = now;
        useAppStore.getState().syncTime();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, visible.globe]);

  const data = useMemo(() => {
    if (!manifest) return null;
    const missile = manifest.entities.find((e) => e.kind === "missile")?.samples ?? [];
    const target = manifest.entities.find((e) => e.kind === "target")?.samples ?? [];
    if (!missile.length) return null;
    return {
      missile,
      target,
      altSpeed: [
        { name: lang === "zh" ? "高度 km" : "Alt km", color: "#005BAC", data: pairs(missile, (s) => +(s.altM / 1000).toFixed(2)) },
        { name: lang === "zh" ? "速度 m/s" : "Speed m/s", color: "#37B9D8", data: pairs(missile, (s) => +s.speedMS.toFixed(0)), yAxisIndex: 1 },
      ],
      machRange: [
        { name: "Mach", color: "#D97706", data: pairs(missile, (s) => +s.mach.toFixed(2)) },
        { name: lang === "zh" ? "斜距 km" : "Range km", color: "#2563EB", data: pairs(missile, (s) => +(s.rangeM / 1000).toFixed(1)), yAxisIndex: 1 },
      ],
      qLoad: [
        { name: lang === "zh" ? "动压 kPa" : "q kPa", color: "#2078BF", data: pairs(missile, (s) => +(s.qPa / 1000).toFixed(2)) },
        { name: lang === "zh" ? "实际过载 g" : "Load g", color: "#C0562B", data: pairs(missile, (s) => +s.loadG.toFixed(2)), yAxisIndex: 1 },
        { name: lang === "zh" ? "指令过载 g" : "Cmd g", color: "#F59E0B", data: pairs(missile, (s) => +s.loadCmdG.toFixed(2)), yAxisIndex: 1 },
      ],
      fins: [
        { name: "up°", color: "#005BAC", data: pairs(missile, (s) => +((s.finDeflectionsRad?.up ?? 0) * 57.2958).toFixed(2)) },
        { name: "right°", color: "#37B9D8", data: pairs(missile, (s) => +((s.finDeflectionsRad?.right ?? 0) * 57.2958).toFixed(2)) },
        { name: "q °/s", color: "#C0562B", data: pairs(missile, (s) => +((s.bodyRatesRadS?.q ?? 0) * 57.2958).toFixed(2)), yAxisIndex: 1 },
      ],
      massStability: [
        { name: lang === "zh" ? "质量 kg" : "Mass kg", color: "#38BDF8", data: pairs(missile, (s) => +s.massKg.toFixed(1)) },
        { name: "CG m", color: "#F59E0B", data: pairs(missile, (s) => +(s.cgPos ?? 4.2).toFixed(2)), yAxisIndex: 1 },
        { name: "CP m", color: "#22C55E", data: pairs(missile, (s) => +(s.cpPos ?? 4.9).toFixed(2)), yAxisIndex: 1 },
      ],
      snr: [
        { name: "Radar dB", color: "#0F8B5F", data: pairs(missile, (s) => +(s.radarSnrDb ?? -60).toFixed(1)) },
        { name: "IIR dB", color: "#D96B27", data: pairs(missile, (s) => +(s.irSnrDb ?? -60).toFixed(1)) },
        { name: "RCS m²", color: "#2078BF", data: pairs(missile, (s) => +(s.targetRcsM2 ?? 0.005).toFixed(4)), yAxisIndex: 1 },
      ],
      thermal: [
        { name: "q̇s MW/m²", color: "#C0392B", data: pairs(missile, (s) => +(s.heatFluxMWm2 ?? 0).toFixed(2)) },
        { name: "Tw K", color: "#D97706", data: pairs(missile, (s) => +(s.wallTempK ?? 288).toFixed(0)), yAxisIndex: 1 },
        { name: "Teq K", color: "#9B2C2C", data: pairs(missile, (s) => +(s.wallTempEqK ?? s.wallTempK ?? 288).toFixed(0)), yAxisIndex: 1 },
      ],
      imm: [
        { name: "CV", color: "#005BAC", data: pairs(missile, (s) => +(s.immPCv ?? 0.34).toFixed(3)) },
        { name: "CA/Singer", color: "#D96B27", data: pairs(missile, (s) => +(s.immPCa ?? 0.33).toFixed(3)) },
        { name: "3D-CT", color: "#0F8B5F", data: pairs(missile, (s) => +(s.immPCt ?? 0.33).toFixed(3)) },
      ],
    };
  }, [manifest, lang]);

  const curSample = useMemo(
    () => (data ? sampleAtTime(data.missile, time) : null),
    [data, time],
  );

  const toggleWin = (id: WinId) => {
    setVisible((v) => ({ ...v, [id]: !v[id] }));
    if (expanded === id) setExpanded(null);
  };

  const toggleExpand = (id: WinId) => {
    setExpanded((cur) => (cur === id ? null : id));
  };

  const winMeta: { id: WinId; icon: string; zh: string; en: string }[] = [
    { id: "globe", icon: "🌍", zh: "天基 3D 地球轨道", en: "Space 3D Globe" },
    { id: "space", icon: "🛰️", zh: "天基预警态势图", en: "SBIRS Space Track" },
    { id: "radar", icon: "📡", zh: "雷达图与 360° RCS", en: "Radar & 360° RCS" },
    { id: "ir", icon: "🔥", zh: "红外热像与气动热", en: "MWIR & Thermal" },
    { id: "lines", icon: "📈", zh: "各类状态线图", en: "State Line Charts" },
    { id: "summary", icon: "🎯", zh: "性能雷达 & B-Plane", en: "Perf Radar & B-Plane" },
  ];

  const camModes: { id: CameraMode; zh: string; en: string }[] = [
    { id: "earth", zh: "天基轨道", en: "Orbital" },
    { id: "chase", zh: "尾追", en: "Chase" },
    { id: "target", zh: "拦截", en: "Intercept" },
    { id: "closeup", zh: "近景", en: "Close-up" },
  ];

  return (
    <article className="page monitor-page">
      <header className="monitor-head">
        <div>
          <p className="kicker">MISSION CONTROL · MULTI-WINDOW TELEMETRY</p>
          <h1>{lang === "zh" ? "多维指挥监控台（雷达 · 红外 · 天基 · 状态线图）" : "Multi-Window Mission Control (Radar · IR · Space · Telemetry)"}</h1>
          <p className="lede">
            {lang === "zh"
              ? "同一仿真时钟同步驱动天基 3D 地球轨道、SBIRS 战区轨下点、X 波段脉冲多普勒雷达、MWIR 红外成像与全套飞行状态线图。点击上方标签自由开关或展开任意窗口。"
              : "One authoritative clock drives the 3D orbital globe, SBIRS ground track, X-band pulse-Doppler radar, MWIR thermal FPA, and full flight-state time series simultaneously."}
          </p>
        </div>
        <div className="monitor-head__actions">
          <a className="btn btn--primary" href="#/explore">
            {lang === "zh" ? "进入全屏 3D 探索器" : "Full 3D Explorer"}
          </a>
        </div>
      </header>

      {/* Window visibility & preset bar */}
      <div className="mon-toolbar" role="toolbar" aria-label={lang === "zh" ? "监控窗口开关" : "Monitor window toggles"}>
        {winMeta.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`mon-pill ${visible[w.id] ? "is-active" : ""}`}
            aria-pressed={visible[w.id]}
            onClick={() => toggleWin(w.id)}
          >
            <span>{w.icon}</span> {lang === "zh" ? w.zh : w.en}
          </button>
        ))}
        <button
          type="button"
          className="mon-pill mon-pill--ghost"
          onClick={() => {
            setVisible({ globe: true, space: true, radar: true, ir: true, lines: true, summary: true });
            setExpanded(null);
          }}
        >
          {lang === "zh" ? "⊞ 全部显示" : "⊞ Show All"}
        </button>
      </div>

      {/* Live synchronized numeric readout strip */}
      {curSample && (
        <div className="mon-live-strip">
          <span><b>T</b> {curSample.t.toFixed(1)} s</span>
          <span><b>{lang === "zh" ? "阶段" : "PHASE"}</b> {curSample.phase.toUpperCase()}</span>
          <span><b>{lang === "zh" ? "高度" : "ALT"}</b> {(curSample.altM / 1000).toFixed(2)} km</span>
          <span><b>Ma</b> {curSample.mach.toFixed(2)}</span>
          <span><b>q∞</b> {(curSample.qPa / 1000).toFixed(1)} kPa</span>
          <span><b>q̇s</b> {(curSample.heatFluxMWm2 ?? 0).toFixed(2)} MW/m²</span>
          <span><b>Tw</b> {(curSample.wallTempK ?? 288).toFixed(0)} K</span>
          <span><b>Radar</b> {(curSample.radarSnrDb ?? -60).toFixed(1)} dB</span>
          <span><b>MWIR</b> {(curSample.irSnrDb ?? -60).toFixed(1)} dB</span>
          <span><b>{lang === "zh" ? "斜距" : "R"}</b> {(curSample.rangeM / 1000).toFixed(2)} km</span>
        </div>
      )}

      {/* Synchronized Timeline Transport */}
      {runtime && (
        <div className="mon-timeline-wrap">
          <Timeline />
        </div>
      )}

      {/* Multi-window interactive grid */}
      {manifest && data && curSample && (
        <div className="mon-grid">
          {/* Window 1: Space-Based 3D Earth Globe */}
          {visible.globe && (
            <section className={`mon-win ${expanded === "globe" ? "mon-win--wide" : ""}`}>
              <header className="mon-win__head">
                <div className="mon-win__title">🌍 {lang === "zh" ? "天基 3D 地球轨道视窗（WGS84 · 日月昼夜）" : "Space-Based 3D Orbital Globe (WGS84)"}</div>
                <div className="mon-win__tools">
                  {camModes.map((cm) => (
                    <button
                      key={cm.id}
                      type="button"
                      className={`mon-mini-btn ${cameraMode === cm.id ? "is-active" : ""}`}
                      onClick={() => setCameraMode(cm.id)}
                    >
                      {lang === "zh" ? cm.zh : cm.en}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`mon-mini-btn ${xrayMode ? "is-active" : ""}`}
                    onClick={toggleXrayMode}
                  >
                    ✦ X-Ray
                  </button>
                  <button type="button" className="mon-mini-btn" onClick={() => toggleExpand("globe")} title={lang === "zh" ? "放大/还原" : "Expand"}>
                    {expanded === "globe" ? "⤡" : "⤢"}
                  </button>
                  <button type="button" className="mon-mini-btn" onClick={() => toggleWin("globe")} title={t("common.close")}>
                    ✕
                  </button>
                </div>
              </header>
              <div className="mon-win__stage">
                {runtime && (
                  <SceneCanvas
                    missileLabel={lang === "zh" ? "高超拦截弹" : "Interceptor"}
                    targetLabel="F-35A"
                    launchLabel={lang === "zh" ? "发射阵地" : "Launch"}
                    targetDatumLabel={lang === "zh" ? "目标基准" : "Target"}
                  />
                )}
              </div>
            </section>
          )}

          {/* Window 2: Space-Based SBIRS Theater Map & Profile */}
          {visible.space && (
            <section className={`mon-win ${expanded === "space" ? "mon-win--wide" : ""}`}>
              <header className="mon-win__head">
                <div className="mon-win__title">🛰️ {lang === "zh" ? "天基预警战区图 & 高度纵剖面" : "SBIRS Space-Based Map & Altitude Profile"}</div>
                <div className="mon-win__tools">
                  <button type="button" className="mon-mini-btn" onClick={() => toggleExpand("space")}>
                    {expanded === "space" ? "⤡" : "⤢"}
                  </button>
                  <button type="button" className="mon-mini-btn" onClick={() => toggleWin("space")}>
                    ✕
                  </button>
                </div>
              </header>
              <div className="mon-win__body">
                <SpaceBasedCard
                  manifest={manifest}
                  missile={data.missile}
                  target={data.target}
                  time={time}
                  onSeek={seek}
                  theme="dark"
                />
              </div>
            </section>
          )}

          {/* Window 3: Radar B-Scope / R-D & 360° RCS Polar */}
          {visible.radar && (
            <section className={`mon-win ${expanded === "radar" ? "mon-win--wide" : ""}`}>
              <header className="mon-win__head">
                <div className="mon-win__title">📡 {lang === "zh" ? "雷达态势窗（360° 隐身 RCS 极坐标 + X 波段链路）" : "Radar Monitor (360° Stealth RCS Polar + X-Band)"}</div>
                <div className="mon-win__tools">
                  <button type="button" className="mon-mini-btn" onClick={() => toggleExpand("radar")}>
                    {expanded === "radar" ? "⤡" : "⤢"}
                  </button>
                  <button type="button" className="mon-mini-btn" onClick={() => toggleWin("radar")}>
                    ✕
                  </button>
                </div>
              </header>
              <div className="mon-win__body">
                <RcsPolarCard aspectDeg={curSample.aspectDeg ?? 75} theme="dark" />
              </div>
            </section>
          )}

          {/* Window 4: MWIR Infrared & Radar Dual-Mode Live View */}
          {visible.ir && (
            <section className={`mon-win ${expanded === "ir" ? "mon-win--wide" : ""}`}>
              <header className="mon-win__head">
                <div className="mon-win__title">🔥 {lang === "zh" ? "双模导引头实时视窗（X 波段雷达 + MWIR 红外焦平面）" : "Live Dual-Mode Seeker (X-Band Radar + MWIR FPA)"}</div>
                <div className="mon-win__tools">
                  <button type="button" className="mon-mini-btn" onClick={() => toggleExpand("ir")}>
                    {expanded === "ir" ? "⤡" : "⤢"}
                  </button>
                  <button type="button" className="mon-mini-btn" onClick={() => toggleWin("ir")}>
                    ✕
                  </button>
                </div>
              </header>
              <div className="mon-win__body">
                <SeekerThermalDualCard missile={data.missile} time={time} interactive={false} theme="dark" />
              </div>
            </section>
          )}

          {/* Window 5: Full State Line Charts Suite */}
          {visible.lines && (
            <section className="mon-win mon-win--wide">
              <header className="mon-win__head">
                <div className="mon-win__title">📈 {lang === "zh" ? "各类飞行与传感状态线图（与时钟实时联动）" : "Flight & Sensor State Line Charts"}</div>
                <div className="mon-win__tools">
                  {(
                    [
                      ["all", "全部", "All"],
                      ["traj", "弹道", "Trajectory"],
                      ["load", "动压/过载", "q & Load"],
                      ["ctrl", "舵偏/角速率", "Fins & Rates"],
                      ["sensor", "双模SNR", "Dual SNR"],
                      ["thermal", "气动热", "Aerothermal"],
                      ["mass", "质量/CG-CP", "Mass/CG-CP"],
                      ["imm", "IMM滤波", "IMM Filter"],
                    ] as [LineTab, string, string][]
                  ).map(([id, zh, en]) => (
                    <button
                      key={id}
                      type="button"
                      className={`mon-mini-btn ${lineTab === id ? "is-active" : ""}`}
                      onClick={() => setLineTab(id)}
                    >
                      {lang === "zh" ? zh : en}
                    </button>
                  ))}
                  <button type="button" className="mon-mini-btn" onClick={() => toggleWin("lines")}>
                    ✕
                  </button>
                </div>
              </header>
              <div className="mon-win__charts">
                {(lineTab === "all" || lineTab === "traj") && (
                  <>
                    <AcademicChart title={t("science.altSpeed")} xUnit="s" unitA="km" unitB="m/s" series={data.altSpeed} cursorT={time} theme="dark" />
                    <AcademicChart title={lang === "zh" ? "马赫数与弹目斜距" : "Mach & Slant Range"} xUnit="s" unitA="Ma" unitB="km" series={data.machRange} cursorT={time} theme="dark" />
                  </>
                )}
                {(lineTab === "all" || lineTab === "load") && (
                  <AcademicChart title={t("science.qLoad")} xUnit="s" unitA="kPa" unitB="g" series={data.qLoad} cursorT={time} theme="dark" />
                )}
                {(lineTab === "all" || lineTab === "ctrl") && (
                  <AcademicChart title={t("science.finRates")} xUnit="s" unitA="deg" unitB="deg/s" series={data.fins} cursorT={time} theme="dark" />
                )}
                {(lineTab === "all" || lineTab === "sensor") && (
                  <AcademicChart title={t("science.seekerSnr")} xUnit="s" unitA="dB" unitB="m²" series={data.snr} cursorT={time} theme="dark" />
                )}
                {(lineTab === "all" || lineTab === "thermal") && (
                  <AcademicChart title={t("science.aerothermal")} xUnit="s" unitA="MW/m²" unitB="K" series={data.thermal} cursorT={time} theme="dark" />
                )}
                {(lineTab === "all" || lineTab === "mass") && (
                  <AcademicChart title={lang === "zh" ? "实时质量与质心 CG / 压心 CP 位置" : "Vehicle Mass & CG / CP Station"} xUnit="s" unitA="kg" unitB="m" series={data.massStability} cursorT={time} theme="dark" />
                )}
                {(lineTab === "all" || lineTab === "imm") && (
                  <AcademicChart title={lang === "zh" ? "IMM 三模型滤波权重（CV / CA / 3D-CT）" : "IMM 3-Model Filter (CV / CA / 3D-CT)"} xUnit="s" unitA="prob" unitB="" series={data.imm} cursorT={time} theme="dark" />
                )}
              </div>
            </section>
          )}

          {/* Window 6: Composite Performance Radar + B-Plane Waterfall */}
          {visible.summary && (
            <section className="mon-win mon-win--wide">
              <header className="mon-win__head">
                <div className="mon-win__title">🎯 {lang === "zh" ? "综合拦截性能六维雷达图 & B-Plane 脱靶归因瀑布图" : "Composite Performance Radar & B-Plane Miss Waterfall"}</div>
                <div className="mon-win__tools">
                  <button type="button" className="mon-mini-btn" onClick={() => toggleWin("summary")}>
                    ✕
                  </button>
                </div>
              </header>
              <div className="mon-win__pair">
                <PerformanceRadarCard manifest={manifest} missile={data.missile} theme="dark" />
                <MissBudgetWaterfallCard manifest={manifest} theme="dark" />
              </div>
            </section>
          )}
        </div>
      )}
    </article>
  );
}
