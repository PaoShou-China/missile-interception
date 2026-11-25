import { useApp } from "../state";
import { useT } from "../i18n";
import { SKY_PRESETS } from "../scene/assets";
import { TelemetryPanel } from "./TelemetryPanel";

export function RightPanel() {
  const t = useT();
  const open = useApp((s) => s.rightOpen);
  const toggle = useApp((s) => s.toggleRight);
  const haze = useApp((s) => s.haze);
  const setHaze = useApp((s) => s.setHaze);
  const exposure = useApp((s) => s.exposure);
  const setExposure = useApp((s) => s.setExposure);
  const shadows = useApp((s) => s.shadows);
  const setShadows = useApp((s) => s.setShadows);
  const quality = useApp((s) => s.quality);
  const requestReset = useApp((s) => s.requestResetView);
  const timeOfDay = useApp((s) => s.timeOfDay);
  const preset = SKY_PRESETS[timeOfDay];
  const sunElev = Math.round((Math.asin(preset.sunDir.y) * 180) / Math.PI);

  return (
    <>
      <aside className={`rail rail--right ${open ? "" : "is-collapsed"}`}>
        <div className="panel-head">
          <span>{t("environment")}</span>
          <button type="button" className="panel-collapse" onClick={toggle} aria-label={t("hideUi")}>
            ›
          </button>
        </div>

        <TelemetryPanel />

        <>
        <section className="group">
          <h3>{t("haze")}</h3>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={haze}
            onChange={(e) => setHaze(Number(e.target.value))}
          />
          <div className="readout">{Math.round(haze * 100)}%</div>
        </section>

        <section className="group">
          <h3>{t("exposure")}</h3>
          <input
            type="range"
            min={0.6}
            max={1.8}
            step={0.01}
            value={exposure}
            onChange={(e) => setExposure(Number(e.target.value))}
          />
          <div className="readout">{exposure.toFixed(2)}×</div>
        </section>

        <section className="group">
          <h3>{t("shadows")}</h3>
          <button
            type="button"
            className={`switch ${shadows ? "is-on" : ""}`}
            onClick={() => setShadows(!shadows)}
            aria-pressed={shadows}
          >
            <span className="switch__track">
              <span className="switch__thumb" />
            </span>
            <span>{shadows ? "ON" : "OFF"}</span>
          </button>
          {quality === "performance" && <p className="hint hint--warn">{t("qualityPerformance")}</p>}
        </section>

        <section className="group">
          <h3>{t("environment")}</h3>
          <dl className="kv">
            <dt>HDRI</dt>
            <dd>env-{timeOfDay}.hdr</dd>
            <dt>SUN</dt>
            <dd>{sunElev}°</dd>
            <dt>QUALITY</dt>
            <dd>{quality}</dd>
            <dt>LOD</dt>
            <dd>0 / 1 / 2</dd>
          </dl>
        </section>

        <button type="button" className="ghost-btn" onClick={requestReset}>
          {t("reset")}
        </button>
        </>
      </aside>

      {!open && (
        <button type="button" className="rail-handle rail-handle--right" onClick={toggle} title={t("environment")}>
          {t("environment")}
        </button>
      )}
    </>
  );
}
