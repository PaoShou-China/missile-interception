import { useI18n } from "../i18n";
import { useManifest } from "./useManifest";
import { CopyValue } from "./CopyValue";

const SECTIONS = ["flow", "frames", "units", "assets", "cinematic", "astronomy"];

export function MethodologyPage() {
  const { t } = useI18n();
  const { manifest } = useManifest();

  return (
    <article className="page">
      <header className="page-head">
        <p className="kicker">02 · METHOD</p>
        <h1>{t("method.title")}</h1>
        <p className="lede">{t("method.lede")}</p>
      </header>

      <section className="section">
        <h2 className="section__title">{t("method.flow.title")}</h2>
        <ol className="flow">
          {[1, 2, 3, 4].map((n) => (
            <li key={n}>
              <span className="flow__index">{String(n).padStart(2, "0")}</span>
              <p>{t(`method.flow.step${n}`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <div className="prose-grid">
        {SECTIONS.slice(1).map((s) => (
          <section className="prose-card" key={s}>
            <h3>{t(`method.${s}.title`)}</h3>
            <p>{t(`method.${s}.body`)}</p>
          </section>
        ))}
      </div>

      {manifest && (
        <section className="section">
          <h2 className="section__title">{t("mission.provenance")}</h2>
          <dl className="kv kv--grid">
            <div><dt>{t("mission.source")}</dt><dd>{manifest.source.telemetryFile}</dd></div>
            <div><dt>SHA-256</dt><dd><CopyValue value={manifest.source.sha256 ?? "—"} /></dd></div>
            <div><dt>{t("common.sourceCommit")}</dt><dd><CopyValue value={manifest.source.commit} /></dd></div>
            <div><dt>{t("common.stamp")}</dt><dd>{manifest.source.generatedAt}</dd></div>
            <div><dt>{t("mission.samples")}</dt><dd>{manifest.time.sourceRows} rows → {manifest.time.sampleCount} samples</dd></div>
            <div><dt>{t("mission.demoUtc")}</dt><dd>{manifest.time.demoUtc}</dd></div>
          </dl>
        </section>
      )}
    </article>
  );
}
