import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, MarkLineComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useAppStore } from "../state/store";
import type { TrajectorySample } from "../scientific/types";
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

export interface ChartSpec {
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

export function Chart({
  spec,
  time,
  large = false,
  onExpand,
  onClose,
}: {
  spec: ChartSpec;
  time: number;
  large?: boolean;
  onExpand?: () => void;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const { t } = useI18n();

  const option = useMemo<echarts.EChartsCoreOption>(() => ({
    animation: false,
    grid: { left: 54, right: 54, top: 24, bottom: 42 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(8,14,24,0.94)",
      borderColor: "rgba(120,160,200,0.28)",
      textStyle: { color: "#dcecfa", fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: "rgba(255,178,87,0.55)" } },
    },
    dataZoom: [
      { type: "inside", throttle: 40 },
      {
        type: "slider",
        height: 16,
        bottom: 6,
        borderColor: "rgba(120,150,180,0.25)",
        backgroundColor: "rgba(255,255,255,0.03)",
        fillerColor: "rgba(55,185,216,0.14)",
        handleStyle: { color: "rgba(55,185,216,0.8)" },
        textStyle: { color: LABEL_COLOR, fontSize: 10 },
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
      axisLabel: { color: LABEL_COLOR, fontSize: 10, formatter: (v: number) => `${Math.round(v)}s` },
    },
    yAxis: [
      {
        type: "value",
        axisLabel: { color: LABEL_COLOR, fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(120,150,180,0.1)" } },
      },
      {
        type: "value",
        axisLabel: { color: LABEL_COLOR, fontSize: 10 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: spec.unitA,
        type: "line",
        data: spec.seriesA,
        showSymbol: false,
        lineStyle: { width: 1.8, color: spec.colorA },
        areaStyle: { color: spec.colorA, opacity: 0.12 },
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ xAxis: time }],
          lineStyle: { color: "rgba(255,255,255,0.58)", width: 1, type: "dashed" },
          label: { show: false },
        },
      },
      {
        name: spec.unitB,
        type: "line",
        yAxisIndex: 1,
        data: spec.seriesB,
        showSymbol: false,
        lineStyle: { width: 1.4, color: spec.colorB },
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
    <div className={`chart-card ${large ? "chart-card--large" : ""}`}>
      <div className="chart-card__head">
        <span>{spec.title}</span>
        <div className="chart-card__legend">
          <i style={{ background: spec.colorA }} /> {spec.unitA}
          <i style={{ background: spec.colorB }} /> {spec.unitB}
        </div>
        {large ? (
          <div className="chart-card__actions">
            <button
              type="button"
              onClick={() => chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 })}
            >
              {t("chart.resetZoom")}
            </button>
            {onClose && <button type="button" onClick={onClose}>{t("chart.close")}</button>}
          </div>
        ) : (
          <button type="button" className="chart-card__expand" onClick={onExpand} aria-label={t("chart.expand")}>
            ⤢
          </button>
        )}
      </div>
      <div className="chart-card__canvas" ref={ref} />
      {large && <p className="chart-card__hint">{t("chart.zoomHint")}</p>}
    </div>
  );
}

export function buildChartSpecs(
  runtime: { missile: TrajectorySample[] },
  t: (key: string) => string,
): ChartSpec[] {
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
    {
      id: "mach",
      title: t("science.mach"),
      unitA: "Ma",
      unitB: "km",
      colorA: "#8ab4ff",
      colorB: "#b7f0c2",
      digitsA: 2,
      digitsB: 1,
      seriesA: pairs(s, (x) => +x.mach.toFixed(2)),
      seriesB: pairs(s, (x) => +(x.rangeM / 1000).toFixed(1)),
    },
  ];
}

export function ChartsPanel() {
  const runtime = useAppStore((s) => s.runtime);
  const time = useAppStore((s) => s.time);
  const panels = useAppStore((s) => s.panels);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const [expanded, setExpanded] = useState<ChartSpec | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const charts = useMemo<ChartSpec[]>(
    () => (runtime ? buildChartSpecs(runtime, t) : []),
    [runtime, t],
  );

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
          {charts.map((c) => (
            <Chart key={c.id} spec={c} time={time} onExpand={() => setExpanded(c)} />
          ))}
          <p className="charts-note">{t("science.note")}</p>
        </div>
      )}
      {expanded && createPortal(
        <div className="chart-modal" role="dialog" aria-modal="true" aria-label={expanded.title}>
          <div className="chart-modal__inner">
            <Chart spec={expanded} time={time} large onClose={() => setExpanded(null)} />
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
