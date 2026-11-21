import { useI18n } from "../i18n";
import { fmt } from "../utils/format";
import { useManifest } from "./useManifest";
import { CopyValue } from "./CopyValue";

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

  return (
    <>
      <section className="hero">
        <div className="hero__copy">
          <p className="kicker">{t("home.kicker")}</p>
          <h1>{t("home.title")}</h1>
          <p className="lede">{t("home.lede")}</p>
          <div className="hero__actions">
            <a className="btn btn--primary" href="#/explore">{t("home.cta.explore")}</a>
            <a className="btn btn--ghost" href="#/methodology">{t("home.cta.method")}</a>
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
        <div className="hero__visual" aria-hidden>
          <div className="orbit-card">
            <div className="orbit-card__rings">
              <span /><span /><span />
            </div>
            <div className="orbit-card__body">
              <div className="orbit-card__label">WGS84 · ECEF</div>
              <div className="orbit-card__value">{manifest ? t("scenario.title") : "—"}</div>
              <div className="orbit-card__meta">
                {manifest ? `${manifest.time.sampleCount} / ${manifest.time.sourceRows} rows` : "loading"}
              </div>
            </div>
          </div>
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
        <div className="audit-card">
          <span className="tag tag--warn">{t("common.legacyUnreproducible")}</span>
          <h2>{t("home.audit.title")}</h2>
          <p>{t("home.audit.body")}</p>
          <a className="link-arrow" href="#/verification">{t("home.audit.link")} →</a>
        </div>
        <div className="snapshot-card">
          <h2>{t("home.version.title")}</h2>
          <p>{t("home.version.body")}</p>
          {manifest && (
            <dl className="kv">
              <div><dt>{t("common.schema")}</dt><dd>v{manifest.schemaVersion}</dd></div>
              <div><dt>{t("common.dataVersion")}</dt><dd>{manifest.id}</dd></div>
              <div><dt>{t("common.sourceCommit")}</dt><dd><CopyValue value={manifest.source.commit} /></dd></div>
              <div><dt>{t("common.stamp")}</dt><dd>{manifest.source.generatedAt}</dd></div>
              <div><dt>{t("mission.repro")}</dt><dd>{manifest.experiment.reproducibility}</dd></div>
              <div><dt>{t("mission.demoUtc")}</dt><dd><CopyValue value={manifest.time.demoUtc} /></dd></div>
            </dl>
          )}
        </div>
      </section>
    </>
  );
}
