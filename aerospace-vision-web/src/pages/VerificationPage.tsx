import { useI18n } from "../i18n";
import { useManifest } from "./useManifest";

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
        <h2 className="section__title">{t("verify.runtime.title")}</h2>
        <p className="section__lede">{t("verify.runtime.body")}</p>
        {manifest && (
          <div className="check-table">
            <div className="check-table__head">
              <span>STATUS</span>
              <span>ID</span>
              <span>DESCRIPTION / DETAIL</span>
            </div>
            {manifest.validation.checks.map((c) => (
              <div className="check-row" key={c.id}>
                <span className={`badge ${c.status === "PASS" ? "badge--ok" : "badge--bad"}`}>{c.status}</span>
                <code>{c.id}</code>
                <div>
                  <b>{c.description}</b>
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
        <section className="prose-card prose-card--warn">
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
