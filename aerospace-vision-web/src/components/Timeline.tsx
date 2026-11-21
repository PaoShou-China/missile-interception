import { useCallback, useRef } from "react";
import { useAppStore } from "../state/store";
import { formatClock, formatTime } from "../utils/format";
import { useI18n } from "../i18n";
import { eventLabel } from "../i18n/events";

const RATES = [0.5, 1, 5, 20, 60];

export function Timeline() {
  const runtime = useAppStore((s) => s.runtime);
  const time = useAppStore((s) => s.time);
  const start = useAppStore((s) => s.start);
  const end = useAppStore((s) => s.end);
  const rate = useAppStore((s) => s.rate);
  const playing = useAppStore((s) => s.playing);
  const toggle = useAppStore((s) => s.toggle);
  const setRate = useAppStore((s) => s.setRate);
  const seek = useAppStore((s) => s.seek);
  const seekFraction = useAppStore((s) => s.seekFraction);
  const step = useAppStore((s) => s.step);
  const reset = useAppStore((s) => s.reset);
  const { t } = useI18n();

  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const fractionFromEvent = useCallback((clientX: number) => {
    const el = barRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  if (!runtime) return null;
  const progress = end > start ? ((time - start) / (end - start)) * 100 : 0;

  return (
    <footer className="timeline">
      <div className="timeline__controls">
        <button type="button" className="transport" onClick={reset} title={t("timeline.reset")}>⟲</button>
        <button type="button" className="transport" onClick={() => step(-5)} title={t("timeline.back")}>−5s</button>
        <button
          type="button"
          className={`transport transport--play ${playing ? "is-playing" : ""}`}
          onClick={toggle}
          title={t("timeline.playPause")}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" className="transport" onClick={() => step(5)} title={t("timeline.forward")}>+5s</button>
        <div className="rate-group">
          {RATES.map((r) => (
            <button
              key={r}
              type="button"
              className={rate === r ? "is-active" : ""}
              onClick={() => setRate(r)}
              title={`${t("timeline.rate")} ${r}×`}
            >
              {r}×
            </button>
          ))}
        </div>
      </div>

      <div className="timeline__track-wrap">
        <div className="timeline__labels">
          <span className="timeline__now">{formatClock(time)}</span>
          <span className="timeline__phase">{t(`phase.${runtime.missileSampler.sampleAt(time).phase}`)}</span>
          <span className="timeline__total">{formatTime(end)}</span>
        </div>

        <div
          className="timeline__bar"
          ref={barRef}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            seekFraction(fractionFromEvent(e.clientX));
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekFraction(fractionFromEvent(e.clientX));
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
          }}
          onPointerCancel={() => { dragging.current = false; }}
          role="slider"
          aria-label={t("timeline.simulationTime")}
          aria-valuemin={start}
          aria-valuemax={end}
          aria-valuenow={time}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") seek(time - 5);
            if (e.key === "ArrowRight") seek(time + 5);
          }}
        >
          <div className="timeline__phases">
            {runtime.manifest.phases.map((p) => (
              <div
                key={p.phase}
                className={`timeline__phase-seg phase-seg--${p.phase}`}
                style={{
                  left: `${((p.startT - start) / (end - start)) * 100}%`,
                  width: `${((p.endT - p.startT) / (end - start)) * 100}%`,
                }}
              >
                <span>{t(`phase.${p.phase}`)}</span>
              </div>
            ))}
          </div>
          <div className="timeline__fill" style={{ width: `${progress}%` }} />
          {runtime.manifest.events.map((e) => (
            <button
              key={e.id}
              type="button"
              className={`timeline__event timeline__event--${e.severity}`}
              style={{ left: `${((e.t - start) / (end - start)) * 100}%` }}
              onClick={(ev) => { ev.stopPropagation(); seek(e.t); }}
              title={`${eventLabel(t, e.label)} · ${formatClock(e.t)}`}
              aria-label={`${t("timeline.seekTo")} ${eventLabel(t, e.label)}`}
            />
          ))}
          <div className="timeline__playhead" style={{ left: `${progress}%` }}>
            <span />
          </div>
        </div>
      </div>

      <div className="timeline__meta">
        <span className="data-source">{t("timeline.source")}</span>
        <span>{t("timeline.utcAgnostic")}</span>
      </div>
    </footer>
  );
}
