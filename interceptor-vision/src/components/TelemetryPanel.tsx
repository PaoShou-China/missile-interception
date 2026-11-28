import { useState } from "react";
import { useApp } from "../state";
import { useT, type StringKey } from "../i18n";
import { sampleAt, formatMissionTime, seekDataTime, type FlightEvent } from "../data/telemetry";

const EVENT_KEY: Record<string, StringKey> = {
  launch: "eventLaunch",
  phase: "eventPhase",
  stage: "eventSeparation",
  peak: "eventPeak",
  lock: "eventLock",
  handover: "eventHandover",
  intercept: "eventIntercept",
  custom: "eventPhase",
};

export function TelemetryPanel() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const telemetry = useApp((s) => s.telemetry);
  const status = useApp((s) => s.dataStatus);
  const dataTime = useApp((s) => s.dataTime);
  const [showMore, setShowMore] = useState(false);

  if (status !== "ready" || !telemetry) {
    return (
      <section className="group">
        <h3>{t("telemetry")}</h3>
        <p className="hint">{status === "error" ? t("telemetryError") : t("telemetryLoading")}</p>
      </section>
    );
  }

  const sample = sampleAt(dataTime);
  if (!sample) return null;
  const fins = sample.finDeflectionsRad;
  const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(1);

  return (
    <>
      <section className="group">
        <div className="mission-clock">
          <b>{formatMissionTime(dataTime)}</b>
          <span className={`lock-pill ${sample.seekerLock ? "is-lock" : ""}`}>
            {sample.seekerLock ? `LOCK ${Math.round(sample.fovDeg)}°` : "SEARCH"}
          </span>
        </div>
        <div className="tel-kpi-grid">
          <div className="tel-kpi"><span>{t("mach")}</span><strong>Ma {sample.mach.toFixed(2)}</strong></div>
          <div className="tel-kpi"><span>{t("altitude")}</span><strong>{(sample.altM / 1000).toFixed(1)} km</strong></div>
          <div className="tel-kpi"><span>{t("range")}</span><strong>{(sample.rangeM / 1000).toFixed(1)} km</strong></div>
          <div className="tel-kpi"><span>{t("load")}</span><strong>{sample.loadG.toFixed(1)} g</strong></div>
        </div>
        <button
          type="button"
          className="sim-adv-toggle"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
        >
          <span>{lang === "zh" ? "详细遥测（速度 / 动压 / 视场 / 舵偏）" : "More Telemetry"}</span>
          <span>{showMore ? "▴" : "▾"}</span>
        </button>
        {showMore && (
          <dl className="kv kv--compact" style={{ marginTop: 8 }}>
            <dt>{t("speed")}</dt>
            <dd>{sample.speedMS.toFixed(0)} m/s</dd>
            <dt>{t("dynPressure")}</dt>
            <dd>{(sample.qPa / 1000).toFixed(1)} kPa</dd>
            <dt>{t("seekerFov")}</dt>
            <dd>{sample.fovDeg.toFixed(1)}°</dd>
            <dt>{t("mass")}</dt>
            <dd>{sample.massKg.toFixed(0)} kg</dd>
            {fins && (
              <>
                <dt>{t("fins")}</dt>
                <dd>
                  {deg(fins.up)}/{deg(fins.down)}/{deg(fins.left)}/{deg(fins.right)}°
                </dd>
              </>
            )}
          </dl>
        )}
      </section>

      <section className="group">
        <h3>{t("events")}</h3>
        <div className="event-list">
          {telemetry.events.map((e: FlightEvent) => (
            <button
              key={e.id}
              type="button"
              className={`event-row ${dataTime >= e.t - 0.01 ? "is-passed" : ""}`}
              onClick={() => seekDataTime(e.t)}
              title={e.description}
            >
              <span className={`event-row__dot event-row__dot--${e.severity}`} />
              <span className="event-row__label">{t(EVENT_KEY[e.kind] ?? "eventPhase")}</span>
              <span className="event-row__time">{formatMissionTime(e.t)}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
