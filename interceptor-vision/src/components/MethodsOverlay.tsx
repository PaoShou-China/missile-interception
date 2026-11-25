import { Fragment, useState } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";

interface Check {
  id: string;
  description: string;
  status: string;
  detail: string;
}

interface Manifest {
  title?: string;
  subtitle?: string;
  description?: string;
  source?: Record<string, string | number>;
  experiment?: Record<string, unknown> & { notes?: string[]; dispersion?: Record<string, string | number> };
  validation?: { status?: string; checks?: Check[] };
  observables?: { key: string; label: string; unit: string; description: string }[];
  metrics?: Record<string, number | null>;
  time?: Record<string, number | string>;
}

/** Provenance sheet: what the numbers are, how they were checked, what is faked. */
export function MethodsOverlay() {
  const t = useT();
  const telemetry = useApp((s) => s.telemetry);
  const close = () => useApp.getState().setMethodsOpen(false);
  const [copied, setCopied] = useState(false);
  const manifest = (telemetry?.manifest ?? {}) as Manifest;

  const copyLink = async () => {
    const state = useApp.getState();
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("t", String(Math.round(state.dataTime)));
    url.searchParams.set("view", state.cameraMode);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt(t("mCopyLink"), url.toString());
    }
  };

  const checks = manifest.validation?.checks ?? [];
  const passed = checks.filter((c) => c.status === "PASS").length;
  const source = manifest.source ?? {};
  const experiment = manifest.experiment ?? {};
  const dispersion = (experiment.dispersion ?? {}) as Record<string, string | number>;
  const metrics = manifest.metrics ?? {};
  const observables = manifest.observables ?? [];

  return (
    <div className="charts-overlay methods-overlay" role="dialog" aria-modal="true">
      <header className="charts-overlay__head">
        <div>
          <h2>{t("methods")}</h2>
          <p>{t("methodsSub")}</p>
        </div>
        <div className="charts-overlay__actions">
          <button type="button" className="ghost-btn ghost-btn--sm" onClick={copyLink}>
            {copied ? t("mCopied") : t("mCopyLink")}
          </button>
          <button type="button" className="icon-button" onClick={close} title={t("close")}>
            ✕
          </button>
        </div>
      </header>

      <div className="methods-body">
        <section className="method-card">
          <h3>{t("mSource")}</h3>
          <dl className="kv kv--compact">
            <dt>repository</dt>
            <dd>{String(source.repository ?? "—")}</dd>
            <dt>commit</dt>
            <dd>{String(source.commit ?? "—")}</dd>
            <dt>telemetry</dt>
            <dd>{String(source.telemetryFile ?? "—")}</dd>
            <dt>rows</dt>
            <dd>{String(source.telemetryRows ?? "—")}</dd>
            <dt>generated</dt>
            <dd>{String(source.generatedAt ?? "—")}</dd>
            <dt>sha256</dt>
            <dd className="mono-trunc" title={String(source.sha256 ?? "")}>
              {String(source.sha256 ?? "—").slice(0, 24)}…
            </dd>
          </dl>
        </section>

        <section className="method-card">
          <h3>{t("mExperiment")}</h3>
          <dl className="kv kv--compact">
            <dt>name</dt>
            <dd>{String(experiment.name ?? "—")}</dd>
            <dt>engine</dt>
            <dd>{String(experiment.engine ?? "—")}</dd>
            <dt>rate</dt>
            <dd>{experiment.dtS ? `${Number(experiment.dtS) * 1000} ms` : "—"}</dd>
            <dt>samples</dt>
            <dd>{String(manifest.time?.sampleCount ?? telemetry?.samples.length ?? "—")}</dd>
            <dt>demo UTC</dt>
            <dd>{String(manifest.time?.demoUtc ?? telemetry?.demoUtc ?? "—")}</dd>
          </dl>
        </section>

        <section className="method-card">
          <h3>
            {t("mValidation")} · {passed}/{checks.length} PASS
          </h3>
          <ul className="check-list">
            {checks.map((c) => (
              <li key={c.id}>
                <span className={`chip ${c.status === "PASS" ? "chip--pass" : "chip--warn"}`}>{c.status}</span>
                <div>
                  <b>{c.id}</b>
                  <span>{c.detail}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="method-card">
          <h3>{t("mRepro")}</h3>
          <p className={`method-flag ${String(experiment.reproducibility).startsWith("unreproducible") ? "is-warn" : ""}`}>
            {String(experiment.reproducibility ?? "—")}
          </p>
          <ul className="method-notes">
            {(experiment.notes ?? []).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <h3 className="mt">{t("mMetrics")}</h3>
          <dl className="kv kv--compact">
            {Object.entries(metrics).map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{typeof v === "number" ? v : "—"}</dd>
              </Fragment>
            ))}
          </dl>
        </section>

        <section className="method-card method-card--wide">
          <h3>{t("mObservables")}</h3>
          <table className="obs-table">
            <thead>
              <tr>
                <th>key</th>
                <th>label</th>
                <th>unit</th>
                <th>definition</th>
              </tr>
            </thead>
            <tbody>
              {observables.map((o) => (
                <tr key={o.key}>
                  <td className="mono">{o.key}</td>
                  <td>{o.label}</td>
                  <td className="mono">{o.unit}</td>
                  <td>{o.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="method-card method-card--wide">
          <h3>{t("mLimits")}</h3>
          <ul className="method-notes">
            <li>
              Trajectory and target geometry are projected into a local East / Up / South frame with fixed
              degree-to-metre factors and a parabolic Earth drop (Δy = r²/2R). At the 1655 km downrange of this
              case that is a few kilometres of lateral approximation — good for visualisation, not for survey-grade
              positioning.
            </li>
            <li>
              Airframe attitude is the recorded BODY→ECEF quaternion re-expressed in that local frame. The 3D model is
              a Blender reconstruction referenced to public SM-3 Block IB/IIA views; dimensions and surfaces are
              illustrative and do not represent hardware.
            </li>
            <li>
              Satellite ground imagery is streamed as Web-Mercator tiles (Esri World Imagery by default, Google as a
              fallback) at ~305 m/px for the 626 km tile block; anything beyond ~235 km is a procedural stand-in.
              Imagery © Esri / Google.
            </li>
            <li>
              Dispersion values below are configuration inputs from the source project. This payload is the nominal
              deterministic shot, not a Monte-Carlo sample, and no uncertainty envelope is rendered.
            </li>
          </ul>
          <dl className="kv kv--compact">
            {Object.entries(dispersion).map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
