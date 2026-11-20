import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, MarkLineComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useAppStore } from "../state/store";
import type { TrajectorySample } from "../scientific/types";
import { useI18n } from "../i18n";

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);

const AXIS_COLOR = "rgba(140,168,198,0.5)";
const LABEL_COLOR = "rgba(160,185,210,0.72)";

function pairs(samples: TrajectorySample[], fn: (s: TrajectorySample) => number) {
  const stride = Math.max(1, Math.ceil(samples.length / 700));
  const out: [number, number][] = [];
  for (let i = 0; i < samples.length; i += stride) out.push([samples[i].t, fn(samples[i])]);
  const last = samples[samples.length - 1];
  out.push([last.t, fn(last)]);
  return out;
}

interface ChartSpec {
  id: string;
  title: string;
  unitA: string;
  unitB: string;
  seriesA: [number, number][];
  seriesB: [number, number][];
  colorA: string;
  colorB: string;
  digitsA: number;
  digitsB: number;
}

function Chart({ spec, time }: { spec: ChartSpec; time: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  const option = useMemo<echarts.EChartsCoreOption>(() => ({
    animation: false,
    grid: { left: 42, right: 44, top: 18, bottom: 20 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(8,14,24,0.92)",
      borderColor: "rgba(120,160,200,0.25)",
      textStyle: { color: "#cfe3f5", fontSize: 11 },
      axisPointer: { type: "line", lineStyle: { color: "rgba(255,178,87,0.5)" } },
    },
    xAxis: {
      type: "value",
      min: "dataMin",
      max: "dataMax",
      axisLine: { lineStyle: { color: AXIS_COLOR } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: LABEL_COLOR, fontSize: 9, formatter: (v: number) => `${Math.round(v)}s` },
    },
    yAxis: [
      {
        type: "value",
        axisLabel: { color: LABEL_COLOR, fontSize: 9 },
        splitLine: { lineStyle: { color: "rgba(120,150,180,0.09)" } },
      },
      {
        type: "value",
        axisLabel: { color: LABEL_COLOR, fontSize: 9 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        type: "line",
        data: spec.seriesA,
        showSymbol: false,
        lineStyle: { width: 1.4, color: spec.colorA },
        areaStyle: { color: spec.colorA, opacity: 0.12 },
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ xAxis: time }],
          lineStyle: { color: "rgba(255,255,255,0.55)", width: 1, type: "dashed" },
          label: { show: false },
        },
      },
      {
        type: "line",
        yAxisIndex: 1,
        data: spec.seriesB,
        showSymbol: false,
        lineStyle: { width: 1.2, color: spec.colorB },
      },
    ],
  }), [spec, time]);

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
    if (!chart.current) return;
    chart.current.setOption({
      series: [{ markLine: { data: [{ xAxis: time }] } }, {}],
    }, { lazyUpdate: true });
  }, [time]);

  useEffect(() => {
    chart.current?.setOption(option);
  }, [option]);

  return (
    <div className="chart-card">
      <div className="chart-card__head">
        <span>{spec.title}</span>
        <div className="chart-card__legend">
          <i style={{ background: spec.colorA }} /> {spec.unitA}
          <i style={{ background: spec.colorB }} /> {spec.unitB}
        </div>
      </div>
      <div className="chart-card__canvas" ref={ref} />
    </div>
  );
}

export function ChartsPanel() {
  const runtime = useAppStore((s) => s.runtime);
  const time = useAppStore((s) => s.time);
  const panels = useAppStore((s) => s.panels);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const { t } = useI18n();

  const charts = useMemo<ChartSpec[]>(() => {
    if (!runtime) return [];
    const s = runtime.missile;
    const DEG = 180 / Math.PI;
    return [
      {
        id: "alt-speed",
        title: t("science.altSpeed"),
        unitA: "km",
        unitB: "m/s",
        colorA: "#ffb257",
        colorB: "#63e6ff",
        digitsA: 1,
        digitsB: 0,
        seriesA: pairs(s, (x) => +(x.altM / 1000).toFixed(2)),
        seriesB: pairs(s, (x) => +x.speedMS.toFixed(1)),
      },
      {
        id: "q-load",
        title: t("science.qLoad"),
        unitA: "kPa",
        unitB: "g",
        colorA: "#ff8a6b",
        colorB: "#b6f4ff",
        digitsA: 1,
        digitsB: 1,
        seriesA: pairs(s, (x) => +(x.qPa / 1000).toFixed(2)),
        seriesB: pairs(s, (x) => +x.loadG.toFixed(2)),
      },
      {
        id: "fin-rates",
        title: t("science.finRates"),
        unitA: "°",
        unitB: "°/s",
        colorA: "#ffcf7a",
        colorB: "#7fe0a8",
        digitsA: 1,
        digitsB: 1,
        seriesA: pairs(s, (x) => +((x.finDeflectionsRad?.up ?? 0) * DEG).toFixed(2)),
        seriesB: pairs(s, (x) => +((x.bodyRatesRadS?.q ?? 0) * DEG).toFixed(2)),
      },
    ];
  }, [runtime, t]);

  if (!runtime) return null;
  const open = panels.charts;

  return (
    <section className={`panel charts-panel ${open ? "" : "is-collapsed"}`}>
      <button type="button" className="panel__header" onClick={() => togglePanel("charts")}>
        <div>
          <span className="panel__eyebrow">{t("science.eyebrow")}</span>
          <h2>{t("science.title")}</h2>
        </div>
        <span className="panel__chevron">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="panel__body charts-panel__body">
          {charts.map((c) => <Chart key={c.id} spec={c} time={time} />)}
          <p className="charts-note">{t("science.note")}</p>
        </div>
      )}
    </section>
  );
}
