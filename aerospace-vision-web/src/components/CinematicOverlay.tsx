import { useAppStore } from "../state/store";
import { shotAt } from "../cinematic/shots";
import { useClockDisplay } from "./useDisplayState";
import { formatClock } from "../utils/format";

export function CinematicOverlay() {
  const runtime = useAppStore((s) => s.runtime);
  const setPresentation = useAppStore((s) => s.setPresentation);
  const time = useClockDisplay(120);
  if (!runtime) return null;

  const shot = shotAt(time);
  const start = runtime.manifest.time.startS;
  const end = runtime.manifest.time.endS;
  const progress = Math.min(100, Math.max(0, ((time - start) / (end - start)) * 100));

  return (
    <div className="cinematic">
      <div className="cinematic__bar cinematic__bar--top" />
      <div className="cinematic__bar cinematic__bar--bottom" />

      <div className="cinematic__brand">
        <span>AEROSPACE VISION</span>
        <b>{runtime.manifest.title}</b>
      </div>

      <button type="button" className="cinematic__exit" onClick={() => setPresentation("scientific")}>
        EXIT CINEMATIC <span>ESC</span>
      </button>

      <div className="cinematic__caption" key={shot.id}>
        <div className="cinematic__kicker">{shot.kicker} · {formatClock(time).replace("T+", "")}</div>
        <h1>{shot.title}</h1>
        <p>{shot.caption}</p>
      </div>

      <div className="cinematic__progress">
        <div style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
