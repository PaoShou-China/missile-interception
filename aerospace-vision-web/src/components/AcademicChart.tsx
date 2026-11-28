import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useI18n } from "../i18n";

echarts.use([LineChart, GridComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

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
  cursorT?: number;
  theme?: "light" | "dark";
}

export function AcademicChart({ title, xUnit, unitA, unitB, series, cursorT, theme = "light" }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const isDark = theme === "dark";

  const exportPng = () => {
    const c = chart.current;
    if (!c) return;
    const url = c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: isDark ? "#081220" : "#ffffff" });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w\u4e00-\u9fa5-]+/g, "_")}_2x.png`;
    a.click();
  };

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const axisLine = isDark ? "rgba(130,175,215,0.28)" : "rgba(11,49,92,0.35)";
    const axisLabel = isDark ? "rgba(195,220,242,0.72)" : "rgba(11,49,92,0.6)";
    const splitLine = isDark ? "rgba(130,175,215,0.10)" : "rgba(11,49,92,0.08)";
    return {
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
        axisLine: { lineStyle: { color: axisLine } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: axisLabel, fontSize: 10, formatter: (v: number) => `${Math.round(v)}${xUnit}` },
      },
      yAxis: [
        {
          type: "value",
          name: unitA,
          nameTextStyle: { color: axisLabel, fontSize: 10 },
          axisLabel: { color: axisLabel, fontSize: 10 },
          splitLine: { lineStyle: { color: splitLine } },
        },
        {
          type: "value",
          name: unitB,
          nameTextStyle: { color: axisLabel, fontSize: 10 },
          axisLabel: { color: axisLabel, fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: series.map((s, idx) => ({
        id: `s${idx}`,
        type: "line",
        name: s.name,
        data: s.data,
        yAxisIndex: s.yAxisIndex ?? 0,
        showSymbol: false,
        lineStyle: { width: 1.7, color: s.color },
        areaStyle: s.yAxisIndex ? undefined : { color: s.color, opacity: isDark ? 0.14 : 0.1 },
      })),
    };
  }, [series, xUnit, unitA, unitB, isDark]);

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);

  useEffect(() => { chart.current?.setOption(option, true); }, [option]);

  useEffect(() => {
    if (cursorT === undefined || !chart.current) return;
    chart.current.setOption({
      series: [
        {
          id: "s0",
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            lineStyle: { color: "#f59e0b", width: 1.4, type: "dashed" },
            label: { show: false },
            data: [{ xAxis: cursorT }],
          },
        },
      ],
    });
  }, [cursorT, option]);

  return (
    <figure className={`academic-chart ${isDark ? "academic-chart--dark" : ""}`}>
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
