import { useI18n } from "../i18n";
import { fmt } from "../utils/format";
import { useManifest } from "./useManifest";
import { CopyValue } from "./CopyValue";

function formatIsoCompact(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}{unit && <em>{unit}</em>}</strong>
    </div>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const { manifest } = useManifest();
  const m = manifest?.metrics;
  const isWorkspaceCommit = !manifest?.source.commit || manifest.source.commit === "workspace";
  const reproLabel =
    manifest?.experiment.reproducibility === "unreproducible-current-artifacts"
      ? t("common.repro.localSnapshot")
      : manifest?.experiment.reproducibility ?? "—";

  return (
    <>
      <section className="hero">
        <div className="hero__copy">
          <p className="kicker">{t("home.kicker")}</p>
          <h1>{t("home.title")}</h1>
          <p className="lede">{t("home.lede")}</p>
          <div className="hero__actions">
            <a className="btn btn--primary" href="#/explore">{t("home.cta.explore")}</a>
            <a className="btn btn--ghost" href="#/monitor">{t("home.cta.monitor")}</a>
            <a className="btn btn--ghost" href="#/results">{t("home.cta.results")}</a>
            <a className="btn btn--ghost" href="#/compare">{t("home.cta.compare")}</a>
          </div>
          {m && (
            <div className="stat-strip">
              <Stat label={t("home.stat.miss")} value={fmt(m.missDistanceM, 2)} unit=" m" />
              <Stat label={t("home.stat.apogee")} value={fmt(m.maxAltitudeM / 1000, 2)} unit=" km" />
              <Stat label={t("home.stat.downrange")} value={fmt(m.downrangeKM, 0)} unit=" km" />
              <Stat label={t("home.stat.mach")} value={fmt(m.maxMach, 2)} />
            </div>
          )}
        </div>
        <div className="hero__visual">
          <a className="hero-showcase" href="#/explore" aria-label={t("home.cta.explore")}>
            <img
              className="hero-showcase__img"
              src="./hero.jpg"
              alt={t("home.showcase.alt")}
              loading="eager"
            />
            <div className="hero-showcase__overlay">
              <div className="hero-showcase__badge">WGS84 · ECEF · 6DOF</div>
              <div className="hero-showcase__title">{manifest ? t("scenario.title") : "—"}</div>
              <div className="hero-showcase__meta">
                {manifest
                  ? `${manifest.time.sampleCount.toLocaleString()} / ${manifest.time.sourceRows.toLocaleString()} ${t("home.showcase.samples")}`
                  : t("common.explorerLoading")}
              </div>
            </div>
          </a>
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">{t("home.features.title")}</h2>
        <div className="feature-grid">
          {[
            ["frames", "01"],
            ["camera", "02"],
            ["sky", "03"],
            ["provenance", "04"],
          ].map(([key, idx]) => (
            <article className="feature" key={key}>
              <span className="feature__index">{idx}</span>
              <h3>{t(`home.features.${key}.title`)}</h3>
              <p>{t(`home.features.${key}.body`)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section split">
        <div className="highlight-card">
          <span className="tag tag--ok">{t("home.highlight.tag")}</span>
          <h2>{t("home.highlight.title")}</h2>
          <p>{t("home.highlight.body")}</p>
          <div className="highlight-card__links">
            <a className="link-arrow" href="#/results">{t("home.highlight.resultsLink")} →</a>
            <a className="link-arrow" href="#/verification">{t("home.highlight.verifyLink")} →</a>
          </div>
        </div>
        <div className="snapshot-card">
          <h2>{t("home.version.title")}</h2>
          <p>{t("home.version.body")}</p>
          {manifest && (
            <dl className="kv">
              <div><dt>{t("common.schema")}</dt><dd>v{manifest.schemaVersion}</dd></div>
              <div><dt>{t("common.dataVersion")}</dt><dd>{manifest.id}</dd></div>
              <div>
                <dt>{t("common.sourceCommit")}</dt>
                <dd>
                  {isWorkspaceCommit ? (
                    <span>{t("common.commit.workspace")}</span>
                  ) : (
                    <CopyValue value={manifest.source.commit} />
                  )}
                </dd>
              </div>
              <div><dt>{t("common.stamp")}</dt><dd>{formatIsoCompact(manifest.source.generatedAt)}</dd></div>
              <div><dt>{t("mission.repro")}</dt><dd>{reproLabel}</dd></div>
              <div><dt>{t("mission.demoUtc")}</dt><dd>{formatIsoCompact(manifest.time.demoUtc)}</dd></div>
            </dl>
          )}
        </div>
      </section>
    </>
  );
}
