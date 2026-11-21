import { useState } from "react";
import { useAppStore } from "../state/store";
import { fmt, formatClock } from "../utils/format";
import { useI18n } from "../i18n";
import { eventLabel } from "../i18n/events";

export function MissionPanel() {
  const runtime = useAppStore((s) => s.runtime);
  const seek = useAppStore((s) => s.seek);
  const time = useAppStore((s) => s.time);
  const panels = useAppStore((s) => s.panels);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const [showChecks, setShowChecks] = useState(false);
  const { t } = useI18n();

  if (!runtime) return null;
  const m = runtime.manifest.metrics;
  const open = panels.mission;

  return (
    <section className={`panel mission-panel ${open ? "" : "is-collapsed"}`}>
      <button type="button" className="panel__header" onClick={() => togglePanel("mission")}>
        <div>
          <span className="panel__eyebrow">{t("mission.eyebrow")}</span>
          <h2>{t("scenario.title")}</h2>
        </div>
        <span className="panel__chevron">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="panel__body">
          <p className="mission-panel__desc">{t("scenario.description")}</p>

          <div className="hero-metrics">
            <div>
              <span className="metric__label">{t("mission.intercept")}</span>
              <strong>{formatClock(m.interceptTimeS)}</strong>
            </div>
            <div>
              <span className="metric__label">{t("mission.miss")}</span>
              <strong>{fmt(m.missDistanceM, 1)}<em> m</em></strong>
            </div>
            <div>
              <span className="metric__label">{t("mission.peakMach")}</span>
              <strong>{fmt(m.maxMach, 2)}</strong>
            </div>
          </div>

          <dl className="metric-grid">
            <div><dt>{t("mission.maxSpeed")}</dt><dd>{fmt(m.maxSpeedMS / 1000, 3)} <em>km/s</em></dd></div>
            <div><dt>{t("mission.apogee")}</dt><dd>{fmt(m.maxAltitudeM / 1000, 2)} <em>km</em></dd></div>
            <div><dt>{t("mission.downrange")}</dt><dd>{fmt(m.downrangeKM, 1)} <em>km</em></dd></div>
            <div><dt>{t("mission.maxQ")}</dt><dd>{fmt(m.maxDynamicPressurePa / 1000, 1)} <em>kPa</em></dd></div>
            <div><dt>{t("mission.maxLoad")}</dt><dd>{fmt(m.maxLoadG, 2)} <em>g</em></dd></div>
            <div><dt>{t("mission.duration")}</dt><dd>{fmt(m.flightDurationS, 1)} <em>s</em></dd></div>
          </dl>

          <div className="phase-strip">
            {runtime.manifest.phases.map((p) => (
              <button
                key={p.phase}
                type="button"
                className={`phase-chip phase-chip--${p.phase} ${time >= p.startT && time <= p.endT ? "is-current" : ""}`}
                onClick={() => seek(p.startT)}
                title={`${t(`phase.${p.phase}`)}: ${formatClock(p.startT)} → ${formatClock(p.endT)}`}
              >
                {t(`phase.${p.phase}`)}
              </button>
            ))}
          </div>

          <div className="event-list">
            <div className="section-label">{t("mission.events")}</div>
            {runtime.manifest.events.map((e) => (
              <button
                type="button"
                key={e.id}
                className={`event-row event-row--${e.severity}`}
                onClick={() => seek(e.t)}
              >
                <span className="event-row__time">{formatClock(e.t)}</span>
                <span className="event-row__label">{eventLabel(t, e.label)}</span>
              </button>
            ))}
          </div>

          <div className="provenance">
            <div className="section-label">{t("mission.provenance")}</div>
            <div className="provenance__row"><span>{t("mission.source")}</span><b>{t("mission.sourceValue")}</b></div>
            <div className="provenance__row"><span>{t("mission.frame")}</span><b>{t("mission.frameValue")}</b></div>
            <div className="provenance__row"><span>{t("mission.samples")}</span><b>{runtime.manifest.time.sampleCount} / {runtime.manifest.time.sourceRows}</b></div>
            <div className="provenance__row"><span>{t("mission.schema")}</span><b>v{runtime.manifest.schemaVersion}</b></div>
            <div className="provenance__row"><span>{t("common.sourceCommit")}</span><b><code>{runtime.manifest.source.commit}</code></b></div>
            <div className="provenance__row"><span>{t("mission.demoUtc")}</span><b>{runtime.manifest.time.demoUtc}</b></div>
            <div className="provenance__row"><span>{t("mission.track")}</span><b>{t("mission.trackValue")}</b></div>
            <button
              type="button"
              className={`validation-toggle ${runtime.manifest.validation.status === "PASS" ? "is-ok" : "is-bad"}`}
              onClick={() => setShowChecks((v) => !v)}
            >
              <span className="status-pill__dot" />
              {runtime.manifest.validation.status === "PASS" ? t("mission.validationPass") : t("mission.validationFail")}
              <span className="validation-toggle__chevron">{showChecks ? "▾" : "▸"}</span>
            </button>
            {showChecks && (
              <ul className="check-list">
                {runtime.manifest.validation.checks.map((c) => (
                  <li key={c.id}>
                    <span className="check-list__status">{c.status === "PASS" ? t("common.pass") : t("common.fail")}</span>
                    <div>
                      <b>{t(`check.${c.id}.desc`)}</b>
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
