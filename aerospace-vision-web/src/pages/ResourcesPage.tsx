import { useI18n } from "../i18n";
import { useManifest } from "./useManifest";

const LEGACY = [
  { href: "./missile-intercept-overview/missile-intercept-overview.html", key: "resources.legacy.overview", stamp: "2026-11-13" },
  { href: "./intercept-report/intercept-report.html", key: "resources.legacy.intercept", stamp: "early run" },
  { href: "./test-report/missile_interceptor_test_report.html", key: "resources.legacy.test", stamp: "2026-11-13" },
  { href: "https://github.com/PaoShou-China/missile-interception/blob/main/TECHNICAL_REPORT.md", key: "resources.legacy.tech", stamp: "2026-11-13", external: true },
];

const DOCS = [
  { file: "DATA_AUDIT.md", key: "resources.docs.data" },
  { file: "RESULT_PROVENANCE.md", key: "resources.docs.provenance" },
  { file: "VALIDATION_STATUS.md", key: "resources.docs.validation" },
];

const DOC_BASE =
  "https://github.com/PaoShou-China/missile-interception/blob/main/aerospace-vision-web/docs/scientific/";

export function ResourcesPage() {
  const { t } = useI18n();
  const { manifest } = useManifest();

  return (
    <article className="page">
      <header className="page-head">
        <p className="kicker">05 · RESOURCES</p>
        <h1>{t("resources.title")}</h1>
        <p className="lede">{t("resources.lede")}</p>
      </header>

      <section className="section">
        <h2 className="section__title">{t("resources.legacy.title")}</h2>
        <p className="section__lede">{t("resources.legacy.body")}</p>
        <div className="link-cards">
          {LEGACY.map((l) => (
            <a
              className="link-card"
              key={l.key}
              href={l.href}
              target={l.external ? "_blank" : undefined}
              rel={l.external ? "noreferrer" : undefined}
            >
              <span className="tag tag--warn">{t("common.legacyUnreproducible")}</span>
              <b>{t(l.key)}</b>
              <span className="link-card__meta">{l.stamp}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">{t("resources.docs.title")}</h2>
        <div className="link-cards">
          {DOCS.map((d) => (
            <a className="link-card" key={d.file} href={`${DOC_BASE}${d.file}`} target="_blank" rel="noreferrer">
              <b>{t(d.key)}</b>
              <span className="link-card__meta">{d.file}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">{t("nav.compare")}</h2>
        <div className="link-cards">
          <a className="link-card" href="#/compare">
            <b>{t("compare.title")}</b>
            <span className="link-card__meta">{t("compare.kicker")}</span>
          </a>
          <a
            className="link-card"
            href="https://github.com/PaoShou-China/missile-interception/blob/main/aerospace-vision-web/docs/COMPARISON.md"
            target="_blank"
            rel="noreferrer"
          >
            <b>COMPARISON.md</b>
            <span className="link-card__meta">contract · matching · NOT RUN</span>
          </a>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">{t("resources.repo.title")}</h2>
        <div className="link-cards">
          <a className="link-card" href="https://github.com/PaoShou-China/missile-interception" target="_blank" rel="noreferrer">
            <b>{t("resources.repo.source")}</b>
            <span className="link-card__meta">PaoShou-China/missile-interception</span>
          </a>
          <a className="link-card" href="https://github.com/PaoShou-China/missile-interception/blob/main/missile_intercept/output/telemetry.csv" target="_blank" rel="noreferrer">
            <b>{t("resources.repo.telemetry")}</b>
            <span className="link-card__meta">missile_intercept/output/telemetry.csv</span>
          </a>
          <a className="link-card" href="https://github.com/PaoShou-China/missile-interception/blob/main/aerospace-vision-web/tools/data-adapter/build_scenario.py" target="_blank" rel="noreferrer">
            <b>{t("resources.repo.adapter")}</b>
            <span className="link-card__meta">tools/data-adapter/build_scenario.py</span>
          </a>
          <a className="link-card" href="./data/missile-intercept/scenario.json" target="_blank" rel="noreferrer">
            <b>{t("resources.repo.payload")}</b>
            <span className="link-card__meta">
              {manifest ? `v${manifest.schemaVersion} · ${manifest.time.sampleCount} samples` : "scenario.json"}
            </span>
          </a>
        </div>
      </section>

      <section className="section">
        <div className="audit-card">
          <h3>{t("home.audit.title")}</h3>
          <p>{t("home.audit.body")}</p>
          <a className="link-arrow" href="#/verification">{t("common.readAudit")} →</a>
        </div>
      </section>
    </article>
  );
}
