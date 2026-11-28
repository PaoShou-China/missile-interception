import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useI18n } from "../i18n";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export interface ChartSeries {
  name: string;
  color: string;
  data: [number, number][];
  yAxisIndex?: number;
}

interface Props {
  title: string;
  xUnit: string;
  unitA: string;
  unitB: string;
  series: ChartSeries[];
}

export function AcademicChart({ title, xUnit, unitA, unitB, series }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  const exportPng = () => {
    const c = chart.current;
    if (!c) return;
    const url = c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w\u4e00-\u9fa5-]+/g, "_")}_2x.png`;
    a.click();
  };

  const option = useMemo<echarts.EChartsCoreOption>(() => ({
    animation: false,
    grid: { left: 48, right: 52, top: 30, bottom: 30 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(7,26,51,0.94)",
      borderColor: "rgba(32,120,191,0.4)",
      textStyle: { color: "#eaf3fb", fontSize: 11 },
    },
    xAxis: {
      type: "value",
      min: "dataMin",
      max: "dataMax",
      axisLine: { lineStyle: { color: "rgba(11,49,92,0.35)" } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: "rgba(11,49,92,0.6)", fontSize: 10, formatter: (v: number) => `${Math.round(v)}${xUnit}` },
    },
    yAxis: [
      {
        type: "value",
        name: unitA,
        nameTextStyle: { color: "rgba(11,49,92,0.55)", fontSize: 10 },
        axisLabel: { color: "rgba(11,49,92,0.6)", fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(11,49,92,0.08)" } },
      },
      {
        type: "value",
        name: unitB,
        nameTextStyle: { color: "rgba(11,49,92,0.55)", fontSize: 10 },
        axisLabel: { color: "rgba(11,49,92,0.6)", fontSize: 10 },
        splitLine: { show: false },
      },
    ],
    series: series.map((s) => ({
      type: "line",
      name: s.name,
      data: s.data,
      yAxisIndex: s.yAxisIndex ?? 0,
      showSymbol: false,
      lineStyle: { width: 1.7, color: s.color },
      areaStyle: s.yAxisIndex ? undefined : { color: s.color, opacity: 0.1 },
    })),
  }), [series, xUnit, unitA, unitB]);

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);

  useEffect(() => { chart.current?.setOption(option); }, [option]);

  return (
    <figure className="academic-chart">
      <figcaption className="academic-chart__head">
        <span>{title}</span>
        <button type="button" className="chart-export-btn" onClick={exportPng}>
          {t("chart.exportPng")}
        </button>
      </figcaption>
      <div className="academic-chart__canvas" ref={ref} />
    </figure>
  );
}
