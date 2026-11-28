import { useAppStore, type CameraMode } from "../state/store";
import { CAMERA_MODES } from "../state/cameraModes";
import { useI18n } from "../i18n";

export function CameraDock() {
  const cameraMode = useAppStore((s) => s.cameraMode);
  const setCameraMode = useAppStore((s) => s.setCameraMode);
  const trackEmphasis = useAppStore((s) => s.trackEmphasis);
  const toggleTrackEmphasis = useAppStore((s) => s.toggleTrackEmphasis);
  const xrayMode = useAppStore((s) => s.xrayMode);
  const toggleXrayMode = useAppStore((s) => s.toggleXrayMode);
  const { t } = useI18n();

  return (
    <div className="camera-dock" role="group" aria-label={t("camera.label")}>
      <span className="camera-dock__label">{t("camera.label")}</span>
      {CAMERA_MODES.map((m, i) => (
        <button
          key={m}
          type="button"
          data-camera={m}
          className={cameraMode === m ? "is-active" : ""}
          aria-pressed={cameraMode === m}
          onClick={() => setCameraMode(m as CameraMode)}
          title={`${t(`camera.${m}Hint`)} · ${i + 1}`}
        >
          {t(`camera.${m}`)}
        </button>
      ))}
      <span className="camera-dock__divider" />
      <button
        type="button"
        className={trackEmphasis ? "is-active" : ""}
        aria-pressed={trackEmphasis}
        onClick={toggleTrackEmphasis}
        title={t("camera.trackHint")}
      >
        {t("camera.track")}
      </button>
      <button
        type="button"
        className={xrayMode ? "is-active" : ""}
        aria-pressed={xrayMode}
        onClick={toggleXrayMode}
        title={t("camera.xrayHint")}
      >
        ✦ {t("camera.xray")}
      </button>
    </div>
  );
}
