import { useApp } from "../state";
import { useT, type StringKey } from "../i18n";
import {
  formatMissionTime,
  loadTelemetry,
  phaseAt,
  sampleAt,
  type Phase,
} from "../data/telemetry";

const PHASE_KEY: Record<Phase, StringKey> = {
  boost: "phaseBoost",
  midcourse: "phaseMidcourse",
  terminal: "phaseTerminal",
  coast: "phaseCoast",
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
  const lastM = telemetry.samples[telemetry.samples.length - 1];
  const lastT = telemetry.targetSamples[telemetry.targetSamples.length - 1];
  // Closing speed at the recorded closest approach, derived from the two
  // entities rather than a hard-coded figure.
  const closingKms =
    lastM && lastT
      ? Math.hypot(
          lastM.velocity.x - lastT.velocity.x,
          lastM.velocity.y - lastT.velocity.y,
          lastM.velocity.z - lastT.velocity.z,
        ) / 1000
      : null;
  const lockEvent = telemetry.events.find((e) => e.kind === "lock");
  const lockSample = lockEvent ? sampleAt(lockEvent.t) : null;
  const interceptAltKm = lastM ? lastM.altM / 1000 : null;
  const withTenths = (t: number) => {
    const total = Math.max(0, t);
    const mm = Math.floor(total / 60);
    const ss = (total % 60).toFixed(1).padStart(4, "0");
    return `T+${String(mm).padStart(2, "0")}:${ss}`;
  };

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

        {/* Headline engagement result: this is the number the demo exists to
            show, so it gets its own display-size treatment. */}
        <div className="kpi-hero">
          <span className="kpi-hero__label">{t("missShort")}</span>
          <div className="kpi-hero__value">
            {metric(m.missDistanceM, 1)}
            <em>m</em>
          </div>
          <span className="kpi-hero__tag">{t("nearMiss")}</span>
        </div>
        <div className="kpi-grid">
          <div className="kpi">
            <span>{t("interceptTime")}</span>
            <b>{withTenths(m.interceptTimeS ?? telemetry.end)}</b>
          </div>
          <div className="kpi">
            <span>{t("closingSpeed")}</span>
            <b>
              {metric(closingKms, 2)} <i>km/s</i>
            </b>
          </div>
          <div className="kpi">
            <span>{t("lockRange")}</span>
            <b>
              {metric(lockSample ? lockSample.rangeM / 1000 : null, 1)} <i>km</i>
            </b>
          </div>
          <div className="kpi">
            <span>{t("interceptAlt")}</span>
            <b>
              {metric(interceptAltKm, 2)} <i>km</i>
            </b>
          </div>
        </div>
        <div className="kpi-foot">
          {t("downrange")} {metric(m.downrangeKM, 0)} km · {t("apogee")}{" "}
          {metric((m.maxAltitudeM ?? 0) / 1000, 1)} km · {t("maxSpeed")} {metric(m.maxSpeedMS, 0)} m/s
        </div>
      </section>
    </>
  );
}
