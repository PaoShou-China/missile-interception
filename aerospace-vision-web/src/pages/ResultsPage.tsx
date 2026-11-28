import { useMemo } from "react";
import { useI18n } from "../i18n";
import { fmt, formatClock } from "../utils/format";
import { AcademicChart } from "../components/AcademicChart";
import { MissBudgetWaterfallCard, PerformanceRadarCard, RcsPolarCard, SeekerThermalDualCard } from "../components/SensorAnalyticsCards";
import { SpaceBasedCard } from "../components/SpaceBasedCard";
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
    const target = manifest.entities.find((e) => e.kind === "target")?.samples ?? [];
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
      hasSensors: missile.some((s) => s.radarSnrDb !== undefined),
      snr: [
        { name: "Radar dB", color: "#0F8B5F", data: pairs(missile, (s) => +(s.radarSnrDb ?? -60).toFixed(1)) },
        { name: "IIR dB", color: "#D96B27", data: pairs(missile, (s) => +(s.irSnrDb ?? -60).toFixed(1)) },
        { name: "RCS m²", color: "#2078BF", data: pairs(missile, (s) => +(s.targetRcsM2 ?? 0.005).toFixed(4)), yAxisIndex: 1 },
      ],
      thermal: [
        { name: "q̇s MW/m²", color: "#C0392B", data: pairs(missile, (s) => +(s.heatFluxMWm2 ?? 0).toFixed(2)) },
        { name: "Tw K", color: "#D97706", data: pairs(missile, (s) => +(s.wallTempK ?? 288).toFixed(0)), yAxisIndex: 1 },
        ...(missile.some((s) => s.wallTempEqK !== undefined)
          ? [{ name: "Teq K", color: "#9B2C2C", data: pairs(missile, (s) => +(s.wallTempEqK ?? s.wallTempK ?? 288).toFixed(0)), yAxisIndex: 1 }]
          : []),
      ],
      hasImm: missile.some((s) => s.immPCv !== undefined),
      imm: [
        { name: "CV", color: "#005BAC", data: pairs(missile, (s) => +(s.immPCv ?? 0.34).toFixed(3)) },
        { name: "CA/Singer", color: "#D96B27", data: pairs(missile, (s) => +(s.immPCa ?? 0.33).toFixed(3)) },
        { name: "3D-CT", color: "#0F8B5F", data: pairs(missile, (s) => +(s.immPCt ?? 0.33).toFixed(3)) },
      ],
      missile,
      target,
      termAspect: missile[missile.length - 1]?.aspectDeg ?? 75,
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
          ...(m.killProbability !== undefined ? [[t("results.metric.pk"), fmt(m.killProbability * 100, 1), "%"]] : []),
          ...(m.maxHeatFluxMWm2 !== undefined ? [[t("results.metric.heatFlux"), fmt(m.maxHeatFluxMWm2, 2), "MW/m²"]] : []),
          ...(m.maxWallTempK !== undefined ? [[t("results.metric.wallTemp"), fmt(m.maxWallTempK, 0), "K"]] : []),
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
            {chartData.hasSensors && (
              <>
                <AcademicChart
                  title={t("science.seekerSnr")}
                  xUnit="s"
                  unitA="dB"
                  unitB="m²"
                  series={chartData.snr}
                />
                <AcademicChart
                  title={t("science.aerothermal")}
                  xUnit="s"
                  unitA="MW/m²"
                  unitB="K"
                  series={chartData.thermal}
                />
              </>
            )}
            {chartData.hasImm && (
              <AcademicChart
                title="IMM 3-Model Filter (CV / CA / 3D-CT)"
                xUnit="s"
                unitA="prob"
                unitB=""
                series={chartData.imm}
              />
            )}
            {manifest && (
              <>
                <div style={{ gridColumn: "1 / -1" }}>
                  <SpaceBasedCard manifest={manifest} missile={chartData.missile} target={chartData.target} theme="light" />
                </div>
                <PerformanceRadarCard manifest={manifest} missile={chartData.missile} theme="light" />
                <RcsPolarCard aspectDeg={chartData.termAspect} theme="light" />
                <SeekerThermalDualCard missile={chartData.missile} interactive theme="light" />
                <MissBudgetWaterfallCard manifest={manifest} theme="light" />
              </>
            )}
          </div>
        </section>
      )}

      {manifest && (
        <section className="section">
          <h2 className="section__title">{t("results.phase.title")}</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("results.table.phase")}</th>
                <th>{t("results.table.start")}</th>
                <th>{t("results.table.end")}</th>
                <th>{t("results.table.duration")}</th>
              </tr>
            </thead>
            <tbody>
              {manifest.phases.map((p) => (
                <tr key={p.phase}>
                  <td className="mono">{t(`phase.${p.phase}`)}</td>
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
