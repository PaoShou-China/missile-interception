import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";
import { dataClock, formatMissionTime, seekDataTime, sampleAt } from "../data/telemetry";

type ChartCat = "all" | "traj" | "aero" | "ctrl" | "sensor" | "thermal" | "mass" | "ecm";

interface Series {
  name: string;
  color: string;
  points: [number, number][];
}

interface ChartDef {
  cat: Exclude<ChartCat, "all">;
  title: string;
  unit: string;
  series: Series[];
}

const W = 340;
const H = 120;

function LineChart({
  title,
  unit,
  series,
  start,
  end,
  current,
}: {
  title: string;
  unit: string;
  series: Series[];
  start: number;
  end: number;
  current: number;
}) {
  const { path, yMin, yMax } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const [, y] of s.points) {
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1e-6) {
      hi = lo + 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const span = end - start || 1;
    const paths = series.map((s) => ({
      name: s.name,
      color: s.color,
      d: s.points
        .map(([t, v], i) => {
          const x = ((t - start) / span) * W;
          const y = H - ((v - lo) / (hi - lo)) * H;
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" "),
    }));
    return { path: paths, yMin: lo, yMax: hi };
  }, [series, start, end]);

  const cursorX = ((Math.max(start, Math.min(end, current)) - start) / (end - start || 1)) * W;
  const decimals = Math.abs(yMax) >= 100 ? 0 : Math.abs(yMax) >= 10 ? 1 : 2;

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekDataTime(start + ratio * (end - start));
  };

  return (
    <figure className="chart-card">
      <figcaption>
        <span>{title}</span>
        <em>{unit}</em>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onClick={onClick} role="presentation">
        {[0.25, 0.5, 0.75].map((r) => (
          <line key={r} x1={0} x2={W} y1={H * r} y2={H * r} className="chart-grid" />
        ))}
        {path.map((p) => (
          <path key={p.name} d={p.d} fill="none" stroke={p.color} strokeWidth={1.35} vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={cursorX} x2={cursorX} y1={0} y2={H} className="chart-cursor" />
      </svg>
      <div className="chart-axis">
        <span>{formatMissionTime(start)}</span>
        <span>{formatMissionTime((start + end) / 2)}</span>
        <span>{formatMissionTime(end)}</span>
      </div>
      <div className="chart-scale">
        <span>{yMax.toFixed(decimals)}</span>
        <span>{yMin.toFixed(decimals)}</span>
      </div>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.name} style={{ color: s.color }}>
            ● {s.name}
          </span>
        ))}
      </div>
    </figure>
  );
}

const D2R = 180 / Math.PI;

export function ChartsOverlay() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const telemetry = useApp((s) => s.telemetry);
  const [cat, setCat] = useState<ChartCat>("all");
  const [liveT, setLiveT] = useState(() => dataClock.t);
  const lastSyncRef = useRef(0);
  const close = () => useApp.getState().setChartsOpen(false);

  // Sync playhead smoothly at ~12 Hz if playback is active while overlay is open.
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastSyncRef.current < 80) return;
      lastSyncRef.current = now;
      setLiveT((prev) => (Math.abs(prev - dataClock.t) > 1e-3 ? dataClock.t : prev));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const exportCsv = () => {
    if (!telemetry) return;
    const head = [
      "t_s", "alt_m", "speed_m_s", "mach", "q_pa", "load_g", "load_cmd_g", "mass_kg",
      "range_m", "seeker_fov_deg", "seeker_az_deg", "seeker_el_deg",
      "fin_up_deg", "fin_down_deg", "fin_left_deg", "fin_right_deg",
      "p_deg_s", "q_deg_s", "r_deg_s", "alpha_deg", "beta_deg", "divert_g",
      "radar_snr_db", "ir_snr_db", "target_rcs_m2",
      "heat_flux_mw_m2", "wall_temp_k", "wall_temp_eq_k",
      "cg_m", "cp_m", "imm_p_cv", "imm_p_ca", "imm_p_ct",
      "decoy_active", "unstart_flag", "fuze_pk",
    ];
    const rows = telemetry.samples.map((s) =>
      [
        s.t.toFixed(2), s.altM.toFixed(2), s.speedMS.toFixed(2), s.mach.toFixed(3),
        s.qPa.toFixed(1), s.loadG.toFixed(3), s.loadCmdG.toFixed(3), s.massKg.toFixed(2),
        s.rangeM.toFixed(1), s.fovDeg.toFixed(3), (s.seekerAzDeg ?? 0).toFixed(3), (s.seekerElDeg ?? 0).toFixed(3),
        ((s.finDeflectionsRad?.up ?? 0) * D2R).toFixed(3),
        ((s.finDeflectionsRad?.down ?? 0) * D2R).toFixed(3),
        ((s.finDeflectionsRad?.left ?? 0) * D2R).toFixed(3),
        ((s.finDeflectionsRad?.right ?? 0) * D2R).toFixed(3),
        ((s.bodyRatesRadS?.p ?? 0) * D2R).toFixed(4),
        ((s.bodyRatesRadS?.q ?? 0) * D2R).toFixed(4),
        ((s.bodyRatesRadS?.r ?? 0) * D2R).toFixed(4),
        (s.alphaDeg ?? 0).toFixed(3), (s.betaDeg ?? 0).toFixed(3), (s.divertG ?? 0).toFixed(3),
        (s.radarSnrDb ?? -60).toFixed(2), (s.irSnrDb ?? -60).toFixed(2), (s.targetRcsM2 ?? 0.005).toFixed(5),
        (s.heatFluxMWm2 ?? 0).toFixed(3), (s.wallTempK ?? 288).toFixed(1), (s.wallTempEqK ?? s.wallTempK ?? 288).toFixed(1),
        (s.cgPos ?? 4.2).toFixed(3), (s.cpPos ?? 4.9).toFixed(3),
        (s.immPCv ?? 0.34).toFixed(4), (s.immPCa ?? 0.33).toFixed(4), (s.immPCt ?? 0.33).toFixed(4),
        (s.decoyActive ?? 0).toFixed(0), (s.unstartFlag ?? 0).toFixed(0), (s.fuzePk ?? 0).toFixed(4),
      ].join(","),
    );
    const blob = new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `interceptor-telemetry-${telemetry.samples.length}rows.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const allCharts = useMemo<ChartDef[] | null>(() => {
    if (!telemetry) return null;
    const step = Math.max(1, Math.ceil(telemetry.samples.length / 520));
    const rows = telemetry.samples.filter((_, i) => i % step === 0);
    const pick = (fn: (s: ReturnType<typeof sampleAt>) => number) =>
      rows.map((s) => [s.t, fn(s)] as [number, number]);
    const fin = (key: "up" | "down" | "left" | "right") =>
      rows.map((s) => [s.t, (s.finDeflectionsRad?.[key] ?? 0) * D2R] as [number, number]);
    const rate = (key: "p" | "q" | "r") =>
      rows.map((s) => [s.t, (s.bodyRatesRadS?.[key] ?? 0) * D2R] as [number, number]);
    const zh = lang === "zh";

    return [
      { cat: "traj", title: t("altitude"), unit: "km", series: [{ name: t("altitude"), color: "#4fd1e8", points: pick((s) => s!.altM / 1000) }] },
      { cat: "traj", title: t("speed"), unit: "m/s", series: [{ name: t("speed"), color: "#79e3a8", points: pick((s) => s!.speedMS) }] },
      { cat: "traj", title: t("mach"), unit: "—", series: [{ name: "Mach", color: "#e8c46a", points: pick((s) => s!.mach) }] },
      { cat: "traj", title: t("range"), unit: "km", series: [{ name: t("range"), color: "#9fb4ff", points: pick((s) => s!.rangeM / 1000) }] },
      { cat: "aero", title: t("dynPressure"), unit: "kPa", series: [{ name: "q∞", color: "#f0a35e", points: pick((s) => s!.qPa / 1000) }] },
      {
        cat: "aero",
        title: zh ? "实际过载 vs 指令过载" : "Achieved vs Commanded Load",
        unit: "g",
        series: [
          { name: zh ? "实际过载 n" : "Achieved", color: "#f27d7d", points: pick((s) => s!.loadG) },
          { name: zh ? "指令过载 n_cmd" : "Command", color: "#fbbf24", points: pick((s) => s!.loadCmdG) },
        ],
      },
      {
        cat: "aero",
        title: t("aoaSideslip"),
        unit: "deg",
        series: [
          { name: "α", color: "#6fd4ff", points: pick((s) => s!.alphaDeg ?? 0) },
          { name: "β", color: "#ffb36b", points: pick((s) => s!.betaDeg ?? 0) },
        ],
      },
      {
        cat: "ctrl",
        title: t("fins"),
        unit: "deg",
        series: [
          { name: "up", color: "#6fd4ff", points: fin("up") },
          { name: "down", color: "#ffb36b", points: fin("down") },
          { name: "left", color: "#9fe6a8", points: fin("left") },
          { name: "right", color: "#f08fb0", points: fin("right") },
        ],
      },
      {
        cat: "ctrl",
        title: zh ? "三轴体轴角速率 (p / q / r)" : "Body Angular Rates (p / q / r)",
        unit: "deg/s",
        series: [
          { name: "p", color: "#6fd4ff", points: rate("p") },
          { name: "q", color: "#ffb36b", points: rate("q") },
          { name: "r", color: "#9fe6a8", points: rate("r") },
        ],
      },
      { cat: "ctrl", title: t("divert"), unit: "g", series: [{ name: "DACS", color: "#f27d7d", points: pick((s) => s!.divertG ?? 0) }] },
      {
        cat: "sensor",
        title: t("snrLink"),
        unit: "dB",
        series: [
          { name: "Radar SNR", color: "#68f2a8", points: pick((s) => s!.radarSnrDb ?? -60) },
          { name: "IIR SNR", color: "#ff9b66", points: pick((s) => s!.irSnrDb ?? -60) },
          { name: "CFAR 13 dB", color: "#e8c46a", points: pick(() => 13) },
        ],
      },
      {
        cat: "sensor",
        title: zh ? "隐身目标实时 RCS (X 波段)" : "Target Monostatic RCS (X-Band)",
        unit: "m²",
        series: [{ name: "RCS σ", color: "#38bdf8", points: pick((s) => s!.targetRcsM2 ?? 0.005) }],
      },
      {
        cat: "sensor",
        title: zh ? "导引头视场离轴角 & 视线角 (FOV / AZ / EL)" : "Seeker Angles (FOV / AZ / EL)",
        unit: "deg",
        series: [
          { name: "FOV", color: "#c9a6ff", points: pick((s) => s!.fovDeg) },
          { name: "AZ", color: "#4fd1e8", points: pick((s) => s!.seekerAzDeg ?? 0) },
          { name: "EL", color: "#ffb36b", points: pick((s) => s!.seekerElDeg ?? 0) },
        ],
      },
      {
        cat: "thermal",
        title: zh ? "驻点气动热流 (Sutton-Graves)" : "Stagnation Heat Flux (Sutton-Graves)",
        unit: "MW/m²",
        series: [{ name: "q̇s", color: "#ff7466", points: pick((s) => s!.heatFluxMWm2 ?? 0) }],
      },
      {
        cat: "thermal",
        title: zh ? "瞬态头罩壁温 Tw vs 平衡壁温 Teq" : "Transient Wall Temp Tw vs Teq",
        unit: "K",
        series: [
          { name: "Tw", color: "#ffc96b", points: pick((s) => s!.wallTempK ?? 288) },
          { name: "Teq", color: "#f08fb0", points: pick((s) => s!.wallTempEqK ?? s!.wallTempK ?? 288) },
        ],
      },
      {
        cat: "mass",
        title: zh ? "实时弹体质量（含 13 s 助推分离阶跃）" : "Vehicle Mass (w/ 13 s Booster Sep)",
        unit: "kg",
        series: [{ name: zh ? "质量 m" : "Mass", color: "#6fd4ff", points: pick((s) => s!.massKg) }],
      },
      {
        cat: "mass",
        title: t("cgCpMargin"),
        unit: "m",
        series: [
          { name: "CG", color: "#ffcc4d", points: pick((s) => s!.cgPos ?? 4.2) },
          { name: "CP", color: "#4fd8ff", points: pick((s) => s!.cpPos ?? 4.9) },
          { name: "SM (CP−CG)", color: "#79e3a8", points: pick((s) => (s!.cpPos ?? 4.9) - (s!.cgPos ?? 4.2)) },
        ],
      },
      {
        cat: "ecm",
        title: zh ? "IMM 三模型权重 & 诱饵/不起动状态" : "IMM 3-Model Filter & ECM / Unstart",
        unit: "0–1",
        series: [
          { name: "CV", color: "#6fd4ff", points: pick((s) => s!.immPCv ?? 0.34) },
          { name: "CA/Singer", color: "#ffb36b", points: pick((s) => s!.immPCa ?? 0.33) },
          { name: "3D-CT", color: "#79e3a8", points: pick((s) => s!.immPCt ?? 0.33) },
          { name: "Decoy", color: "#f472b6", points: pick((s) => s!.decoyActive ?? 0) },
          { name: "Unstart", color: "#ef4444", points: pick((s) => s!.unstartFlag ?? 0) },
        ],
      },
    ];
  }, [telemetry, t, lang]);

  const visibleCharts = useMemo(
    () => (allCharts ? (cat === "all" ? allCharts : allCharts.filter((c) => c.cat === cat)) : null),
    [allCharts, cat],
  );

  const cats: [ChartCat, string, string][] = [
    ["all", `全部 (${allCharts?.length ?? 18})`, `All (${allCharts?.length ?? 18})`],
    ["traj", "弹道运动", "Trajectory"],
    ["aero", "气动载荷", "Aero & Load"],
    ["ctrl", "姿控舵机", "Control"],
    ["sensor", "双模感知", "Seeker"],
    ["thermal", "气动热", "Thermal"],
    ["mass", "质量稳态", "Mass & CG/CP"],
    ["ecm", "滤波对抗", "IMM & ECM"],
  ];

  return (
    <div className="charts-overlay" role="dialog" aria-modal="true">
      <header className="charts-overlay__head">
        <div>
          <h2>{t("chartsTitle")}</h2>
          <p>{t("chartsSub")}</p>
        </div>
        <div className="charts-overlay__actions">
          <button type="button" className="ghost-btn ghost-btn--sm" onClick={exportCsv} disabled={!telemetry}>
            {t("exportCsv")}
          </button>
          <button type="button" className="icon-button" onClick={close} title={t("close")}>
            ✕
          </button>
        </div>
      </header>
      <div className="charts-filter" role="tablist">
        {cats.map(([id, zh, en]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={cat === id}
            className={`charts-filter__btn ${cat === id ? "is-active" : ""}`}
            onClick={() => setCat(id)}
          >
            {lang === "zh" ? zh : en}
          </button>
        ))}
      </div>
      {visibleCharts ? (
        <div className="charts-grid charts-grid--full">
          {visibleCharts.map((c) => (
            <LineChart
              key={c.title}
              title={c.title}
              unit={c.unit}
              series={c.series}
              start={telemetry!.start}
              end={telemetry!.end}
              current={liveT}
            />
          ))}
        </div>
      ) : (
        <p className="hint">{t("telemetryLoading")}</p>
      )}
    </div>
  );
}
