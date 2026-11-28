import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, RadarChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  PolarComponent,
  RadarComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ScenarioManifest, TrajectorySample } from "../scientific/types";
import { useI18n } from "../i18n";

echarts.use([
  BarChart,
  LineChart,
  RadarChart,
  ScatterChart,
  GridComponent,
  PolarComponent,
  RadarComponent,
  TooltipComponent,
  CanvasRenderer,
]);

function aspectRcsDb(aspectDeg: number): number {
  let th = Math.abs(aspectDeg) % 360;
  if (th > 180) th = 360 - th;
  const dbFront = 10 * Math.log10(0.005);
  const dbSide = 10 * Math.log10(0.18);
  const dbRear = 10 * Math.log10(0.06);
  const cRear = 0.5 * (1 - Math.cos((th * Math.PI) / 180));
  const baseDb = dbFront * (1 - cRear) + dbRear * cRear;
  const midBase = 0.5 * (dbFront + dbRear);
  const lobe90 = Math.max(dbSide - midBase, 0) * Math.exp(-(((th - 90) / 16) ** 2));
  const lobeEdge =
    5.5 * Math.exp(-(((th - 36) / 6) ** 2)) +
    4.5 * Math.exp(-(((th - 144) / 7) ** 2));
  return +(baseDb + lobe90 + lobeEdge).toFixed(2);
}

/** 6-axis multi-metric mission performance radar (spider) chart. */
export function PerformanceRadarCard({
  manifest,
  missile,
  theme = "dark",
}: {
  manifest: ScenarioManifest;
  missile: TrajectorySample[];
  theme?: "dark" | "light";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { t, lang } = useI18n();
  const isLight = theme === "light";

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const m = manifest.metrics;
    const missScore = Math.max(0, Math.min(100, (1 - m.missDistanceM / 30) * 100));
    const pk = m.killProbability ?? Math.exp(-Math.LN2 * (m.missDistanceM / 15) ** 2);
    const pkScore = Math.max(0, Math.min(100, pk * 100));
    const energyScore = Math.max(0, Math.min(100, (m.maxMach / 10) * 100));
    // Seeker terminal SNR margin (average IR/Radar margin inside 15 km)
    const term = missile.filter((s) => s.rangeM < 15000 && s.rangeM > 200);
    const avgIr = term.length
      ? term.reduce((acc, s) => acc + (s.irSnrDb ?? 22), 0) / term.length
      : 22;
    const sensorScore = Math.max(0, Math.min(100, ((avgIr - 10) / 30) * 100));
    const maxWall = m.maxWallTempK ?? 2200;
    const thermalScore = Math.max(0, Math.min(100, (1 - Math.max(0, maxWall - 1200) / 2000) * 100));
    const loadScore = Math.max(0, Math.min(100, (1 - Math.max(0, m.maxLoadG - 12) / 40) * 100));

    const labelColor = isLight ? "#1b3a5c" : "rgba(195,218,238,0.88)";
    const splitLine = isLight ? "rgba(11,49,92,0.14)" : "rgba(120,165,205,0.2)";

    return {
      animation: false,
      tooltip: {
        trigger: "item",
        backgroundColor: isLight ? "rgba(7,26,51,0.94)" : "rgba(8,14,24,0.95)",
        borderColor: "rgba(55,185,216,0.4)",
        textStyle: { color: "#e8f4fc", fontSize: 11 },
      },
      radar: {
        radius: "66%",
        center: ["50%", "54%"],
        indicator: [
          { name: lang === "zh" ? "末段精度" : "Accuracy", max: 100 },
          { name: lang === "zh" ? "杀伤概率 Pk" : "Lethality Pk", max: 100 },
          { name: lang === "zh" ? "高超能量" : "Hypersonic E", max: 100 },
          { name: lang === "zh" ? "双模截获" : "Seeker SNR", max: 100 },
          { name: lang === "zh" ? "气动热裕度" : "TPS Margin", max: 100 },
          { name: lang === "zh" ? "过载余量" : "Load Margin", max: 100 },
        ],
        axisName: { color: labelColor, fontSize: 11 },
        splitLine: { lineStyle: { color: splitLine } },
        splitArea: {
          areaStyle: {
            color: isLight
              ? ["rgba(0,91,172,0.03)", "rgba(55,185,216,0.05)"]
              : ["rgba(255,255,255,0.015)", "rgba(55,185,216,0.04)"],
          },
        },
        axisLine: { lineStyle: { color: splitLine } },
      },
      series: [
        {
          type: "radar",
          data: [
            {
              name: lang === "zh" ? "综合拦截性能指数" : "Composite Mission Index",
              value: [
                +missScore.toFixed(1),
                +pkScore.toFixed(1),
                +energyScore.toFixed(1),
                +sensorScore.toFixed(1),
                +thermalScore.toFixed(1),
                +loadScore.toFixed(1),
              ],
              symbol: "circle",
              symbolSize: 5,
              lineStyle: { color: isLight ? "#005BAC" : "#4fd1e8", width: 2 },
              itemStyle: { color: isLight ? "#005BAC" : "#ffb257" },
              areaStyle: { color: isLight ? "rgba(0,91,172,0.18)" : "rgba(79,209,232,0.22)" },
            },
          ],
        },
      ],
    };
  }, [manifest, missile, isLight, lang]);

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" });
    c.setOption(option);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
    };
  }, [option]);

  if (isLight) {
    return (
      <figure className="academic-chart">
        <figcaption>{t("science.perfRadar")}</figcaption>
        <div className="academic-chart__canvas" ref={ref} style={{ height: 260 }} />
      </figure>
    );
  }
  return (
    <div className="chart-card chart-card--large">
      <div className="chart-card__head">
        <span>{t("science.perfRadar")}</span>
      </div>
      <div className="chart-card__canvas" ref={ref} />
    </div>
  );
}

/** 360-degree F-35A monostatic X-band RCS polar diagram (dBsm) + live aspect needle. */
export function RcsPolarCard({
  aspectDeg,
  theme = "dark",
}: {
  aspectDeg: number;
  theme?: "dark" | "light";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { t, lang } = useI18n();
  const isLight = theme === "light";

  const polarData = useMemo(() => {
    const pts: [number, number][] = [];
    for (let deg = 0; deg <= 360; deg += 2) {
      pts.push([aspectRcsDb(deg), deg]);
    }
    return pts;
  }, []);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const curDb = aspectRcsDb(aspectDeg);
    const axisColor = isLight ? "rgba(11,49,92,0.28)" : "rgba(150,185,220,0.35)";
    const labelColor = isLight ? "#1b3a5c" : "rgba(195,218,238,0.85)";
    return {
      animation: false,
      tooltip: {
        trigger: "item",
        backgroundColor: "rgba(7,20,38,0.94)",
        borderColor: "rgba(55,185,216,0.4)",
        textStyle: { color: "#e8f4fc", fontSize: 11 },
        formatter: (p: { value?: [number, number] }) => {
          if (!p.value) return "";
          const db = p.value[0];
          const m2 = 10 ** (db / 10);
          return `${lang === "zh" ? "姿态角" : "Aspect"}: ${p.value[1].toFixed(1)}°<br/>RCS: ${db.toFixed(1)} dBsm (${m2.toFixed(4)} m²)`;
        },
      },
      polar: { radius: "70%", center: ["50%", "53%"] },
      angleAxis: {
        type: "value",
        startAngle: 90,
        clockwise: true,
        min: 0,
        max: 360,
        interval: 45,
        axisLine: { lineStyle: { color: axisColor } },
        axisLabel: {
          color: labelColor,
          fontSize: 10,
          formatter: (v: number) =>
            v === 0 ? "0°" : v === 90 ? "90°" : v === 180 ? "180°" : v === 270 ? "270°" : `${v}°`,
        },
        splitLine: { lineStyle: { color: isLight ? "rgba(11,49,92,0.1)" : "rgba(130,170,210,0.14)" } },
      },
      radiusAxis: {
        min: -30,
        max: 0,
        interval: 10,
        axisLine: { show: false },
        axisLabel: { color: labelColor, fontSize: 9.5, formatter: (v: number) => `${v} dBsm` },
        splitLine: { lineStyle: { color: isLight ? "rgba(11,49,92,0.12)" : "rgba(130,170,210,0.16)" } },
      },
      series: [
        {
          type: "line",
          coordinateSystem: "polar",
          name: "F-35A RCS",
          data: polarData,
          showSymbol: false,
          lineStyle: { color: isLight ? "#005BAC" : "#4fd1e8", width: 2 },
          areaStyle: { color: isLight ? "rgba(0,91,172,0.14)" : "rgba(79,209,232,0.18)" },
        },
        {
          type: "scatter",
          coordinateSystem: "polar",
          name: lang === "zh" ? "当前视线姿态" : "Current Aspect",
          data: [[curDb, ((aspectDeg % 360) + 360) % 360]],
          symbolSize: 10,
          itemStyle: { color: "#ff8c42", borderColor: "#fff", borderWidth: 1.5 },
        },
      ],
    };
  }, [polarData, aspectDeg, isLight, lang]);

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" });
    c.setOption(option);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
    };
  }, [option]);

  if (isLight) {
    return (
      <figure className="academic-chart">
        <figcaption>{t("science.rcsPolar")}</figcaption>
        <div className="academic-chart__canvas" ref={ref} style={{ height: 260 }} />
      </figure>
    );
  }
  return (
    <div className="chart-card chart-card--large">
      <div className="chart-card__head">
        <span>{t("science.rcsPolar")}</span>
      </div>
      <div className="chart-card__canvas" ref={ref} />
    </div>
  );
}

/** Interactive dual-panel X-band Radar B-Scope + MWIR IIR Thermal Seeker View. */
export function SeekerThermalDualCard({
  missile,
  time,
  interactive = false,
  theme = "dark",
}: {
  missile: TrajectorySample[];
  time?: number;
  interactive?: boolean;
  theme?: "dark" | "light";
}) {
  const { t, lang } = useI18n();
  const isLight = theme === "light";
  const endT = missile[missile.length - 1]?.t ?? 0;
  const startEndgame = Math.max(0, endT - 18);
  const [localT, setLocalT] = useState(() => Math.max(startEndgame, endT - 2.5));
  const activeT = interactive ? localT : (time ?? endT - 2.5);

  const sample = useMemo(() => {
    if (!missile.length) return null;
    let best = missile[0];
    let bestD = Infinity;
    for (let i = 0; i < missile.length; i++) {
      const d = Math.abs(missile[i].t - activeT);
      if (d < bestD) {
        bestD = d;
        best = missile[i];
      }
    }
    return best;
  }, [missile, activeT]);

  const radarCanvas = useRef<HTMLCanvasElement>(null);
  const irCanvas = useRef<HTMLCanvasElement>(null);
  const irOffRef = useRef<{ canvas: HTMLCanvasElement; img: ImageData } | null>(null);
  const lastDrawMsRef = useRef(0);

  useEffect(() => {
    if (!sample) return;
    // Decouple sensor canvas redraws to authentic ~25 Hz sensor cadence (40 ms).
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!interactive && now - lastDrawMsRef.current < 40) return;
    lastDrawMsRef.current = now;

    // Draw Radar B-Scope (sensor-native resolution, no redundant canvas resize)
    if (radarCanvas.current) {
      const c = radarCanvas.current;
      const w = 260, h = 195;
      const dpr = 1.25;
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (c.width !== pw || c.height !== ph) {
        c.width = pw; c.height = ph;
      }
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#040f0a";
        ctx.fillRect(0, 0, w, h);
        const cx = w * 0.5, cy = h - 18, rad = h - 34;
        const maxKm = sample.rangeM > 35000 ? 80 : sample.rangeM > 12000 ? 35 : sample.rangeM > 3000 ? 12 : 3;
        const cone = (36 * Math.PI) / 180;
        const fov = (30 * Math.PI) / 180;
        for (let i = 1; i <= 4; i++) {
          ctx.strokeStyle = "rgba(65,220,140,0.24)";
          ctx.beginPath();
          ctx.arc(cx, cy, (rad * i) / 4, -Math.PI / 2 - cone, -Math.PI / 2 + cone);
          ctx.stroke();
        }
        for (const d of [-30, -15, 0, 15, 30]) {
          const a = (d * Math.PI) / 180;
          ctx.strokeStyle = Math.abs(d) === 30 ? "rgba(255,196,92,0.55)" : "rgba(65,220,140,0.2)";
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + rad * Math.sin(a), cy - rad * Math.cos(a));
          ctx.stroke();
        }
        const rk = sample.rangeM / 1000;
        const az = ((sample.seekerAzDeg ?? 0) * Math.PI) / 180;
        const snr = sample.radarSnrDb ?? -20;
        if (rk <= maxKm) {
          const rPx = Math.max(4, (rk / maxKm) * rad);
          const tx = cx + rPx * Math.sin(Math.max(-cone, Math.min(cone, az)));
          const ty = cy - rPx * Math.cos(Math.max(-cone, Math.min(cone, az)));
          const det = snr >= 13 && sample.rangeM > 120;
          const g = ctx.createRadialGradient(tx, ty, 1, tx, ty, 14);
          g.addColorStop(0, det ? "#d2ffe6" : "#ffdb8a");
          g.addColorStop(0.5, det ? "rgba(60,255,140,0.55)" : "rgba(255,170,70,0.35)");
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(tx, ty, 14, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = det ? "#7affb8" : "#ffc566";
          ctx.strokeRect(tx - 6, ty - 6, 12, 12);
          if ((sample.decoyActive ?? 0) > 0.5) {
            const daz = ((sample.decoyAzDeg ?? (sample.seekerAzDeg ?? 0) + 3.2) * Math.PI) / 180;
            const drPx = Math.min(rad, rPx + 6);
            const dxC = cx + drPx * Math.sin(Math.max(-cone, Math.min(cone, daz)));
            const dyC = cy - drPx * Math.cos(Math.max(-cone, Math.min(cone, daz)));
            ctx.fillStyle = "rgba(255,152,64,0.45)";
            ctx.beginPath(); ctx.arc(dxC, dyC, 7, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "#ff9840";
            ctx.setLineDash([2, 2]);
            ctx.strokeRect(dxC - 5, dyC - 5, 10, 10);
            ctx.setLineDash([]);
            ctx.fillStyle = "#ffb870";
            ctx.font = "8.5px ui-monospace, monospace";
            ctx.fillText("CHAFF REJ", dxC + 7, dyC + 3);
          }
        }
        // Sweep line
        const sw = Math.sin(sample.t * 4) * fov;
        ctx.strokeStyle = "rgba(95,255,165,0.75)";
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + rad * Math.sin(sw), cy - rad * Math.cos(sw)); ctx.stroke();
        ctx.fillStyle = "#95f5c2";
        ctx.font = "9.5px ui-monospace, monospace";
        ctx.fillText(`X-BAND RADAR · ${maxKm}km`, 8, 14);
        ctx.fillText(`SNR ${snr.toFixed(1)} dB`, 8, h - 6);
      }
    }

    // Draw MWIR IIR Thermal View (reusable 128x96 FPA ImageData — zero per-frame allocation)
    if (irCanvas.current) {
      const c = irCanvas.current;
      const w = 260, h = 195;
      const dpr = 1.25;
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (c.width !== pw || c.height !== ph) {
        c.width = pw; c.height = ph;
      }
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const fw = 128, fh = 96;
        if (!irOffRef.current) {
          const off = document.createElement("canvas");
          off.width = fw; off.height = fh;
          const octxInit = off.getContext("2d")!;
          irOffRef.current = { canvas: off, img: octxInit.createImageData(fw, fh) };
        }
        const { canvas: off, img } = irOffRef.current;
        const octx = off.getContext("2d")!;
        const az = sample.seekerAzDeg ?? 0;
        const el = sample.seekerElDeg ?? 0;
        const irSnr = sample.irSnrDb ?? 0;
        const aspect = sample.aspectDeg ?? 60;
        const tw = sample.wallTempK ?? 1800;
        const decOn = (sample.decoyActive ?? 0) > 0.5;
        const daz = sample.decoyAzDeg ?? az + 3.0;
        const del = sample.decoyElDeg ?? el - 2.0;
        const fx = fw * 0.5 + (daz / 30) * (fw * 0.42);
        const fy = fh * 0.5 - (del / 30) * (fh * 0.42);
        const tx = fw * 0.5 + (az / 30) * (fw * 0.42);
        const ty = fh * 0.5 - (el / 30) * (fh * 0.42);
        const angPx = Math.max(1.4, Math.min(20, (15.7 / Math.max(sample.rangeM, 180)) / 1.05 * fw * 2.2));
        const domeGlow = Math.max(0, Math.min(0.4, ((tw - 900) / 1700) * 0.34));
        const bright = Math.max(0.22, Math.min(1.05, (irSnr + 8) / 38));
        const plume = 0.25 + 0.75 * (0.5 * (1 - Math.cos((aspect * Math.PI) / 180)));
        const stops: [number, number, number, number][] = [
          [0.0, 5, 7, 24], [0.22, 46, 14, 94], [0.46, 168, 34, 92],
          [0.7, 240, 120, 24], [0.88, 255, 222, 86], [1.0, 255, 254, 246],
        ];
        const tickSeed = Math.floor(sample.t * 10) * 37;
        const pxData = img.data;
        for (let y = 0; y < fh; y++) {
          const ny = (y - fh * 0.5) / (fh * 0.5);
          for (let x = 0; x < fw; x++) {
            const nx = (x - fw * 0.5) / (fw * 0.5);
            const r2 = nx * nx + ny * ny;
            const n = Math.sin(x * 127.1 + y * 311.7 + tickSeed) * 43758.5;
            const noise = (n - Math.floor(n) - 0.5) * 0.08;
            let v = 0.08 + 0.05 * Math.max(0, ny) + domeGlow * Math.min(1.1, r2 * 0.85) + noise;
            const dx = x - tx, dy = y - ty;
            const core = Math.exp(-(dx * dx + dy * dy) / Math.max(1.2, angPx * angPx * 0.36));
            const px = dx - angPx * 0.9, py = dy;
            const pl = plume * 0.9 * Math.exp(-((px / Math.max(1.6, angPx * 1.1)) ** 2 + (py / Math.max(1.0, angPx * 0.35)) ** 2));
            let flare = 0;
            if (decOn) {
              const fdx = x - fx, fdy = y - fy;
              flare = 0.95 * Math.exp(-(fdx * fdx + fdy * fdy) / 6.5)
                + 0.45 * Math.exp(-((x - (fx + tx) * 0.5) ** 2 + (y - (fy + ty) * 0.5) ** 2) / 4.0);
            }
            v = Math.max(0, Math.min(1, v + bright * (core + pl) + flare));
            let R = 255, G = 254, B = 246;
            for (let k = 1; k < stops.length; k++) {
              if (v <= stops[k][0]) {
                const a = stops[k - 1], b = stops[k];
                const u = (v - a[0]) / Math.max(b[0] - a[0], 1e-6);
                R = Math.round(a[1] + (b[1] - a[1]) * u);
                G = Math.round(a[2] + (b[2] - a[2]) * u);
                B = Math.round(a[3] + (b[3] - a[3]) * u);
                break;
              }
            }
            const idx = (y * fw + x) * 4;
            pxData[idx] = R; pxData[idx + 1] = G; pxData[idx + 2] = B; pxData[idx + 3] = 255;
          }
        }
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        // Reticle & tracking box
        ctx.strokeStyle = "rgba(255,255,255,0.34)";
        ctx.beginPath(); ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.42, 0, Math.PI * 2); ctx.stroke();
        const sx = (tx / fw) * w, sy = (ty / fh) * h;
        ctx.strokeStyle = irSnr >= 13 ? "#8effc1" : "#ffcf70";
        ctx.lineWidth = 1.4;
        ctx.strokeRect(sx - 10, sy - 10, 20, 20);
        if (decOn) {
          const fsx = (fx / fw) * w, fsy = (fy / fh) * h;
          ctx.strokeStyle = "#ff9840";
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(fsx - 7, fsy - 7, 14, 14);
          ctx.setLineDash([]);
          ctx.fillStyle = "#ffc480";
          ctx.font = "8.5px ui-monospace, monospace";
          ctx.fillText("FLARE GATED", Math.min(w - 64, fsx + 8), Math.max(24, fsy + 3));
        }
        ctx.fillStyle = "#f2f8ff";
        ctx.font = "9.5px ui-monospace, monospace";
        ctx.fillText(`MWIR IIR (128×96 FPA)${decOn ? " · ANTI-DECOY" : ""}`, 8, 14);
        ctx.fillText(`SNR ${irSnr.toFixed(1)} dB · R ${(sample.rangeM / 1000).toFixed(2)}km`, 8, h - 6);
      }
    }
  }, [sample, interactive]);

  const content = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <canvas ref={radarCanvas} style={{ width: "100%", height: 195, borderRadius: 6, display: "block" }} />
        <canvas ref={irCanvas} style={{ width: "100%", height: 195, borderRadius: 6, display: "block" }} />
      </div>
      {sample && sample.immPCv !== undefined && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, fontFamily: "var(--mono, monospace)", opacity: 0.9 }}>
          <span>IMM:</span>
          <span style={{ color: "#38bdf8" }}>CV {(sample.immPCv * 100).toFixed(0)}%</span>
          <span style={{ color: "#f59e0b" }}>CA {((sample.immPCa ?? 0) * 100).toFixed(0)}%</span>
          <span style={{ color: "#22c55e" }}>3D-CT {((sample.immPCt ?? 0) * 100).toFixed(0)}%</span>
          {(sample.decoyActive ?? 0) > 0.5 && (
            <span style={{ color: "#ff8c42", fontWeight: 700, marginLeft: "auto" }}>
              ● {lang === "zh" ? "红外诱饵/箔条已门限剔除" : "FLARE/CHAFF GATED"}
            </span>
          )}
        </div>
      )}
      {interactive && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, fontFamily: "var(--mono, monospace)" }}>
          <span>T+{activeT.toFixed(2)}s</span>
          <input
            type="range"
            min={startEndgame}
            max={endT}
            step={0.05}
            value={localT}
            onChange={(e) => setLocalT(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span>
            {lang === "zh" ? "斜距" : "R"} {sample ? `${(sample.rangeM / 1000).toFixed(2)} km` : "—"}
          </span>
        </div>
      )}
    </div>
  );

  if (isLight) {
    return (
      <figure className="academic-chart" style={{ gridColumn: "1 / -1" }}>
        <figcaption>{t("science.seekerDual")}</figcaption>
        {content}
      </figure>
    );
  }
  return (
    <div className="chart-card chart-card--large" style={{ gridColumn: "1 / -1" }}>
      <div className="chart-card__head">
        <span>{t("science.seekerDual")}</span>
      </div>
      {content}
    </div>
  );
}

/** B-Plane Miss-Budget Attribution Waterfall Chart (from tools/miss_budget.py). */
export function MissBudgetWaterfallCard({
  manifest,
  theme = "dark",
}: {
  manifest: ScenarioManifest;
  theme?: "dark" | "light";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { lang } = useI18n();
  const isLight = theme === "light";

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const missFull = manifest.metrics.missDistanceM;
    const mb = manifest.metrics.missBudget?.nominal;
    const truthNav = mb?.truth_nav ?? Math.max(0.35, missFull * 0.22);
    const noNoise = mb?.no_sensor_noise ?? Math.max(truthNav + 0.4, missFull * 0.40);
    const noDelay = mb?.no_nav_delay ?? Math.max(truthNav + 0.5, missFull * 0.72);
    const noEvade = mb?.no_evade ?? Math.max(0.4, missFull * 0.35);
    const fullVal = mb?.full ?? missFull;

    // Decompose into additive waterfall steps summing cleanly to fullVal.
    const dDelay = Math.max(0, noNoise - truthNav);
    const dNoise = Math.max(0, fullVal - noNoise);
    const dMan = Math.max(0, fullVal - noEvade);
    const baseIdeal = Math.max(0.2, truthNav * 0.55);
    const dAeroFin = Math.max(0, truthNav - baseIdeal);
    const rawSum = baseIdeal + dAeroFin + dDelay + dNoise + Math.min(dMan, fullVal * 0.35);
    const normScale = rawSum > 1e-6 ? fullVal / rawSum : 1;

    const s0 = +(baseIdeal * normScale).toFixed(2);
    const s1 = +(dDelay * normScale).toFixed(2);
    const s2 = +(dNoise * normScale).toFixed(2);
    const s3 = +(Math.min(dMan, fullVal * 0.35) * normScale).toFixed(2);
    const s4 = +Math.max(0, fullVal - (s0 + s1 + s2 + s3)).toFixed(2);
    const tot = +fullVal.toFixed(2);

    const labels = lang === "zh"
      ? ["理想基准", "+导航延迟", "+导引头噪声/闪烁", "+目标9g机动", "+舵饱和/二阶lag", "最终脱靶量"]
      : ["Ideal Base", "+Nav Delay", "+Seeker/Glint", "+Target 9g", "+Fin Sat/Lag", "Total Miss"];

    const helper = [0, s0, s0 + s1, s0 + s1 + s2, s0 + s1 + s2 + s3, 0];
    const deltas = [s0, s1, s2, s3, s4, tot];
    const colors = ["#38bdf8", "#a78bfa", "#f59e0b", "#ef4444", "#fb923c", "#22c55e"];
    const labelColor = isLight ? "#1b3a5c" : "rgba(195,218,238,0.88)";
    const splitLine = isLight ? "rgba(11,49,92,0.12)" : "rgba(120,165,205,0.16)";

    return {
      animation: false,
      grid: { left: 48, right: 16, top: 26, bottom: 44 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: "rgba(8,14,24,0.95)",
        borderColor: "rgba(55,185,216,0.4)",
        textStyle: { color: "#e8f4fc", fontSize: 11 },
        formatter: (params: { name?: string; dataIndex?: number }[]) => {
          const i = params[0]?.dataIndex ?? 0;
          return `${labels[i]}: <b>${deltas[i].toFixed(2)} m</b>` +
            (i < 5 ? `<br/>${lang === "zh" ? "占比" : "Share"}: ${((deltas[i] / Math.max(tot, 0.01)) * 100).toFixed(1)}%` : `<br/>no_nav_delay=${noDelay.toFixed(2)}m`);
        },
      },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: labelColor, fontSize: 10, interval: 0, rotate: 12 },
        axisLine: { lineStyle: { color: splitLine } },
      },
      yAxis: {
        type: "value",
        name: "m",
        nameTextStyle: { color: labelColor, fontSize: 10 },
        axisLabel: { color: labelColor, fontSize: 10 },
        splitLine: { lineStyle: { color: splitLine } },
      },
      series: [
        {
          name: "base",
          type: "bar",
          stack: "wf",
          silent: true,
          itemStyle: { borderColor: "transparent", color: "transparent" },
          data: helper,
        },
        {
          name: lang === "zh" ? "脱靶贡献" : "Miss Contrib",
          type: "bar",
          stack: "wf",
          barMaxWidth: 34,
          label: {
            show: true,
            position: "top",
            color: labelColor,
            fontSize: 10,
            formatter: (p: { value?: number }) => `${Number(p.value ?? 0).toFixed(2)}m`,
          },
          data: deltas.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: [4, 4, 0, 0] } })),
        },
      ],
    };
  }, [manifest, isLight, lang]);

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" });
    c.setOption(option);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
    };
  }, [option]);

  const title = lang === "zh"
    ? "B 平面脱靶误差归因瀑布图 (Miss-Budget Ablation)"
    : "B-Plane Miss-Budget Attribution Waterfall";

  if (isLight) {
    return (
      <figure className="academic-chart" style={{ gridColumn: "1 / -1" }}>
        <figcaption>{title}</figcaption>
        <div className="academic-chart__canvas" ref={ref} style={{ height: 245 }} />
      </figure>
    );
  }
  return (
    <div className="chart-card chart-card--large" style={{ gridColumn: "1 / -1" }}>
      <div className="chart-card__head">
        <span>{title}</span>
      </div>
      <div className="chart-card__canvas" ref={ref} style={{ height: 230 }} />
    </div>
  );
}
