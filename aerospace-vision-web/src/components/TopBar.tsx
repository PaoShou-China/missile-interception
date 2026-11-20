import { useAppStore } from "../state/store";
import { useI18n } from "../i18n";
import { LangSwitch } from "../pages/Layout";

export function TopBar() {
  const runtime = useAppStore((s) => s.runtime);
  const presentation = useAppStore((s) => s.presentation);
  const setPresentation = useAppStore((s) => s.setPresentation);
  const quality = useAppStore((s) => s.quality);
  const setQuality = useAppStore((s) => s.setQuality);
  const hudVisible = useAppStore((s) => s.hudVisible);
  const setHudVisible = useAppStore((s) => s.setHudVisible);
  const { t } = useI18n();

  if (!runtime) return null;
  const checkCount = runtime.manifest.validation.checks.length;

  return (
    <header className="topbar">
      <a className="brand brand--link" href="#/" title={t("explore.back")}>
        <div className="brand__mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="26" height="26">
            <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.55" />
            <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" transform="rotate(-28 16 16)" />
            <circle cx="16" cy="16" r="2.4" fill="currentColor" />
          </svg>
        </div>
        <div>
          <div className="brand__name">{t("brand.latin")}</div>
          <div className="brand__sub">{t("brand.tagline")}</div>
        </div>
      </a>

      <div className="topbar__scenario">
        <span className="topbar__id">{runtime.manifest.id.toUpperCase()}</span>
        <span className="topbar__title">{runtime.manifest.title}</span>
        <span className={`status-pill status-pill--${runtime.manifest.validation.status === "PASS" ? "ok" : "bad"}`}>
          <span className="status-pill__dot" />
          {t("topbar.verified")} · {checkCount} {t("topbar.checks")}
        </span>
      </div>

      <div className="topbar__actions">
        <div className="segmented" role="group" aria-label="Presentation mode">
          <button
            type="button"
            className={presentation === "scientific" ? "is-active" : ""}
            aria-pressed={presentation === "scientific"}
            onClick={() => setPresentation("scientific")}
          >
            {t("topbar.scientific")}
          </button>
          <button
            type="button"
            className={presentation === "cinematic" ? "is-active" : ""}
            aria-pressed={presentation === "cinematic"}
            onClick={() => setPresentation("cinematic")}
          >
            {t("topbar.cinematic")}
          </button>
        </div>

        <label className="quality-select" title={t("topbar.quality")}>
          <span>{t("topbar.quality")}</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as "high" | "medium" | "low")}>
            <option value="high">{t("topbar.high")}</option>
            <option value="medium">{t("topbar.medium")}</option>
            <option value="low">{t("topbar.low")}</option>
          </select>
        </label>

        <LangSwitch />

        <button
          type="button"
          className={`icon-button ${hudVisible ? "is-active" : ""}`}
          aria-pressed={hudVisible}
          onClick={() => setHudVisible(!hudVisible)}
          title={t("topbar.toggleUi")}
        >
          {hudVisible ? "◱" : "◰"}
        </button>
      </div>
    </header>
  );
}
