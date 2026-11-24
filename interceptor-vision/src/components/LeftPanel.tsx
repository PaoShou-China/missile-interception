import { useApp, type CameraMode, type Livery, type TimeOfDay } from "../state";
import { useT } from "../i18n";
import { LIVERY } from "../scene/assets";

const TIMES: { key: TimeOfDay; label: "day" | "dusk" | "night" }[] = [
  { key: "day", label: "day" },
  { key: "dusk", label: "dusk" },
  { key: "night", label: "night" },
];

const VIEWS: { key: CameraMode; label: "macro" | "meso" | "micro" | "cinematic" | "free" }[] = [
  { key: "macro", label: "macro" },
  { key: "meso", label: "meso" },
  { key: "micro", label: "micro" },
  { key: "cinematic", label: "cinematic" },
  { key: "free", label: "free" },
];

const FINISHES: { key: Livery; label: "finishSky" | "finishSunrise" | "finishArctic" }[] = [
  { key: "sky", label: "finishSky" },
  { key: "sunrise", label: "finishSunrise" },
  { key: "arctic", label: "finishArctic" },
];

export function LeftPanel() {
  const t = useT();
  const open = useApp((s) => s.leftOpen);
  const toggle = useApp((s) => s.toggleLeft);
  const timeOfDay = useApp((s) => s.timeOfDay);
  const setTimeOfDay = useApp((s) => s.setTimeOfDay);
  const cameraMode = useApp((s) => s.cameraMode);
  const setCameraMode = useApp((s) => s.setCameraMode);
  const livery = useApp((s) => s.livery);
  const setLivery = useApp((s) => s.setLivery);
  const cloudDensity = useApp((s) => s.cloudDensity);
  const setCloudDensity = useApp((s) => s.setCloudDensity);

  return (
    <>
      <aside className={`rail rail--left ${open ? "" : "is-collapsed"}`}>
        <div className="panel-head">
          <span>{t("scene")}</span>
          <button type="button" className="panel-collapse" onClick={toggle} aria-label={t("hideUi")}>
            ‹
          </button>
        </div>

        <section className="group">
          <h3>{t("time")}</h3>
          <div className="chip-row">
            {TIMES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`chip ${timeOfDay === item.key ? "is-active" : ""}`}
                onClick={() => setTimeOfDay(item.key)}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        </section>

        <section className="group">
          <h3>{t("view")}</h3>
          <div className="view-grid">
            {VIEWS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`view-btn ${cameraMode === item.key ? "is-active" : ""}`}
                onClick={() => setCameraMode(item.key)}
              >
                <span className={`view-btn__icon view-btn__icon--${item.key}`} aria-hidden />
                {t(item.label)}
              </button>
            ))}
          </div>
        </section>

        <section className="group">
          <h3>{t("finish")}</h3>
          <div className="swatch-row">
            {FINISHES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`swatch ${livery === item.key ? "is-active" : ""}`}
                title={t(item.label)}
                onClick={() => setLivery(item.key)}
              >
                <span
                  className="swatch__dot"
                  style={{
                    background: `linear-gradient(135deg, ${LIVERY[item.key].paint} 55%, ${LIVERY[item.key].accent} 55%)`,
                  }}
                />
                <span>{t(item.label)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="group">
          <h3>{t("clouds")}</h3>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={cloudDensity}
            onChange={(e) => setCloudDensity(Number(e.target.value))}
          />
          <div className="readout">{Math.round(cloudDensity * 100)}%</div>
        </section>

        <div className="panel-note">
          <span className="panel-note__dot" />
          GLB · DRACO-ready · LOD × 3
        </div>
      </aside>

      {!open && (
        <button type="button" className="rail-handle rail-handle--left" onClick={toggle} title={t("scene")}>
          {t("scene")}
        </button>
      )}
    </>
  );
}
