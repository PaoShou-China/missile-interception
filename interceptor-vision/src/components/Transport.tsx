import { useApp } from "../state";
import { useT } from "../i18n";
import { CINEMATIC_SECONDS } from "../scene/assets";

function fmt(t: number) {
  const s = Math.max(0, Math.min(CINEMATIC_SECONDS, t));
  return `00:${String(Math.floor(s)).padStart(2, "0")}.${String(Math.floor((s % 1) * 10))}`;
}

export function Transport() {
  const t = useT();
  const playing = useApp((s) => s.playing);
  const setPlaying = useApp((s) => s.setPlaying);
  const time = useApp((s) => s.time);
  const setTime = useApp((s) => s.setTime);
  const mode = useApp((s) => s.cameraMode);
  const setMode = useApp((s) => s.setCameraMode);
  const fps = useApp((s) => s.fps);
  const reset = useApp((s) => s.requestResetView);

  const onPlay = () => {
    if (mode !== "cinematic") setMode("cinematic");
    setPlaying(!playing);
  };

  return (
    <div className="transport">
      <button type="button" className="transport__play" onClick={onPlay} title={playing ? t("pause") : t("play")}>
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="transport__mid">
        <div className="transport__labels">
          <span>{t("shot")}</span>
          <b>{fmt(time)}</b>
        </div>
        <input
          type="range"
          min={0}
          max={CINEMATIC_SECONDS}
          step={0.02}
          value={time}
          onChange={(e) => {
            setMode("cinematic");
            setTime(Number(e.target.value));
          }}
        />
      </div>
      <div className="transport__right">
        <span className="fps">
          {t("fps")} <b>{fps}</b>
        </span>
        <button type="button" className="ghost-btn ghost-btn--sm" onClick={reset}>
          {t("reset")}
        </button>
      </div>
      <div className="transport__hint">{t("hint")}</div>
    </div>
  );
}
