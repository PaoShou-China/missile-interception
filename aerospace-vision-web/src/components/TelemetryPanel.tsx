import { useAppStore } from "../state/store";
import { useSampledState } from "./useDisplayState";
import { bodyToNedEuler } from "../scientific/attitude";
import { fmt, formatClock, latLon } from "../utils/format";

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
  if (!runtime || !state) return null;

  const open = panels.telemetry;
  const euler = bodyToNedEuler(state.attitude, state.latDeg, state.lonDeg);

  return (
    <section className={`panel telemetry-panel ${open ? "" : "is-collapsed"}`}>
      <button type="button" className="panel__header" onClick={() => togglePanel("telemetry")}>
        <div>
          <span className="panel__eyebrow">LIVE TELEMETRY</span>
          <h2>{formatClock(state.t)}</h2>
        </div>
        <span className="panel__chevron">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="panel__body">
          <div className="phase-row">
            <span className={`phase-badge phase-badge--${state.phase}`}>{state.phase.toUpperCase()}</span>
            <span className={`flag ${state.seekerLock ? "flag--on" : ""}`}>SEEKER {state.seekerLock ? "LOCK" : "SEARCH"}</span>
            <span className={`flag ${state.handover ? "flag--on" : ""}`}>HANDOVER {state.handover ? "ON" : "OFF"}</span>
          </div>

          <div className="live-grid">
            <LiveValue label="ALTITUDE" value={fmt(state.altM / 1000, 2)} unit=" km" accent />
            <LiveValue label="SPEED" value={fmt(state.speedMS, 1)} unit=" m/s" accent />
            <LiveValue label="MACH" value={fmt(state.mach, 2)} />
            <LiveValue label="DYN PRESS" value={fmt(state.qPa / 1000, 2)} unit=" kPa" />
            <LiveValue label="LOAD" value={fmt(state.loadG, 2)} unit=" g" />
            <LiveValue label="SLANT RANGE" value={fmt(state.rangeM / 1000, 1)} unit=" km" />
            <LiveValue label="MASS" value={fmt(state.massKg, 0)} unit=" kg" />
            <LiveValue label="SEEKER FOV" value={fmt(state.fovDeg, 1)} unit="°" />
          </div>

          <div className="attitude-block">
            <div className="section-label">ATTITUDE · LOCAL NED</div>
            <div className="attitude-row">
              <div><span>ROLL</span><b>{fmt(euler.rollDeg, 1)}°</b></div>
              <div><span>PITCH</span><b>{fmt(euler.pitchDeg, 1)}°</b></div>
              <div><span>YAW</span><b>{fmt(euler.yawDeg, 1)}°</b></div>
            </div>
          </div>

          <div className="geo-block">
            <div className="section-label">GEODETIC · WGS84</div>
            <div className="geo-row"><span>{latLon(state.latDeg, state.lonDeg)}</span></div>
            <div className="geo-row"><span>ECEF</span><b>{(state.position.x / 1000).toFixed(1)}, {(state.position.y / 1000).toFixed(1)}, {(state.position.z / 1000).toFixed(1)} <em>km</em></b></div>
          </div>

          <div className="telemetry-foot">
            <span>Velocity: Earth-relative (ECEF)</span>
            <span>Source: validated telemetry</span>
          </div>
        </div>
      )}
    </section>
  );
}
