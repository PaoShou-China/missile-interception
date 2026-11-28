import { useApp, type CameraMode, type TimeOfDay } from "../state";
import { useT } from "../i18n";
import { MissionPanel } from "./MissionPanel";
import { SimPanel } from "./SimPanel";

const TIMES: { key: TimeOfDay; label: "day" | "dusk" | "night" }[] = [
  { key: "day", label: "day" },
  { key: "dusk", label: "dusk" },
  { key: "night", label: "night" },
];

const VIEWS: { key: CameraMode; label: "macro" | "chase" | "target" | "free" }[] = [
  { key: "macro", label: "macro" },
  { key: "chase", label: "chase" },
  { key: "target", label: "target" },
  { key: "free", label: "free" },
];

export function LeftPanel() {
  const t = useT();
  const open = useApp((s) => s.leftOpen);
  const toggle = useApp((s) => s.toggleLeft);
  const timeOfDay = useApp((s) => s.timeOfDay);
  const setTimeOfDay = useApp((s) => s.setTimeOfDay);
  const cameraMode = useApp((s) => s.cameraMode);
  const setCameraMode = useApp((s) => s.setCameraMode);
  const showTrajectory = useApp((s) => s.showTrajectory);
  const setShowTrajectory = useApp((s) => s.setShowTrajectory);

  return (
    <>
      <aside className={`rail rail--left ${open ? "" : "is-collapsed"}`}>
        <div className="panel-head">
          <span>{t("scene")}</span>
          <button type="button" className="panel-collapse" onClick={toggle} aria-label={t("hideUi")}>
            ‹
          </button>
        </div>

        <MissionPanel />

        <SimPanel />

        <>
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
          <h3>{t("overlay")}</h3>
          <button
            type="button"
            className={`switch ${showTrajectory ? "is-on" : ""}`}
            onClick={() => setShowTrajectory(!showTrajectory)}
            aria-pressed={showTrajectory}
          >
            <span className="switch__track">
              <span className="switch__thumb" />
            </span>
            <span>{showTrajectory ? "ON" : "OFF"}</span>
          </button>
        </section>
        </>
      </aside>

      {!open && (
        <button type="button" className="rail-handle rail-handle--left" onClick={toggle} title={`${t("scene")} · ${t("expand")}`}>
          {t("scene")}
        </button>
      )}
    </>
  );
}
