import { useAppStore } from "../state/store";
import { shotAtWall, simToWall, wallToSim, CINEMATIC_WALL_S } from "../cinematic/shots";
import { useClockDisplay } from "./useDisplayState";
import { formatClock, formatTime } from "../utils/format";
import { useI18n } from "../i18n";

export function CinematicOverlay() {
  const runtime = useAppStore((s) => s.runtime);
  const setPresentation = useAppStore((s) => s.setPresentation);
  const seek = useAppStore((s) => s.seek);
  const toggle = useAppStore((s) => s.toggle);
  const playing = useAppStore((s) => s.playing);
  const time = useClockDisplay(100);
  const { t } = useI18n();
  if (!runtime) return null;

  const start = runtime.manifest.time.startS;
  const end = runtime.manifest.time.endS;
  const wall = simToWall(time, start, end);
  const shot = shotAtWall(wall);
  const progress = Math.min(100, Math.max(0, (wall / CINEMATIC_WALL_S) * 100));

  const skip = (deltaWall: number) => {
    const target = wallToSim(wall + deltaWall, start, end);
    seek(target);
  };

  return (
    <div className="cinematic">
      <div className="cinematic__bar cinematic__bar--top" />
      <div className="cinematic__bar cinematic__bar--bottom" />

      <div className="cinematic__brand">
        <span>{t("brand.latin")}</span>
        <b>{runtime.manifest.title}</b>
      </div>

      <div className="cinematic__controls">
        <button type="button" onClick={() => skip(-15)} title={t("cinematic.skipBack")}>−15s</button>
        <button type="button" className="cinematic__play" onClick={toggle} title={playing ? t("cinematic.pause") : t("cinematic.resume")}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" onClick={() => skip(15)} title={t("cinematic.skipForward")}>+15s</button>
        <button type="button" className="cinematic__exit" onClick={() => setPresentation("scientific")}>
          {t("cinematic.exit")} <span>ESC</span>
        </button>
      </div>

      <div className="cinematic__caption" key={shot.id}>
        <div className="cinematic__kicker">{formatClock(time)}</div>
        <h1>{t(shot.titleKey)}</h1>
        <p>{t(shot.captionKey)}</p>
      </div>

      <div className="cinematic__progress">
        <div style={{ width: `${progress}%` }} />
        <span className="cinematic__clock">
          {t("cinematic.elapsed")} {formatTime(wall)} / {formatTime(CINEMATIC_WALL_S)}
        </span>
      </div>
    </div>
  );
}
