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
  const requestScreenshot = useApp((s) => s.requestScreenshot);
  const requestFullscreen = useApp((s) => s.requestFullscreen);
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const setChartsOpen = useApp((s) => s.setChartsOpen);
  const setMethodsOpen = useApp((s) => s.setMethodsOpen);
  const telemetry = useApp((s) => s.telemetry);
  const compact = useApp((s) => s.compact);

  const uiVisible = leftOpen || rightOpen;
  const fromSite = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("from") === "site";
  // Read the headline from the payload instead of hard-coding a class label:
  // the validated case is 1655 km downrange with a 29.9 km apogee.
  const downrange = telemetry?.metrics?.downrangeKM;
  const apogee = telemetry?.metrics?.maxAltitudeM;
  const scenarioTitle =
    typeof downrange === "number" && typeof apogee === "number"
      ? lang === "zh"
        ? `${Math.round(downrange)} km 下程 · 顶点 ${(apogee / 1000).toFixed(1)} km`
        : `${Math.round(downrange)} km downrange · ${(apogee / 1000).toFixed(1)} km apogee`
      : t("scenario");
  const scenarioId = typeof downrange === "number" ? `IV-${Math.round(downrange)}` : "IV-2000";

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

      <div className="topbar__scenario">
        <span className="topbar__id">{scenarioId}</span>
        <span className="topbar__title">{scenarioTitle}</span>
        <span className="status-pill status-pill--ok">
          <span className="status-pill__dot" />
          CYCLES · GLB · PBR
        </span>
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

        <button type="button" className="icon-button" title={t("methods")} onClick={() => setMethodsOpen(true)}>
          ⓘ
        </button>
        <button type="button" className="icon-button" title={t("charts")} onClick={() => setChartsOpen(true)}>
          ▤
        </button>
        <button type="button" className="icon-button" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
          {t("lang")}
        </button>
        <button type="button" className="icon-button" title={t("screenshot")} onClick={requestScreenshot}>
          ⛶
        </button>
        <button type="button" className="icon-button" title={t("fullscreen")} onClick={requestFullscreen}>
          ⤢
        </button>
        <button
          type="button"
          className={`icon-button ${uiVisible ? "is-active" : ""}`}
          title={uiVisible ? t("hideUi") : t("showUi")}
          onClick={() => {
            if (compact) {
              // One drawer at a time on phones; the handle is the way back.
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
