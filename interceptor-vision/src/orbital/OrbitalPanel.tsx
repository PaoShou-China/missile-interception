import { useT } from "../i18n";
import { useAppStore as useOrbitalStore } from "./state/store";
import { CAMERA_MODES } from "./state/cameraModes";
import { resetCameraInput } from "./scene/cameraInput";
import { useApp } from "../state";

const LABELS = {
  earth: "orbitalEarth",
  chase: "orbitalChase",
  target: "orbitalTarget",
  closeup: "orbitalCloseup",
} as const;

export function OrbitalPanel() {
  const t = useT();
  const mode = useOrbitalStore((s) => s.cameraMode);
  const setMode = useOrbitalStore((s) => s.setCameraMode);
  const presentation = useOrbitalStore((s) => s.presentation);
  const setPresentation = useOrbitalStore((s) => s.setPresentation);
  const track = useOrbitalStore((s) => s.trackEmphasis);
  const toggleTrack = useOrbitalStore((s) => s.toggleTrackEmphasis);

  const beginFilm = () => {
    useApp.getState().setDataPlaying(false);
    setPresentation("cinematic");
  };

  return (
    <>
      <section className="group">
        <h3>{t("orbitalCamera")}</h3>
        <div className="view-grid">
          {CAMERA_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`view-btn ${mode === m ? "is-active" : ""}`}
              onClick={() => setMode(m)}
            >
              {t(LABELS[m])}
            </button>
          ))}
        </div>
        <p className="hint">{t("orbitalHint")}</p>
      </section>

      <section className="group">
        <h3>{t("orbitalControls")}</h3>
        <div className="chip-row">
          <button
            type="button"
            className={`chip ${track ? "is-active" : ""}`}
            onClick={() => toggleTrack()}
          >
            {t("orbitalTrack")}
          </button>
          <button type="button" className="chip" onClick={() => resetCameraInput()}>
            {t("reset")}
          </button>
        </div>
        <button
          type="button"
          className="ghost-btn"
          onClick={beginFilm}
          disabled={presentation === "cinematic"}
        >
          {t("cinematicStart")}
        </button>
      </section>
    </>
  );
}
