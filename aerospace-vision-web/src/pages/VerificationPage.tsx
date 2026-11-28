import { useI18n } from "../i18n";
import { useManifest } from "./useManifest";

const ENVELOPE_SUITES = [
  { id: "A", key: "verify.suite.A", pass: 4, total: 4, rate: 100.0, meanM: 6.50 },
  { id: "B", key: "verify.suite.B", pass: 7, total: 8, rate: 87.5, meanM: 8.64 },
  { id: "C", key: "verify.suite.C", pass: 9, total: 10, rate: 90.0, meanM: 7.34 },
  { id: "D", key: "verify.suite.D", pass: 8, total: 8, rate: 100.0, meanM: 5.15 },
  { id: "E", key: "verify.suite.E", pass: 9, total: 10, rate: 90.0, meanM: 9.80 },
  { id: "F", key: "verify.suite.F", pass: 7, total: 8, rate: 87.5, meanM: 8.83 },
];

export function VerificationPage() {
  const { t } = useI18n();
  const { manifest } = useManifest();

  return (
    <article className="page">
      <header className="page-head">
        <p className="kicker">04 · VERIFICATION</p>
        <h1>{t("verify.title")}</h1>
        <p className="lede">{t("verify.lede")}</p>
      </header>

      <section className="section">
        <h2 className="section__title">{t("verify.envelope.title")}</h2>
        <p className="section__lede">{t("verify.science.body")}</p>
        <div className="envelope-matrix">
          {ENVELOPE_SUITES.map((s) => (
            <div className="envelope-row" key={s.id}>
              <div className="envelope-row__label">
                <span className="envelope-row__id">{s.id}</span>
                <b>{t(s.key)}</b>
                <span className="envelope-row__meta">{s.pass}/{s.total} · {t("verify.suite.mean")} {s.meanM.toFixed(2)} m</span>
              </div>
              <div className="envelope-bar">
                <div className="envelope-bar__fill" style={{ width: `${s.rate}%` }} />
                <div className="envelope-bar__threshold" style={{ left: "80%" }} title="80% PASS threshold" />
              </div>
              <div className="envelope-row__score">
                <strong>{s.rate.toFixed(1)}%</strong>
                <span className="badge badge--ok">{t("common.pass")}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">{t("verify.runtime.title")}</h2>
        <p className="section__lede">{t("verify.runtime.body")}</p>
        {manifest && (
          <div className="check-table">
            <div className="check-table__head">
              <span>{t("verify.table.status")}</span>
              <span>{t("verify.table.id")}</span>
              <span>{t("verify.table.detail")}</span>
            </div>
            {manifest.validation.checks.map((c) => (
              <div className="check-row" key={c.id}>
                <span className={`badge ${c.status === "PASS" ? "badge--ok" : "badge--bad"}`}>
                  {c.status === "PASS" ? t("common.pass") : t("common.fail")}
                </span>
                <code>{c.id}</code>
                <div>
                  <b>{t(`check.${c.id}.desc`)}</b>
                  <span>{c.detail}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="prose-grid">
        <section className="prose-card">
          <h3>{t("verify.tests.title")}</h3>
          <p>{t("verify.tests.body")}</p>
        </section>
        <section className="prose-card">
          <h3>{t("verify.science.title")}</h3>
          <p>{t("verify.science.body")}</p>
        </section>
      </div>

      <section className="section">
        <h2 className="section__title">{t("verify.gaps.title")}</h2>
        <ul className="gap-list">
          {[1, 2, 3, 4, 5].map((n) => <li key={n}>{t(`verify.gaps.${n}`)}</li>)}
        </ul>
      </section>

      {manifest && (
        <section className="section">
          <h2 className="section__title">{t("home.version.title")}</h2>
          <dl className="kv kv--grid">
            <div><dt>{t("mission.repro")}</dt><dd>{manifest.experiment.reproducibility}</dd></div>
            <div><dt>{t("mission.source")}</dt><dd>{manifest.experiment.kind}</dd></div>
            <div><dt>{t("common.sourceCommit")}</dt><dd><code>{manifest.source.commit}</code></dd></div>
            <div><dt>Δt</dt><dd>{manifest.experiment.dtS} s</dd></div>
          </dl>
          {manifest.experiment.notes.map((n) => (
            <p className="callout callout--warn" key={n}>{n}</p>
          ))}
        </section>
      )}
    </article>
  );
}
