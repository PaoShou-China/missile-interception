import type { LoadedRun } from "./types";
import type { TrajectorySample } from "../scientific/types";
import type { ChartSpec } from "../components/ChartsPanel";
import { differenceSeries } from "./validation";

const A_COLOR = "#2f7fd0";
const B_COLOR = "#37b9d8";

function pairs(s: TrajectorySample[], fn: (x: TrajectorySample) => number) {
  const stride = Math.max(1, Math.ceil(s.length / 600));
  const out: [number, number][] = [];
  for (let i = 0; i < s.length; i += stride) out.push([s[i].t, fn(s[i])]);
  const last = s[s.length - 1];
  out.push([last.t, fn(last)]);
  return out;
}

export function buildCompareSpecs(
  a: LoadedRun,
  b: LoadedRun | null,
  tA: number,
  tB: number,
  title: (key: string) => string,
): ChartSpec[] {
  const mk = (
    id: string,
    titleKey: string,
    unitA: string,
    unitB: string,
    pick: (x: TrajectorySample) => number,
    scale = 1,
  ): ChartSpec => {
    const series = [
      { name: "A", unit: unitA, color: A_COLOR, data: pairs(a.missile, (x) => +(pick(x) / scale).toFixed(2)) },
    ];
    if (b) {
      series.push({ name: "B", unit: unitA, color: B_COLOR, data: pairs(b.missile, (x) => +(pick(x) / scale).toFixed(2)) });
    }
    return { id, title: title(titleKey), unitA, unitB, series };
  };
  return [
    mk("alt", "compare.chart.alt", "km", "", (x) => x.altM, 1000),
    mk("speed", "compare.chart.speed", "m/s", "", (x) => x.speedMS),
    mk("load", "compare.chart.load", "g", "", (x) => x.loadG),
    mk("q", "compare.chart.q", "kPa", "", (x) => x.qPa, 1000),
  ];
  // tA/tB are intentionally unused here: the shared cursor is drawn by Chart
  // via its `time` prop in the page.
  void tA;
  void tB;
}

export function buildDifferenceSpecs(
  a: LoadedRun,
  b: LoadedRun,
  title: (key: string) => string,
): ChartSpec[] {
  const defs: { id: string; name: string; unit: string; pick: (x: TrajectorySample) => number; scale?: number }[] = [
    { id: "d-alt", name: "Δ altitude", unit: "km", pick: (x) => x.altM, scale: 1000 },
    { id: "d-speed", name: "Δ speed", unit: "m/s", pick: (x) => x.speedMS },
    { id: "d-load", name: "Δ load", unit: "g", pick: (x) => x.loadG },
  ];
  return defs.map((d) => ({
    id: d.id,
    title: title("compare.chart.diff"),
    unitA: d.unit,
    unitB: "",
    series: [{
      name: d.name,
      unit: d.unit,
      color: "#ffb257",
      data: differenceSeries(a.missile, b.missile, d.pick).map(([t, v]) => [t, +(v / (d.scale ?? 1)).toFixed(3)] as [number, number]),
    }],
  }));
}

export { A_COLOR, B_COLOR };
