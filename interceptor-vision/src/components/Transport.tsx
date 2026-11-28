import { useEffect, useRef, useState } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";
import { CINEMATIC_SECONDS } from "../scene/assets";
import {
  cycleDataRate,
  dataClock,
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
  const dataPlaying = useApp((s) => s.dataPlaying);
  const dataRate = useApp((s) => s.dataRate);
  const [copied, setCopied] = useState(false);

  const dataMode = !!telemetry && mode !== "cinematic";
  const sliderRef = useRef<HTMLInputElement>(null);
  const clockRef = useRef<HTMLElement>(null);
  const slowRef = useRef<HTMLSpanElement>(null);

  // Zero React re-renders during telemetry playback: update slider value, live
  // timecode & slow-mo indicator directly via DOM refs from `dataClock.t` (~25 Hz).
  useEffect(() => {
    if (!dataMode || !telemetry) return;
    let raf = 0;
    let lastDraw = 0;
    let lastShown = -1;

    const paint = (curT: number) => {
      if (sliderRef.current && document.activeElement !== sliderRef.current) {
        sliderRef.current.value = curT.toFixed(2);
      }
      if (clockRef.current) {
        clockRef.current.textContent = formatMissionTime(curT);
      }
      if (slowRef.current) {
        const st = useApp.getState();
        const showSlow = st.dataPlaying && telemetry.end - curT < 10 && st.dataRate > 1;
        slowRef.current.style.display = showSlow ? "" : "none";
      }
      lastShown = curT;
    };

    paint(dataClock.t);
    const unsub = useApp.subscribe((st) => {
      if (Math.abs(st.dataTime - lastShown) > 1e-4) paint(dataClock.t);
    });
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastDraw < 40) return;
      if (Math.abs(dataClock.t - lastShown) > 1e-4) {
        lastDraw = now;
        paint(dataClock.t);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [dataMode, telemetry]);

  const enterBulletTime = () => {
    if (!telemetry) return;
    const tJump = Math.max(telemetry.start, telemetry.end - 2.2);
    useApp.getState().setDataRate(0.1);
    seekDataTime(tJump, false);
    if (!useApp.getState().dataPlaying) toggleDataPlay();
  };

  const copyDeepLink = () => {
    const s = useApp.getState();
    const url = new URL(window.location.href);
    url.searchParams.set("t", dataClock.t.toFixed(2));
    url.searchParams.set("view", s.cameraMode);
    url.searchParams.set("rate", String(s.dataRate));
    if (s.xrayOpen) url.searchParams.set("xray", "1");
    else url.searchParams.delete("xray");
    void navigator.clipboard?.writeText(url.toString()).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const onPlay = () => {
    if (dataMode) {
      toggleDataPlay();
      return;
    }
    if (mode !== "cinematic") setMode("cinematic");
    setPlaying(!playing);
  };

  const jumpStory = (targetT: number, view: "macro" | "chase" | "target" | "free", rate: number, openSeeker = false) => {
    if (!telemetry) return;
    const clamped = Math.max(telemetry.start, Math.min(telemetry.end, targetT));
    const st = useApp.getState();
    st.setCameraMode(view);
    st.setDataRate(rate);
    st.setSeekerOpen(openSeeker);
    seekDataTime(clamped, false);
    if (!useApp.getState().dataPlaying) toggleDataPlay();
  };

  const lang = useApp((s) => s.lang);

  return (
    <div className="transport-wrap">
      {dataMode && (
        <div className="story-bar" role="group" aria-label={lang === "zh" ? "一键看高光" : "Quick Highlights"}>
          <span className="story-bar__label">{lang === "zh" ? "一键看高光" : "Quick Jump"}</span>
          <button type="button" className="story-btn" onClick={() => jumpStory(3.0, "chase", 1, false)}>
            {lang === "zh" ? "1. 发射升空" : "1. Launch"}
          </button>
          <button type="button" className="story-btn" onClick={() => jumpStory(12.0, "chase", 1, false)}>
            {lang === "zh" ? "2. 级间分离" : "2. Stage Sep"}
          </button>
          <button type="button" className="story-btn" onClick={() => jumpStory(telemetry.end - 9.0, "chase", 0.5, true)}>
            {lang === "zh" ? "3. 双模锁定" : "3. Seeker Lock"}
          </button>
          <button type="button" className="story-btn story-btn--accent" onClick={() => jumpStory(telemetry.end - 3.0, "target", 0.25, false)}>
            {lang === "zh" ? "4. 末段命中慢放" : "4. Terminal Hit"}
          </button>
        </div>
      )}
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
          <b ref={clockRef}>{dataMode ? formatMissionTime(dataClock.t) : fmt(time)}</b>
          {dataMode && <em className="transport__rate">{dataRate}×</em>}
        </div>
        {dataMode ? (
          <div className="transport__track">
            <input
              ref={sliderRef}
              type="range"
              min={telemetry.start}
              max={telemetry.end}
              step={0.05}
              defaultValue={dataClock.t}
              onChange={(e) => seekDataTime(Number(e.target.value))}
            />
            <div className="transport__events">
              {telemetry.events.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`transport__event transport__event--${e.severity}`}
                  style={{ left: `${((e.t - telemetry.start) / (telemetry.end - telemetry.start)) * 100}%` }}
                  title={`${e.label} (${e.t.toFixed(1)}s) — ${e.description}`}
                  onClick={() => seekDataTime(e.t, true)}
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
          <>
            <button
              type="button"
              className={`ghost-btn ghost-btn--sm ${dataRate <= 0.15 ? "is-active" : ""}`}
              onClick={enterBulletTime}
              title={t("bulletTimeHint")}
            >
              0.1×
            </button>
            <button
              type="button"
              className="ghost-btn ghost-btn--sm"
              onClick={() => cycleDataRate()}
              title={t("rateHint")}
              aria-label={t("rateHint")}
            >
              {dataRate}×
            </button>
            <button
              type="button"
              className="ghost-btn ghost-btn--sm"
              onClick={copyDeepLink}
              title={t("shareLinkHint")}
            >
              {copied ? "✓" : "🔗"}
            </button>
          </>
        )}
        <span ref={slowRef} className="chip chip--slow" style={{ display: "none" }}>
          {t("slowMo")}
        </span>
        <span className="fps">
          {t("fps")} <b>{fps}</b>
        </span>
        <button type="button" className="ghost-btn ghost-btn--sm" onClick={reset}>
          {t("reset")}
        </button>
      </div>
      <div className="transport__hint">{t("hint")}</div>
    </div>
    </div>
  );
}
