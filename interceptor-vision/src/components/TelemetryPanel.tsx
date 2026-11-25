import { useApp } from "../state";
import { useT } from "../i18n";
import { sampleAt, formatMissionTime } from "../data/telemetry";

export function TelemetryPanel() {
  const t = useT();
  const telemetry = useApp((s) => s.telemetry);
  const status = useApp((s) => s.dataStatus);
  const dataTime = useApp((s) => s.dataTime);

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
    <section className="group">
      <h3>{t("telemetry")}</h3>
      <div className="mission-clock">
        <b>{formatMissionTime(dataTime)}</b>
        <span className={`lock-pill ${sample.seekerLock ? "is-lock" : ""}`}>
          {sample.seekerLock ? `LOCK ${Math.round(sample.fovDeg)}°` : "SEARCH"}
        </span>
      </div>
      <dl className="kv kv--compact">
        <dt>{t("altitude")}</dt>
        <dd>{(sample.altM / 1000).toFixed(2)} km</dd>
        <dt>{t("speed")}</dt>
        <dd>{sample.speedMS.toFixed(0)} m/s</dd>
        <dt>{t("mach")}</dt>
        <dd>{sample.mach.toFixed(2)}</dd>
        <dt>{t("dynPressure")}</dt>
        <dd>{(sample.qPa / 1000).toFixed(1)} kPa</dd>
        <dt>{t("load")}</dt>
        <dd>{sample.loadG.toFixed(2)} g</dd>
        <dt>{t("range")}</dt>
        <dd>{(sample.rangeM / 1000).toFixed(1)} km</dd>
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
    </section>
  );
}
