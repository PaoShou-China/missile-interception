import { useApp } from "../state";
import { useT, type StringKey } from "../i18n";
import {
  formatMissionTime,
  loadTelemetry,
  phaseAt,
  seekDataTime,
  type Phase,
  type FlightEvent,
} from "../data/telemetry";

const PHASE_KEY: Record<Phase, StringKey> = {
  boost: "phaseBoost",
  midcourse: "phaseMidcourse",
  terminal: "phaseTerminal",
  coast: "phaseCoast",
};

const EVENT_KEY: Record<string, StringKey> = {
  launch: "eventLaunch",
  phase: "eventPhase",
  peak: "eventPeak",
  lock: "eventLock",
  handover: "eventHandover",
  intercept: "eventIntercept",
  custom: "eventPhase",
};

function metric(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function MissionPanel() {
  const t = useT();
  const telemetry = useApp((s) => s.telemetry);
  const status = useApp((s) => s.dataStatus);
  const dataTime = useApp((s) => s.dataTime);
  const phase = phaseAt(dataTime);

  if (status === "loading" || status === "idle") {
    return (
      <section className="group">
        <h3>{t("mission")}</h3>
        <p className="hint">{t("telemetryLoading")}</p>
      </section>
    );
  }

  if (status === "error" || !telemetry) {
    return (
      <section className="group">
        <h3>{t("mission")}</h3>
        <p className="hint hint--warn">{t("telemetryError")}</p>
        <button type="button" className="ghost-btn ghost-btn--sm" onClick={() => void loadTelemetry()}>
          {t("retry")}
        </button>
      </section>
    );
  }

  const m = telemetry.metrics;

  return (
    <>
      <section className="group">
        <h3>{t("mission")}</h3>
        <div className="mission-head">
          <span className="mission-title">{telemetry.title}</span>
          <span className={`phase-badge phase-badge--${phase?.phase ?? "midcourse"}`}>
            {phase ? t(PHASE_KEY[phase.phase]) : "—"}
          </span>
        </div>
        <div className="mission-clock">
          <b>{formatMissionTime(dataTime)}</b>
          <span>/ {formatMissionTime(telemetry.end)}</span>
        </div>
        <dl className="kv kv--compact">
          <dt>{t("apogee")}</dt>
          <dd>{metric((m.maxAltitudeM ?? 0) / 1000, 1)} km</dd>
          <dt>{t("maxSpeed")}</dt>
          <dd>{metric(m.maxSpeedMS, 0)} m/s</dd>
          <dt>{t("missDistance")}</dt>
          <dd>{metric(m.missDistanceM, 1)} m</dd>
          <dt>{t("duration")}</dt>
          <dd>{formatMissionTime(m.flightDurationS ?? telemetry.end)}</dd>
        </dl>
      </section>

      <section className="group">
        <h3>{t("telemetry")}</h3>
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
