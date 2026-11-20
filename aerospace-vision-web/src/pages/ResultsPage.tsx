import { useMemo } from "react";
import { useI18n } from "../i18n";
import { fmt, formatClock } from "../utils/format";
import { AcademicChart } from "../components/AcademicChart";
import { useManifest } from "./useManifest";
import type { TrajectorySample } from "../scientific/types";

function pairs(samples: TrajectorySample[], fn: (s: TrajectorySample) => number) {
  const stride = Math.max(1, Math.ceil(samples.length / 600));
  const out: [number, number][] = [];
  for (let i = 0; i < samples.length; i += stride) out.push([samples[i].t, fn(samples[i])]);
  const last = samples[samples.length - 1];
  out.push([last.t, fn(last)]);
  return out;
}

export function ResultsPage() {
  const { t } = useI18n();
  const { manifest } = useManifest();
  const m = manifest?.metrics;

  const chartData = useMemo(() => {
    if (!manifest) return null;
    const missile = manifest.entities.find((e) => e.kind === "missile")?.samples;
    if (!missile) return null;
    return {
      altSpeed: [
        { name: "km", color: "#005BAC", data: pairs(missile, (s) => +(s.altM / 1000).toFixed(2)) },
        { name: "m/s", color: "#37B9D8", data: pairs(missile, (s) => +s.speedMS.toFixed(0)), yAxisIndex: 1 },
      ],
      qLoad: [
        { name: "kPa", color: "#2078BF", data: pairs(missile, (s) => +(s.qPa / 1000).toFixed(2)) },
        { name: "g", color: "#C0562B", data: pairs(missile, (s) => +s.loadG.toFixed(2)), yAxisIndex: 1 },
      ],
      fins: [
        { name: "up", color: "#005BAC", data: pairs(missile, (s) => +((s.finDeflectionsRad?.up ?? 0) * 57.2958).toFixed(2)) },
        { name: "right", color: "#37B9D8", data: pairs(missile, (s) => +((s.finDeflectionsRad?.right ?? 0) * 57.2958).toFixed(2)) },
        { name: "q", color: "#C0562B", data: pairs(missile, (s) => +((s.bodyRatesRadS?.q ?? 0) * 57.2958).toFixed(2)), yAxisIndex: 1 },
      ],
    };
  }, [manifest]);

  return (
    <article className="page">
      <header className="page-head">
        <p className="kicker">03 · RESULTS</p>
        <h1>{t("results.title")}</h1>
        <p className="lede">{t("results.lede")}</p>
      </header>

      <section className="metric-cards">
        {m && [
          [t("results.metric.miss"), fmt(m.missDistanceM, 2), "m"],
          [t("results.metric.intercept"), formatClock(m.interceptTimeS), ""],
          [t("results.metric.apogee"), fmt(m.maxAltitudeM / 1000, 2), "km"],
          [t("results.metric.downrange"), fmt(m.downrangeKM, 0), "km"],
          [t("results.metric.maxSpeed"), fmt(m.maxSpeedMS, 0), "m/s"],
          [t("results.metric.maxMach"), fmt(m.maxMach, 2), ""],
          [t("results.metric.maxQ"), fmt(m.maxDynamicPressurePa / 1000, 1), "kPa"],
          [t("results.metric.maxLoad"), fmt(m.maxLoadG, 1), "g"],
          [t("results.metric.fuel"), fmt(m.fuelUsedKg, 0), "kg"],
          [t("results.metric.duration"), fmt(m.flightDurationS, 1), "s"],
          [t("results.metric.handover"), m.handoverTimeS != null ? formatClock(m.handoverTimeS) : "—", ""],
          [t("results.metric.samples"), manifest ? String(manifest.time.sampleCount) : "—", ""],
        ].map(([label, value, unit]) => (
          <div className="metric-card" key={label}>
            <span>{label}</span>
            <strong>{value}<em>{unit}</em></strong>
          </div>
        ))}
      </section>

      <p className="callout">{t("results.note")}</p>

      {chartData && (
        <section className="section">
          <h2 className="section__title">{t("results.charts.title")}</h2>
          <p className="section__lede">{t("results.charts.body")}</p>
          <div className="charts-grid">
            <AcademicChart
              title={t("science.altSpeed")}
              xUnit="s"
              unitA="km"
              unitB="m/s"
              series={chartData.altSpeed}
            />
            <AcademicChart
              title={t("science.qLoad")}
              xUnit="s"
              unitA="kPa"
              unitB="g"
              series={chartData.qLoad}
            />
            <AcademicChart
              title={t("science.finRates")}
              xUnit="s"
              unitA="deg"
              unitB="deg/s"
              series={chartData.fins}
            />
          </div>
        </section>
      )}

      {manifest && (
        <section className="section">
          <h2 className="section__title">{t("results.phase.title")}</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Start</th>
                <th>End</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {manifest.phases.map((p) => (
                <tr key={p.phase}>
                  <td className="mono">{p.phase}</td>
                  <td>{formatClock(p.startT)}</td>
                  <td>{formatClock(p.endT)}</td>
                  <td>{fmt(p.endT - p.startT, 1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </article>
  );
}
