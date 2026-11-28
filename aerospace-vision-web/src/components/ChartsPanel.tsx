import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, MarkLineComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { TrajectorySample } from "../scientific/types";
import { bodyToNedEuler } from "../scientific/attitude";
import { useI18n } from "../i18n";

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, DataZoomComponent, CanvasRenderer]);

const AXIS_COLOR = "rgba(150,180,210,0.55)";
const LABEL_COLOR = "rgba(185,208,230,0.86)";

function pairs(samples: TrajectorySample[], fn: (s: TrajectorySample) => number) {
  const stride = Math.max(1, Math.ceil(samples.length / 700));
  const out: [number, number][] = [];
  for (let i = 0; i < samples.length; i += stride) out.push([samples[i].t, fn(samples[i])]);
  const last = samples[samples.length - 1];
  out.push([last.t, fn(last)]);
  return out;
}

export interface ChartSeries {
  name: string;
  unit: string;
  color: string;
  data: [number, number][];
  axis?: 0 | 1;
  dashed?: boolean;
}

export interface ChartSpec {
  id: string;
  title: string;
  unitA: string;
  unitB: string;
  series: ChartSeries[];
}

/** Narrow screens get larger canvas text and tighter plot margins. */
function useNarrowChart() {
  const query = "(max-width: 720px)";
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function Chart({ spec, time }: { spec: ChartSpec; time: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const { t } = useI18n();
  const narrow = useNarrowChart();
  const axisFont = narrow ? 11.5 : 10;
  const tooltipFont = narrow ? 13 : 12;

  const option = useMemo<echarts.EChartsCoreOption>(() => ({
    animation: false,
    grid: narrow
      ? { left: 44, right: 40, top: 30, bottom: 52 }
      : { left: 56, right: 56, top: 24, bottom: 42 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(8,14,24,0.94)",
      borderColor: "rgba(120,160,200,0.28)",
      textStyle: { color: "#dcecfa", fontSize: tooltipFont },
      axisPointer: { type: "line", lineStyle: { color: "rgba(255,178,87,0.55)" } },
    },
    dataZoom: [
      { type: "inside", throttle: 40 },
      {
        type: "slider",
        height: narrow ? 22 : 16,
        bottom: narrow ? 8 : 6,
        borderColor: "rgba(120,150,180,0.25)",
        backgroundColor: "rgba(255,255,255,0.03)",
        fillerColor: "rgba(55,185,216,0.14)",
        handleStyle: { color: "rgba(55,185,216,0.8)" },
        textStyle: { color: LABEL_COLOR, fontSize: axisFont },
        labelFormatter: (v: number) => `${Math.round(v)}s`,
      },
    ],
    xAxis: {
      type: "value",
      min: "dataMin",
      max: "dataMax",
      axisLine: { lineStyle: { color: AXIS_COLOR } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: LABEL_COLOR,
        fontSize: axisFont,
        hideOverlap: true,
        formatter: (v: number) => `${Math.round(v)}s`,
      },
    },
    yAxis: [
      {
        type: "value",
        name: spec.unitA,
        nameTextStyle: { color: LABEL_COLOR, fontSize: axisFont },
        axisLabel: { color: LABEL_COLOR, fontSize: axisFont },
        splitLine: { lineStyle: { color: "rgba(120,150,180,0.1)" } },
      },
      {
        type: "value",
        name: spec.unitB,
        nameTextStyle: { color: LABEL_COLOR, fontSize: axisFont },
        axisLabel: { color: LABEL_COLOR, fontSize: axisFont },
        splitLine: { show: false },
      },
    ],
    series: [
      ...spec.series.map((s) => ({
        name: s.name,
        type: "line" as const,
        data: s.data,
        yAxisIndex: s.axis ?? 0,
        showSymbol: false,
        lineStyle: {
          width: s.dashed ? 1.2 : 1.8,
          color: s.color,
          type: s.dashed ? "dashed" : "solid",
        },
        areaStyle: (s.axis ?? 0) === 0 && !s.dashed
          ? { color: s.color, opacity: 0.08 }
          : undefined,
      })),
      {
        name: t("chart.current"),
        type: "line" as const,
        data: [],
        showSymbol: false,
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ xAxis: time }],
          lineStyle: { color: "rgba(255,255,255,0.55)", width: 1, type: "dashed" },
          label: { show: false },
        },
      },
    ],
  }), [spec, time, t, narrow, axisFont, tooltipFont]);

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option);
  }, [option]);

  return (
    <div className="chart-card chart-card--large">
      <div className="chart-card__head">
        <span>{spec.title}</span>
        <div className="chart-card__legend">
          {spec.series.map((s) => (
            <span key={s.name} className="chart-card__legend-item">
              <i style={{ background: s.color }} /> {s.name}
            </span>
          ))}
        </div>
        <div className="chart-card__actions">
          <button
            type="button"
            onClick={() => chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 })}
          >
            {t("chart.resetZoom")}
          </button>
        </div>
      </div>
      <div className="chart-card__canvas" ref={ref} />
    </div>
  );
}

export function buildChartSpecs(
  runtime: { missile: TrajectorySample[] },
  t: (key: string) => string,
): ChartSpec[] {
  const s = runtime.missile;
  const DEG = 180 / Math.PI;
  const euler = (x: TrajectorySample) => bodyToNedEuler(x.attitude, x.latDeg, x.lonDeg);
  return [
    {
      id: "alt-speed",
      title: t("science.altSpeed"),
      unitA: "km",
      unitB: "m/s",
      series: [
        { name: t("series.alt"), unit: "km", color: "#ffb257", data: pairs(s, (x) => +(x.altM / 1000).toFixed(2)) },
        { name: t("series.speed"), unit: "m/s", color: "#63e6ff", axis: 1, data: pairs(s, (x) => +x.speedMS.toFixed(1)) },
      ],
    },
    {
      id: "q-load",
      title: t("science.qLoad"),
      unitA: "kPa",
      unitB: "g",
      series: [
        { name: t("series.q"), unit: "kPa", color: "#ff8a6b", data: pairs(s, (x) => +(x.qPa / 1000).toFixed(2)) },
        { name: t("series.load"), unit: "g", color: "#b6f4ff", axis: 1, data: pairs(s, (x) => +x.loadG.toFixed(2)) },
      ],
    },
    {
      id: "load-cmd",
      title: t("science.loadCmd"),
      unitA: "g",
      unitB: "",
      series: [
        { name: t("series.load"), unit: "g", color: "#ffb257", data: pairs(s, (x) => +x.loadG.toFixed(2)) },
        { name: t("series.loadCmd"), unit: "g", color: "#7fe0a8", dashed: true, data: pairs(s, (x) => +x.loadCmdG.toFixed(2)) },
      ],
    },
    {
      id: "attitude",
      title: t("science.attitude"),
      unitA: "deg",
      unitB: "",
      series: [
        { name: t("series.roll"), unit: "deg", color: "#ff8a6b", data: pairs(s, (x) => +euler(x).rollDeg.toFixed(1)) },
        { name: t("series.pitch"), unit: "deg", color: "#63e6ff", data: pairs(s, (x) => +euler(x).pitchDeg.toFixed(1)) },
        { name: t("series.yaw"), unit: "deg", color: "#b6f4ff", data: pairs(s, (x) => +euler(x).yawDeg.toFixed(1)) },
      ],
    },
    {
      id: "rates",
      title: t("science.rates"),
      unitA: "deg/s",
      unitB: "",
      series: [
        { name: t("series.p"), unit: "deg/s", color: "#ffb257", data: pairs(s, (x) => +((x.bodyRatesRadS?.p ?? 0) * DEG).toFixed(2)) },
        { name: t("series.qRate"), unit: "deg/s", color: "#63e6ff", data: pairs(s, (x) => +((x.bodyRatesRadS?.q ?? 0) * DEG).toFixed(2)) },
        { name: t("series.rRate"), unit: "deg/s", color: "#7fe0a8", data: pairs(s, (x) => +((x.bodyRatesRadS?.r ?? 0) * DEG).toFixed(2)) },
      ],
    },
    {
      id: "fins",
      title: t("science.fins"),
      unitA: "deg",
      unitB: "",
      series: [
        { name: t("series.finUp"), unit: "deg", color: "#ffb257", data: pairs(s, (x) => +((x.finDeflectionsRad?.up ?? 0) * DEG).toFixed(2)) },
        { name: t("series.finDown"), unit: "deg", color: "#63e6ff", data: pairs(s, (x) => +((x.finDeflectionsRad?.down ?? 0) * DEG).toFixed(2)) },
        { name: t("series.finLeft"), unit: "deg", color: "#7fe0a8", data: pairs(s, (x) => +((x.finDeflectionsRad?.left ?? 0) * DEG).toFixed(2)) },
        { name: t("series.finRight"), unit: "deg", color: "#ff8a6b", data: pairs(s, (x) => +((x.finDeflectionsRad?.right ?? 0) * DEG).toFixed(2)) },
      ],
    },
    {
      id: "mach-range",
      title: t("science.mach"),
      unitA: "Ma",
      unitB: "km",
      series: [
        { name: t("series.mach"), unit: "Ma", color: "#8ab4ff", data: pairs(s, (x) => +x.mach.toFixed(2)) },
        { name: t("series.range"), unit: "km", color: "#b7f0c2", axis: 1, data: pairs(s, (x) => +(x.rangeM / 1000).toFixed(1)) },
      ],
    },
    {
      id: "mass",
      title: t("science.mass"),
      unitA: "kg",
      unitB: "kg",
      series: [
        { name: t("series.mass"), unit: "kg", color: "#ffcf7a", data: pairs(s, (x) => +x.massKg.toFixed(1)) },
        { name: t("series.propellant"), unit: "kg", color: "#7fe0a8", axis: 1, data: pairs(s, (x) => +(s[0].massKg - x.massKg).toFixed(1)) },
      ],
    },
    ...(s.some((x) => x.radarSnrDb !== undefined)
      ? [
          {
            id: "seeker-snr",
            title: t("science.seekerSnr"),
            unitA: "dB",
            unitB: "m²",
            series: [
              { name: t("series.radarSnr"), unit: "dB", color: "#68f2a8", data: pairs(s, (x) => +(x.radarSnrDb ?? -60).toFixed(2)) },
              { name: t("series.irSnr"), unit: "dB", color: "#ff9b66", data: pairs(s, (x) => +(x.irSnrDb ?? -60).toFixed(2)) },
              { name: t("series.cfar"), unit: "dB", color: "#ffd86b", dashed: true, data: pairs(s, () => 13) },
              { name: t("series.rcs"), unit: "m²", color: "#63e6ff", axis: 1 as const, dashed: true, data: pairs(s, (x) => +(x.targetRcsM2 ?? 0.005).toFixed(4)) },
            ],
          },
          {
            id: "aerothermal",
            title: t("science.aerothermal"),
            unitA: "MW/m²",
            unitB: "K",
            series: [
              { name: t("series.heatFlux"), unit: "MW/m²", color: "#ff7266", data: pairs(s, (x) => +(x.heatFluxMWm2 ?? 0).toFixed(3)) },
              { name: t("series.wallTemp"), unit: "K", color: "#ffcf7a", axis: 1 as const, data: pairs(s, (x) => +(x.wallTempK ?? 288).toFixed(1)) },
              ...(s.some((x) => x.wallTempEqK !== undefined)
                ? [{ name: "Teq (eq)", unit: "K", color: "#ffa8b6", axis: 1 as const, dashed: true, data: pairs(s, (x) => +(x.wallTempEqK ?? x.wallTempK ?? 288).toFixed(1)) }]
                : []),
            ],
          },
          ...(s.some((x) => x.immPCv !== undefined)
            ? [{
                id: "imm-modes",
                title: "IMM 3-Model Filter (CV / CA / 3D-CT)",
                unitA: "prob",
                unitB: "",
                series: [
                  { name: "CV", unit: "", color: "#63e6ff", data: pairs(s, (x) => +(x.immPCv ?? 0.34).toFixed(3)) },
                  { name: "CA / Singer", unit: "", color: "#ffb257", data: pairs(s, (x) => +(x.immPCa ?? 0.33).toFixed(3)) },
                  { name: "3D-CT Turn", unit: "", color: "#7fe0a8", data: pairs(s, (x) => +(x.immPCt ?? 0.33).toFixed(3)) },
                ],
              }]
            : []),
        ]
      : []),
  ];
}
