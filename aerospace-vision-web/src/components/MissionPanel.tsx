import { useState } from "react";
import { useAppStore } from "../state/store";
import { fmt, formatClock } from "../utils/format";

export function MissionPanel() {
  const runtime = useAppStore((s) => s.runtime);
  const seek = useAppStore((s) => s.seek);
  const time = useAppStore((s) => s.time);
  const panels = useAppStore((s) => s.panels);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const [showChecks, setShowChecks] = useState(false);

  if (!runtime) return null;
  const m = runtime.manifest.metrics;
  const open = panels.mission;

  return (
    <section className={`panel mission-panel ${open ? "" : "is-collapsed"}`}>
      <button type="button" className="panel__header" onClick={() => togglePanel("mission")}>
        <div>
          <span className="panel__eyebrow">MISSION</span>
          <h2>{runtime.manifest.title}</h2>
        </div>
        <span className="panel__chevron">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="panel__body">
          <p className="mission-panel__desc">{runtime.manifest.description}</p>

          <div className="hero-metrics">
            <div>
              <span className="metric__label">INTERCEPT</span>
              <strong>{formatClock(m.interceptTimeS)}</strong>
            </div>
            <div>
              <span className="metric__label">MISS DISTANCE</span>
              <strong>{fmt(m.missDistanceM, 1)}<em> m</em></strong>
            </div>
            <div>
              <span className="metric__label">PEAK MACH</span>
              <strong>{fmt(m.maxMach, 2)}</strong>
            </div>
          </div>

          <dl className="metric-grid">
            <div><dt>Max speed</dt><dd>{fmt(m.maxSpeedMS / 1000, 3)} <em>km/s</em></dd></div>
            <div><dt>Apogee</dt><dd>{fmt(m.maxAltitudeM / 1000, 2)} <em>km</em></dd></div>
            <div><dt>Downrange</dt><dd>{fmt(m.downrangeKM, 1)} <em>km</em></dd></div>
            <div><dt>Max q</dt><dd>{fmt(m.maxDynamicPressurePa / 1000, 1)} <em>kPa</em></dd></div>
            <div><dt>Max load</dt><dd>{fmt(m.maxLoadG, 2)} <em>g</em></dd></div>
            <div><dt>Duration</dt><dd>{fmt(m.flightDurationS, 1)} <em>s</em></dd></div>
          </dl>

          <div className="phase-strip">
            {runtime.manifest.phases.map((p) => (
              <button
                key={p.phase}
                type="button"
                className={`phase-chip phase-chip--${p.phase} ${time >= p.startT && time <= p.endT ? "is-current" : ""}`}
                onClick={() => seek(p.startT)}
                title={`${p.label}: ${formatClock(p.startT)} → ${formatClock(p.endT)}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="event-list">
            <div className="section-label">TIMELINE EVENTS</div>
            {runtime.manifest.events.map((e) => (
              <button
                type="button"
                key={e.id}
                className={`event-row event-row--${e.severity}`}
                onClick={() => seek(e.t)}
              >
                <span className="event-row__time">{formatClock(e.t)}</span>
                <span className="event-row__label">{e.label}</span>
              </button>
            ))}
          </div>

          <div className="provenance">
            <div className="section-label">DATA PROVENANCE</div>
            <div className="provenance__row"><span>Source</span><b>6-DoF simulation telemetry</b></div>
            <div className="provenance__row"><span>Frame</span><b>WGS84 ECEF · SI units</b></div>
            <div className="provenance__row"><span>Samples</span><b>{runtime.manifest.time.sampleCount} / {runtime.manifest.time.sourceRows} rows</b></div>
            <div className="provenance__row"><span>Schema</span><b>v{runtime.manifest.schemaVersion}</b></div>
            <div className="provenance__row"><span>Track</span><b>symbolic width · exact centreline</b></div>
            <button
              type="button"
              className={`validation-toggle ${runtime.manifest.validation.status === "PASS" ? "is-ok" : "is-bad"}`}
              onClick={() => setShowChecks((v) => !v)}
            >
              <span className="status-pill__dot" />
              {runtime.manifest.validation.status === "PASS" ? "SCIENTIFIC VALIDATION PASS" : "VALIDATION FAILED"}
              <span className="validation-toggle__chevron">{showChecks ? "▾" : "▸"}</span>
            </button>
            {showChecks && (
              <ul className="check-list">
                {runtime.manifest.validation.checks.map((c) => (
                  <li key={c.id}>
                    <span className="check-list__status">{c.status}</span>
                    <div>
                      <b>{c.id}</b>
                      <span>{c.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
