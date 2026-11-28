import { useApp } from "../state";
import { useT } from "../i18n";

export function TopBar() {
  const t = useT();
  const quality = useApp((s) => s.quality);
  const setQuality = useApp((s) => s.setQuality);
  const galleryOpen = useApp((s) => s.galleryOpen);
  const setGalleryOpen = useApp((s) => s.setGalleryOpen);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const toggleLeft = useApp((s) => s.toggleLeft);
  const toggleRight = useApp((s) => s.toggleRight);
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const chartsOpen = useApp((s) => s.chartsOpen);
  const setChartsOpen = useApp((s) => s.setChartsOpen);
  const seekerOpen = useApp((s) => s.seekerOpen);
  const setSeekerOpen = useApp((s) => s.setSeekerOpen);
  const xrayOpen = useApp((s) => s.xrayOpen);
  const setXrayOpen = useApp((s) => s.setXrayOpen);
  const hudSpace = useApp((s) => s.hudSpace);
  const hudRadar = useApp((s) => s.hudRadar);
  const hudIr = useApp((s) => s.hudIr);
  const hudCharts = useApp((s) => s.hudCharts);
  const setHudSpace = useApp((s) => s.setHudSpace);
  const setHudRadar = useApp((s) => s.setHudRadar);
  const setHudIr = useApp((s) => s.setHudIr);
  const setHudCharts = useApp((s) => s.setHudCharts);
  const toggleCommandDeck = useApp((s) => s.toggleCommandDeck);
  const setMethodsOpen = useApp((s) => s.setMethodsOpen);
  const compact = useApp((s) => s.compact);

  const uiVisible = leftOpen || rightOpen;
  const deckAllOpen = hudSpace && hudRadar && hudIr && hudCharts;
  const chartsActive = hudCharts || chartsOpen;
  const fromSite = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("from") === "site";

  const onToggleCharts = () => {
    if (chartsOpen) {
      setChartsOpen(false);
    } else {
      setHudCharts(!hudCharts);
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand__mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="26" height="26">
            <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.5" />
            <path d="M4 22 L16 6 L28 22" fill="none" stroke="currentColor" strokeWidth="1.15" opacity="0.85" />
            <circle cx="16" cy="6" r="2.1" fill="currentColor" />
          </svg>
        </div>
        <div>
          <div className="brand__name">{t("brandLatin")}</div>
          <div className="brand__sub">{t("tagline")}</div>
        </div>
      </div>

      <div className="topbar__actions">
        {fromSite && (
          <a className="topbar__back" href="../">
            {t("backToSite")}
          </a>
        )}
        <div className="segmented" role="group" aria-label="Presentation">
          <button
            type="button"
            className={galleryOpen ? "" : "is-active"}
            onClick={() => setGalleryOpen(false)}
          >
            {t("realtime")}
          </button>
          <button type="button" className={galleryOpen ? "is-active" : ""} onClick={() => setGalleryOpen(true)}>
            {t("gallery")}
          </button>
        </div>

        <label className="field field--inline">
          <span>{t("quality")}</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
            <option value="performance">{t("qualityPerformance")}</option>
            <option value="balanced">{t("qualityBalanced")}</option>
            <option value="cinematic">{t("qualityCinematic")}</option>
          </select>
        </label>

        <div className="topbar__hud-group" role="group" aria-label={t("hudDeck")}>
          <button
            type="button"
            className={`ghost-btn ghost-btn--sm topbar__hud-btn ${hudSpace ? "is-active" : ""}`}
            title={t("hudSpaceHint")}
            onClick={() => setHudSpace(!hudSpace)}
          >
            🛰 <span className="topbar__hud-label">{t("hudSpace")}</span>
          </button>
          <button
            type="button"
            className={`ghost-btn ghost-btn--sm topbar__hud-btn ${hudRadar ? "is-active" : ""}`}
            title={t("hudRadarHint")}
            onClick={() => setHudRadar(!hudRadar)}
          >
            📡 <span className="topbar__hud-label">{t("hudRadar")}</span>
          </button>
          <button
            type="button"
            className={`ghost-btn ghost-btn--sm topbar__hud-btn ${hudIr ? "is-active" : ""}`}
            title={t("hudIrHint")}
            onClick={() => setHudIr(!hudIr)}
          >
            🔥 <span className="topbar__hud-label">{t("hudIr")}</span>
          </button>
          <button
            type="button"
            className={`ghost-btn ghost-btn--sm topbar__hud-btn topbar__charts-btn ${chartsActive ? "is-active" : ""}`}
            title={t("hudChartsHint")}
            onClick={onToggleCharts}
          >
            📈 <span className="topbar__hud-label">{t("hudCharts")}</span>
          </button>
          <button
            type="button"
            className={`ghost-btn ghost-btn--sm topbar__deck-btn ${deckAllOpen ? "is-active" : ""}`}
            title={t("hudDeckHint")}
            onClick={toggleCommandDeck}
          >
            ⊞ <span className="topbar__hud-label">{t("hudDeck")}</span>
          </button>
        </div>

        <button
          type="button"
          className={`ghost-btn ghost-btn--sm topbar__xray-btn ${xrayOpen ? "is-active" : ""}`}
          title={t("xrayHint")}
          onClick={() => setXrayOpen(!xrayOpen)}
        >
          ✦ {t("xrayBtn")}
        </button>
        <button
          type="button"
          className={`ghost-btn ghost-btn--sm topbar__seeker-btn ${seekerOpen ? "is-active" : ""}`}
          title={t("seekerHint")}
          onClick={() => setSeekerOpen(!seekerOpen)}
        >
          ◎ {t("seekerBtn")}
        </button>
        <button type="button" className="icon-button" title={t("methods")} onClick={() => setMethodsOpen(true)}>
          ⓘ
        </button>
        <button type="button" className="icon-button" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
          {t("lang")}
        </button>
        <button
          type="button"
          className={`icon-button ${uiVisible ? "is-active" : ""}`}
          title={uiVisible ? t("hideUi") : t("showUi")}
          onClick={() => {
            if (compact) {
              if (uiVisible) useApp.setState({ leftOpen: false, rightOpen: false });
              else toggleLeft();
              return;
            }
            if (uiVisible) {
              if (leftOpen) toggleLeft();
              if (rightOpen) toggleRight();
            } else {
              toggleLeft();
              toggleRight();
            }
          }}
        >
          {uiVisible ? "◱" : "◰"}
        </button>
      </div>
    </header>
  );
}
