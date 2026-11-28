import { useCallback, useEffect, useRef, useState } from "react";
import { simClock, useAppStore } from "../state/store";
import { formatClock, formatTime } from "../utils/format";
import { useI18n } from "../i18n";
import { eventLabel } from "../i18n/events";

const RATES = [0.1, 0.5, 1, 5, 20, 60];

export function Timeline() {
  const runtime = useAppStore((s) => s.runtime);
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
  const [copied, setCopied] = useState(false);

  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const phaseRef = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);

  // Zero React re-renders during playback: drive playhead, progress fill & live
  // timecode directly via DOM refs from `simClock.time` (~30 Hz) + Zustand sub.
  useEffect(() => {
    if (!runtime) return;
    let raf = 0;
    let lastDraw = 0;
    let lastShown = -1;

    const paint = (curT: number) => {
      const span = end > start ? end - start : 1;
      const pct = Math.min(100, Math.max(0, ((curT - start) / span) * 100));
      if (fillRef.current) fillRef.current.style.width = `${pct}%`;
      if (headRef.current) headRef.current.style.left = `${pct}%`;
      if (barRef.current) barRef.current.setAttribute("aria-valuenow", curT.toFixed(2));
      if (clockRef.current) clockRef.current.textContent = formatClock(curT);
      if (phaseRef.current) {
        const ph = runtime.missileSampler.sampleAt(curT).phase;
        phaseRef.current.textContent = t(`phase.${ph}`);
      }
      lastShown = curT;
    };

    paint(simClock.time);
    const unsub = useAppStore.subscribe((st) => {
      if (Math.abs(st.time - lastShown) > 1e-4) paint(simClock.time);
    });
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastDraw < 33) return;
      if (Math.abs(simClock.time - lastShown) > 1e-4) {
        lastDraw = now;
        paint(simClock.time);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [runtime, start, end, t]);

  const jumpBulletTime = () => {
    const s = useAppStore.getState();
    s.setRate(0.1);
    s.seek(Math.max(s.start, s.end - 2.2));
    s.play();
  };

  const copyShareUrl = () => {
    const s = useAppStore.getState();
    const base = window.location.href.split("#")[0];
    const qs = new URLSearchParams();
    qs.set("t", simClock.time.toFixed(2));
    qs.set("view", s.cameraMode);
    qs.set("rate", String(s.rate));
    if (s.xrayMode) qs.set("xray", "1");
    const link = `${base}#/explore?${qs.toString()}`;
    void navigator.clipboard?.writeText(link).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const fractionFromEvent = useCallback((clientX: number) => {
    const el = barRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  if (!runtime) return null;
  const initT = simClock.time;
  const initProgress = end > start ? ((initT - start) / (end - start)) * 100 : 0;

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
          <span className="timeline__now" ref={clockRef}>{formatClock(initT)}</span>
          <span className="timeline__phase" ref={phaseRef}>{t(`phase.${runtime.missileSampler.sampleAt(initT).phase}`)}</span>
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
          aria-valuenow={initT}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") seek(simClock.time - 5);
            if (e.key === "ArrowRight") seek(simClock.time + 5);
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
          <div className="timeline__fill" ref={fillRef} style={{ width: `${initProgress}%` }} />
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
          <div className="timeline__playhead" ref={headRef} style={{ left: `${initProgress}%` }}>
            <span />
          </div>
        </div>
      </div>

      <div className="timeline__meta">
        <button type="button" className="transport" onClick={jumpBulletTime} title={t("timeline.bulletTimeHint")}>
          0.1× {t("timeline.bulletTime")}
        </button>
        <button type="button" className="transport" onClick={copyShareUrl} title={t("timeline.shareHint")}>
          {copied ? "✓" : "🔗"}
        </button>
        <span className="data-source">{t("timeline.source")}</span>
      </div>
    </footer>
  );
}
