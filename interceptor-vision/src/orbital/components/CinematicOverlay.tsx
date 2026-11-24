import { useEffect, useState } from "react";
import { useAppStore } from "../state/store";
import { shotAtWall, simToWall, wallToSim, CINEMATIC_WALL_S } from "../cinematic/shots";
import { useClockDisplay } from "./useDisplayState";
import { formatClock, formatTime } from "../utils/format";
import { useT } from "../../i18n";

export function CinematicOverlay() {
  const runtime = useAppStore((s) => s.runtime);
  const setPresentation = useAppStore((s) => s.setPresentation);
  const seek = useAppStore((s) => s.seek);
  const toggle = useAppStore((s) => s.toggle);
  const playing = useAppStore((s) => s.playing);
  const time = useClockDisplay(100);
  const [fullscreen, setFullscreen] = useState(false);
  const t = useT() as (key: string) => string;

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  if (!runtime) return null;

  const phases = runtime.manifest.phases;
  const wall = simToWall(time, phases);
  const shot = shotAtWall(wall);
  const progress = Math.min(100, Math.max(0, (wall / CINEMATIC_WALL_S) * 100));

  const skip = (deltaWall: number) => {
    seek(wallToSim(wall + deltaWall, phases));
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Fullscreen can be denied; the film still plays inline.
    }
  };

  return (
    <div className="cinematic">
      <div className="cinematic__bar cinematic__bar--top" />
      <div className="cinematic__bar cinematic__bar--bottom" />

      <div className="cinematic__brand">
        <span>{t("brandLatin")}</span>
        <b>{t("scenario")}</b>
      </div>

      <div className="cinematic__controls">
        <button type="button" onClick={() => skip(-15)} title={t("cinematic.skipBack")} aria-label={t("cinematic.skipBack")}>
          « 15s
        </button>
        <button
          type="button"
          className="cinematic__play"
          onClick={toggle}
          title={playing ? t("cinematic.pause") : t("cinematic.resume")}
          aria-label={playing ? t("cinematic.pause") : t("cinematic.resume")}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" onClick={() => skip(15)} title={t("cinematic.skipForward")} aria-label={t("cinematic.skipForward")}>
          15s »
        </button>
        <button type="button" onClick={toggleFullscreen} title={t("cinematic.fullscreen")}>
          {fullscreen ? "⤡" : "⤢"} {t("cinematic.fullscreen")}
        </button>
        <button type="button" className="cinematic__exit" onClick={() => setPresentation("scientific")}>
          {t("cinematic.exit")} <span>ESC</span>
        </button>
      </div>

      <div className="cinematic__caption" key={shot.id}>
        <div className="cinematic__kicker">{formatClock(time)}</div>
        <h1>{t(shot.titleKey)}</h1>
        <p>{t(shot.captionKey)}</p>
      </div>

      <div
        className="cinematic__progress"
        role="slider"
        tabIndex={0}
        aria-label={t("cinematic.scrub")}
        aria-valuemin={0}
        aria-valuemax={CINEMATIC_WALL_S}
        aria-valuenow={Math.round(wall)}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          seek(wallToSim(f * CINEMATIC_WALL_S, phases));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") skip(-5);
          if (e.key === "ArrowRight") skip(5);
        }}
      >
        <div className="cinematic__progress-fill" style={{ width: `${progress}%` }} />
        <span className="cinematic__clock">
          {t("cinematic.elapsed")} {formatTime(wall)} / {formatTime(CINEMATIC_WALL_S)}
        </span>
      </div>
    </div>
  );
}
