import { useAppStore } from "../state/store";
import { useSampledState } from "./useDisplayState";
import { bodyToNedEuler } from "../scientific/attitude";
import { fmt, formatClock, latLon } from "../utils/format";
import { useI18n } from "../i18n";

const RAD2DEG = 180 / Math.PI;

function LiveValue({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: boolean }) {
  return (
    <div className={`live-value ${accent ? "live-value--accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}{unit && <em>{unit}</em>}</strong>
    </div>
  );
}

export function TelemetryPanel() {
  const runtime = useAppStore((s) => s.runtime);
  const panels = useAppStore((s) => s.panels);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const state = useSampledState();
  const { t } = useI18n();
  if (!runtime || !state) return null;

  const open = panels.telemetry;
  const euler = bodyToNedEuler(state.attitude, state.latDeg, state.lonDeg);
  const fin = state.finDeflectionsRad;
  const rates = state.bodyRatesRadS;

  return (
    <section className={`panel telemetry-panel ${open ? "" : "is-collapsed"}`}>
      <button type="button" className="panel__header" onClick={() => togglePanel("telemetry")}>
        <div>
          <span className="panel__eyebrow">{t("telemetry.eyebrow")}</span>
          <h2>{formatClock(state.t)}</h2>
        </div>
        <span className="panel__chevron">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="panel__body">
          <div className="phase-row">
            <span className={`phase-badge phase-badge--${state.phase}`}>{state.phase.toUpperCase()}</span>
            <span className={`flag ${state.seekerLock ? "flag--on" : ""}`}>{t("telemetry.seeker")} {state.seekerLock ? t("telemetry.lock") : t("telemetry.search")}</span>
            <span className={`flag ${state.handover ? "flag--on" : ""}`}>{t("telemetry.handover")} {state.handover ? t("telemetry.on") : t("telemetry.off")}</span>
          </div>

          <div className="live-grid">
            <LiveValue label={t("telemetry.altitude")} value={fmt(state.altM / 1000, 2)} unit=" km" accent />
            <LiveValue label={t("telemetry.speed")} value={fmt(state.speedMS, 1)} unit=" m/s" accent />
            <LiveValue label={t("telemetry.mach")} value={fmt(state.mach, 2)} />
            <LiveValue label={t("telemetry.dynPress")} value={fmt(state.qPa / 1000, 2)} unit=" kPa" />
            <LiveValue label={t("telemetry.load")} value={fmt(state.loadG, 2)} unit=" g" />
            <LiveValue label={t("telemetry.slantRange")} value={fmt(state.rangeM / 1000, 1)} unit=" km" />
            <LiveValue label={t("telemetry.mass")} value={fmt(state.massKg, 0)} unit=" kg" />
            <LiveValue label={t("telemetry.seekerFov")} value={fmt(state.fovDeg, 1)} unit="°" />
          </div>

          <div className="attitude-block">
            <div className="section-label">{t("telemetry.attitude")}</div>
            <div className="attitude-row">
              <div><span>{t("telemetry.roll")}</span><b>{fmt(euler.rollDeg, 1)}°</b></div>
              <div><span>{t("telemetry.pitch")}</span><b>{fmt(euler.pitchDeg, 1)}°</b></div>
              <div><span>{t("telemetry.yaw")}</span><b>{fmt(euler.yawDeg, 1)}°</b></div>
            </div>
          </div>

          <div className="attitude-block">
            <div className="section-label">{t("telemetry.fin")}</div>
            <div className="attitude-row attitude-row--4">
              <div><span>↑</span><b>{fmt(fin.up * RAD2DEG, 2)}°</b></div>
              <div><span>↓</span><b>{fmt(fin.down * RAD2DEG, 2)}°</b></div>
              <div><span>←</span><b>{fmt(fin.left * RAD2DEG, 2)}°</b></div>
              <div><span>→</span><b>{fmt(fin.right * RAD2DEG, 2)}°</b></div>
            </div>
            <div className="attitude-row">
              <div><span>p</span><b>{fmt(rates.p * RAD2DEG, 2)}°/s</b></div>
              <div><span>q</span><b>{fmt(rates.q * RAD2DEG, 2)}°/s</b></div>
              <div><span>r</span><b>{fmt(rates.r * RAD2DEG, 2)}°/s</b></div>
            </div>
          </div>

          <div className="geo-block">
            <div className="section-label">{t("telemetry.geodetic")}</div>
            <div className="geo-row"><span>{latLon(state.latDeg, state.lonDeg)}</span></div>
            <div className="geo-row"><span>ECEF</span><b>{(state.position.x / 1000).toFixed(1)}, {(state.position.y / 1000).toFixed(1)}, {(state.position.z / 1000).toFixed(1)} <em>km</em></b></div>
          </div>

          <div className="telemetry-foot">
            <span>{t("telemetry.velocityFoot")}</span>
            <span>{t("telemetry.sourceFoot")}</span>
          </div>
        </div>
      )}
    </section>
  );
}
