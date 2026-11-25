import { useApp } from "../state";
import { useT } from "../i18n";
import { CINEMATIC_SECONDS } from "../scene/assets";
import {
  cycleDataRate,
  formatMissionTime,
  seekDataTime,
  toggleDataPlay,
} from "../data/telemetry";

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
  const telemetry = useApp((s) => s.telemetry);
  const dataTime = useApp((s) => s.dataTime);
  const dataPlaying = useApp((s) => s.dataPlaying);
  const dataRate = useApp((s) => s.dataRate);

  const dataMode = !!telemetry && mode !== "cinematic";

  const onPlay = () => {
    if (dataMode) {
      toggleDataPlay();
      return;
    }
    if (mode !== "cinematic") setMode("cinematic");
    setPlaying(!playing);
  };

  return (
    <div className="transport">
      <button
        type="button"
        className="transport__play"
        onClick={onPlay}
        title={(dataMode ? dataPlaying : playing) ? t("pause") : t("play")}
      >
        {(dataMode ? dataPlaying : playing) ? "❚❚" : "▶"}
      </button>
      <div className="transport__mid">
        <div className="transport__labels">
          <span>{dataMode ? t("flightTime") : t("shot")}</span>
          <b>{dataMode ? formatMissionTime(dataTime) : fmt(time)}</b>
          {dataMode && <em className="transport__rate">{dataRate}×</em>}
        </div>
        {dataMode ? (
          <div className="transport__track">
            <input
              type="range"
              min={telemetry.start}
              max={telemetry.end}
              step={0.05}
              value={dataTime}
              onChange={(e) => seekDataTime(Number(e.target.value))}
            />
            <div className="transport__events" aria-hidden>
              {telemetry.events.map((e) => (
                <span
                  key={e.id}
                  className={`transport__event transport__event--${e.severity}`}
                  style={{ left: `${((e.t - telemetry.start) / (telemetry.end - telemetry.start)) * 100}%` }}
                  title={e.label}
                />
              ))}
            </div>
          </div>
        ) : (
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
        )}
      </div>
      <div className="transport__right">
        {dataMode && (
          <button
            type="button"
            className="ghost-btn ghost-btn--sm"
            onClick={() => cycleDataRate()}
            title={t("rateHint")}
            aria-label={t("rateHint")}
          >
            {dataRate}×
          </button>
        )}
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
