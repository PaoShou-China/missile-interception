import { useMemo } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";
import { seekDataTime, sampleAt } from "../data/telemetry";

interface Series {
  name: string;
  color: string;
  points: [number, number][];
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
          <path key={p.color} d={p.d} fill="none" stroke={p.color} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={cursorX} x2={cursorX} y1={0} y2={H} className="chart-cursor" />
      </svg>
      <div className="chart-scale">
        <span>{yMax.toFixed(decimals)}</span>
        <span>{yMin.toFixed(decimals)}</span>
      </div>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.name} style={{ color: s.color }}>
            {s.name}
          </span>
        ))}
      </div>
    </figure>
  );
}

const D2R = 180 / Math.PI;

export function ChartsOverlay() {
  const t = useT();
  const telemetry = useApp((s) => s.telemetry);
  const dataTime = useApp((s) => s.dataTime);
  const close = () => useApp.getState().setChartsOpen(false);

  const series = useMemo(() => {
    if (!telemetry) return null;
    const step = Math.max(1, Math.ceil(telemetry.samples.length / 520));
    const rows = telemetry.samples.filter((_, i) => i % step === 0);
    const pick = (fn: (s: ReturnType<typeof sampleAt>) => number) =>
      rows.map((s) => [s.t, fn(s)] as [number, number]);
    const fin = (key: "up" | "down" | "left" | "right") =>
      rows.map((s) => [s.t, (s.finDeflectionsRad?.[key] ?? 0) * D2R] as [number, number]);
    const rate = (key: "p" | "q" | "r") =>
      rows.map((s) => [s.t, (s.bodyRatesRadS?.[key] ?? 0) * D2R] as [number, number]);

    return [
      { title: t("altitude"), unit: "km", series: [{ name: t("altitude"), color: "#4fd1e8", points: pick((s) => s!.altM / 1000) }] },
      { title: t("speed"), unit: "m/s", series: [{ name: t("speed"), color: "#79e3a8", points: pick((s) => s!.speedMS) }] },
      { title: t("mach"), unit: "—", series: [{ name: t("mach"), color: "#e8c46a", points: pick((s) => s!.mach) }] },
      { title: t("dynPressure"), unit: "kPa", series: [{ name: "q", color: "#f0a35e", points: pick((s) => s!.qPa / 1000) }] },
      { title: t("load"), unit: "g", series: [{ name: "n", color: "#f27d7d", points: pick((s) => s!.loadG) }] },
      { title: t("range"), unit: "km", series: [{ name: t("range"), color: "#9fb4ff", points: pick((s) => s!.rangeM / 1000) }] },
      {
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
        title: "Body rate",
        unit: "deg/s",
        series: [
          { name: "p", color: "#6fd4ff", points: rate("p") },
          { name: "q", color: "#ffb36b", points: rate("q") },
          { name: "r", color: "#9fe6a8", points: rate("r") },
        ],
      },
    ];
  }, [telemetry, t]);

  return (
    <div className="charts-overlay" role="dialog" aria-modal="true">
      <header className="charts-overlay__head">
        <div>
          <h2>{t("chartsTitle")}</h2>
          <p>{t("chartsSub")}</p>
        </div>
        <button type="button" className="icon-button" onClick={close} title={t("close")}>
          ✕
        </button>
      </header>
      {series ? (
        <div className="charts-grid">
          {series.map((c) => (
            <LineChart
              key={c.title}
              title={c.title}
              unit={c.unit}
              series={c.series}
              start={telemetry!.start}
              end={telemetry!.end}
              current={dataTime}
            />
          ))}
        </div>
      ) : (
        <p className="hint">{t("telemetryLoading")}</p>
      )}
    </div>
  );
}
