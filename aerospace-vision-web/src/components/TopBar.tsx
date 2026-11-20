import { useAppStore } from "../state/store";

export function TopBar() {
  const runtime = useAppStore((s) => s.runtime);
  const presentation = useAppStore((s) => s.presentation);
  const setPresentation = useAppStore((s) => s.setPresentation);
  const quality = useAppStore((s) => s.quality);
  const setQuality = useAppStore((s) => s.setQuality);
  const hudVisible = useAppStore((s) => s.hudVisible);
  const setHudVisible = useAppStore((s) => s.setHudVisible);

  if (!runtime) return null;
  const checkCount = runtime.manifest.validation.checks.length;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand__mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="26" height="26">
            <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.55" />
            <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" transform="rotate(-28 16 16)" />
            <circle cx="16" cy="16" r="2.4" fill="currentColor" />
          </svg>
        </div>
        <div>
          <div className="brand__name">AEROSPACE VISION</div>
          <div className="brand__sub">Scientific trajectory visualisation · V1</div>
        </div>
      </div>

      <div className="topbar__scenario">
        <span className="topbar__id">{runtime.manifest.id.toUpperCase()}</span>
        <span className="topbar__title">{runtime.manifest.title}</span>
        <span className={`status-pill status-pill--${runtime.manifest.validation.status === "PASS" ? "ok" : "bad"}`}>
          <span className="status-pill__dot" />
          TELEMETRY VERIFIED · {checkCount} CHECKS
        </span>
      </div>

      <div className="topbar__actions">
        <div className="segmented" role="group" aria-label="Presentation mode">
          <button
            type="button"
            className={presentation === "scientific" ? "is-active" : ""}
            onClick={() => setPresentation("scientific")}
          >
            Scientific
          </button>
          <button
            type="button"
            className={presentation === "cinematic" ? "is-active" : ""}
            onClick={() => setPresentation("cinematic")}
          >
            Cinematic
          </button>
        </div>

        <label className="quality-select" title="Render quality">
          <span>QUALITY</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as "high" | "medium" | "low")}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        <button
          type="button"
          className={`icon-button ${hudVisible ? "is-active" : ""}`}
          onClick={() => setHudVisible(!hudVisible)}
          title="Toggle interface"
        >
          {hudVisible ? "◱" : "◰"}
        </button>
      </div>
    </header>
  );
}
