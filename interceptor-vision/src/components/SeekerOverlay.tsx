import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";
import {
  dataClock,
  formatMissionTime,
  sampleAt,
  seekDataTime,
  targetSampleAt,
  toggleDataPlay,
} from "../data/telemetry";

type RadarView = "bscope" | "rd";
type IrPalette = "ironbow" | "whitehot" | "nvg";
type Panel4View = "bplane" | "waterfall";

const FOV_LIMIT_DEG = 30;
const CFAR_DB = 13.0;
const BLIND_M = 120;
const LAMBDA_X_M = 0.03; // 10 GHz X-band

/** Exact match to missile_intercept/sensors/seeker.py aspect_rcs(). */
function aspectRcsM2(aspectDeg: number): number {
  let th = Math.abs(aspectDeg) % 360;
  if (th > 180) th = 360 - th;
  const dbFront = 10 * Math.log10(0.005); // -23.0 dBsm
  const dbSide = 10 * Math.log10(0.18);   // -7.45 dBsm
  const dbRear = 10 * Math.log10(0.06);   // -12.2 dBsm
  const cRear = 0.5 * (1 - Math.cos((th * Math.PI) / 180));
  const baseDb = dbFront * (1 - cRear) + dbRear * cRear;
  const midBase = 0.5 * (dbFront + dbRear);
  const lobe90 = Math.max(dbSide - midBase, 0) * Math.exp(-(((th - 90) / 16) ** 2));
  const lobeEdge =
    5.5 * Math.exp(-(((th - 36) / 6) ** 2)) +
    4.5 * Math.exp(-(((th - 144) / 7) ** 2));
  return Math.max(10 ** ((baseDb + lobe90 + lobeEdge) / 10), 1e-6);
}

/** Thermal colormap lookup [r, g, b] for v in [0, 1]. */
function paletteColor(v: number, pal: IrPalette): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  if (pal === "whitehot") {
    const c = Math.round(x * 255);
    return [c, c, Math.min(255, Math.round(c * 1.03))];
  }
  if (pal === "nvg") {
    const g = Math.round(Math.pow(x, 0.85) * 255);
    const r = Math.round(Math.max(0, (x - 0.65) / 0.35) * 210);
    const b = Math.round(Math.max(0, (x - 0.78) / 0.22) * 190);
    return [r, g, b];
  }
  // Ironbow (classic FLIR/MWIR palette: deep indigo -> purple -> crimson -> orange -> yellow -> white)
  const stops: [number, number, number, number][] = [
    [0.0, 4, 6, 22],
    [0.18, 38, 12, 86],
    [0.36, 118, 22, 118],
    [0.54, 198, 52, 66],
    [0.72, 242, 128, 24],
    [0.88, 255, 218, 78],
    [1.0, 255, 254, 244],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const u = (x - a[0]) / Math.max(b[0] - a[0], 1e-6);
      return [
        Math.round(a[1] + (b[1] - a[1]) * u),
        Math.round(a[2] + (b[2] - a[2]) * u),
        Math.round(a[3] + (b[3] - a[3]) * u),
      ];
    }
  }
  return [255, 254, 244];
}

function hashNoise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

interface BPlaneInfo {
  btM: number;
  brM: number;
  missM: number;
  pkPct: number;
  tMiss: number;
}

export function SeekerOverlay() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const telemetry = useApp((s) => s.telemetry);
  const dataPlaying = useApp((s) => s.dataPlaying);
  const close = () => useApp.getState().setSeekerOpen(false);

  const [radarView, setRadarView] = useState<RadarView>("bscope");
  const [irPalette, setIrPalette] = useState<IrPalette>("ironbow");
  const [panel4View, setPanel4View] = useState<Panel4View>("bplane");
  const [hud, setHud] = useState({
    time: 0,
    rangeM: 0,
    vc: 0,
    tgtRadVel: 0,
    radarSnr: -60,
    irSnr: -60,
    rcsM2: 0.005,
    aspectDeg: 0,
    azDeg: 0,
    elDeg: 0,
    fovDeg: 0,
    heatFlux: 0,
    wallTempK: 288,
    wallTempEqK: 288,
    mach: 0,
    altKm: 0,
    locked: false,
    mode: "DATALINK",
    decoyActive: false,
    immPCv: 0.34,
    immPCa: 0.33,
    immPCt: 0.33,
    fuzePkPct: 0,
  });

  const radarRef = useRef<HTMLCanvasElement>(null);
  const irRef = useRef<HTMLCanvasElement>(null);
  const rcsRef = useRef<HTMLCanvasElement>(null);
  const bplaneRef = useRef<HTMLCanvasElement>(null);
  const irOffscreen = useRef<{ canvas: HTMLCanvasElement; img: ImageData } | null>(null);
  const rdOffscreen = useRef<{ canvas: HTMLCanvasElement; img: ImageData } | null>(null);
  const trailRef = useRef<{ az: number; rng: number; t: number }[]>([]);

  // Compute B-plane terminal miss projection once per telemetry load.
  const bplane = useMemo<BPlaneInfo | null>(() => {
    if (!telemetry || telemetry.samples.length === 0) return null;
    let bestIdx = 0;
    let bestR = Infinity;
    for (let i = 0; i < telemetry.samples.length; i++) {
      if (telemetry.samples[i].rangeM < bestR) {
        bestR = telemetry.samples[i].rangeM;
        bestIdx = i;
      }
    }
    const ms = telemetry.samples[bestIdx];
    const ts = targetSampleAt(ms.t);
    const missM = typeof telemetry.metrics.missDistanceM === "number"
      ? telemetry.metrics.missDistanceM
      : ms.rangeM;
    const pkPct = Math.exp(-Math.LN2 * (missM / 15) ** 2) * 100;
    if (!ts) {
      return { btM: missM * 0.72, brM: missM * 0.69, missM, pkPct, tMiss: ms.t };
    }
    const rx = ms.position.x - ts.position.x;
    const ry = ms.position.y - ts.position.y;
    const rz = ms.position.z - ts.position.z;
    const vx = ms.velocity.x - ts.velocity.x;
    const vy = ms.velocity.y - ts.velocity.y;
    const vz = ms.velocity.z - ts.velocity.z;
    const vn = Math.hypot(vx, vy, vz) || 1;
    const ex = vx / vn, ey = vy / vn, ez = vz / vn;
    // Local radial "up" from Earth centre at target.
    const rn = Math.hypot(ts.position.x, ts.position.y, ts.position.z) || 1;
    const ux = ts.position.x / rn, uy = ts.position.y / rn, uz = ts.position.z / rn;
    // Horizontal cross-track axis T = up x v_rel_hat
    let tx = uy * ez - uz * ey;
    let ty = uz * ex - ux * ez;
    let tz = ux * ey - uy * ex;
    const tn = Math.hypot(tx, ty, tz) || 1;
    tx /= tn; ty /= tn; tz /= tn;
    // Vertical B-plane axis R = v_rel_hat x T
    const bx = ey * tz - ez * ty;
    const by = ez * tx - ex * tz;
    const bz = ex * ty - ey * tx;
    const btRaw = rx * tx + ry * ty + rz * tz;
    const brRaw = rx * bx + ry * by + rz * bz;
    const norm = Math.hypot(btRaw, brRaw);
    const scale = norm > 1e-3 ? missM / norm : 1;
    return {
      btM: btRaw * scale,
      brM: brRaw * scale,
      missM,
      pkPct,
      tMiss: ms.t,
    };
  }, [telemetry]);

  // Pre-compute key timeline jump marks (beaming, seeker lock, terminal -3s).
  const jumpMarks = useMemo(() => {
    if (!telemetry) return null;
    const end = telemetry.end;
    const lockEv = telemetry.events.find((e) => e.kind === "lock");
    const lockT = lockEv ? lockEv.t : Math.max(telemetry.start, end - 10);
    return {
      beaming: Math.max(telemetry.start, end - 26),
      lock: Math.max(telemetry.start, lockT - 0.5),
      endgame: Math.max(telemetry.start, end - 2.5),
      impact: Math.max(telemetry.start, end - 0.08),
    };
  }, [telemetry]);

  // Static panel 4 (B-Plane kill box / Miss-Budget Waterfall) redraws ONLY on
  // view/language/resize change instead of 60 times per second!
  useEffect(() => {
    const paintStatic = () => {
      if (panel4View === "bplane") {
        drawBPlane(bplaneRef.current, bplane);
      } else {
        drawWaterfall(bplaneRef.current, bplane, telemetry?.manifest, lang);
      }
    };
    paintStatic();
    const el = bplaneRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(paintStatic);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bplane, panel4View, telemetry, lang]);

  useEffect(() => {
    let raf = 0;
    let lastCanvasSync = 0;
    let lastHudSync = 0;
    let lastDrawnT = -1;

    const renderFrame = (nowMs: number) => {
      raf = requestAnimationFrame(renderFrame);
      const tel = telemetry;
      if (!tel) return;
      const curT = dataClock.t;
      const ms = sampleAt(curT);
      if (!ms) return;

      // Decouple dynamic sensor canvases (Radar B-Scope/R-D, MWIR FPA, RCS) from
      // the 60+ FPS WebGL loop to authentic 25 Hz sensor frame rate (40 ms),
      // while still repainting immediately when the user scrubs while paused.
      const scrubbed = Math.abs(curT - lastDrawnT) > 1e-4 && !useApp.getState().dataPlaying;
      if (!scrubbed && lastCanvasSync > 0 && nowMs - lastCanvasSync < 40) {
        return;
      }
      lastCanvasSync = nowMs;
      lastDrawnT = curT;

      const ts = targetSampleAt(curT);

      // Compute closing velocity & target radial speed relative to LOS.
      let vc = ms.speedMS;
      let tgtRadVel = 0;
      if (ts) {
        const dx = ts.position.x - ms.position.x;
        const dy = ts.position.y - ms.position.y;
        const dz = ts.position.z - ms.position.z;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const ux = dx / dist, uy = dy / dist, uz = dz / dist;
        vc = (ms.velocity.x - ts.velocity.x) * ux +
             (ms.velocity.y - ts.velocity.y) * uy +
             (ms.velocity.z - ts.velocity.z) * uz;
        tgtRadVel = ts.velocity.x * ux + ts.velocity.y * uy + ts.velocity.z * uz;
      }

      const rangeM = ms.rangeM;
      const aspectDeg = ms.aspectDeg ?? 0;
      const rcsM2 = ms.targetRcsM2 ?? aspectRcsM2(aspectDeg);
      const radarSnr = ms.radarSnrDb ?? -40;
      const irSnr = ms.irSnrDb ?? -40;
      const azDeg = ms.seekerAzDeg ?? 0;
      const elDeg = ms.seekerElDeg ?? 0;
      const heatFlux = ms.heatFluxMWm2 ?? 0;
      const wallTempK = ms.wallTempK ?? 288;
      const inBlind = rangeM <= BLIND_M;
      const inFov = ms.fovDeg <= FOV_LIMIT_DEG;
      const radarDet = !inBlind && inFov && radarSnr >= CFAR_DB;
      const irDet = !inBlind && inFov && irSnr >= CFAR_DB;
      const mode = inBlind
        ? "BLIND COAST"
        : radarDet && irDet
          ? "DUAL RADAR+IIR"
          : radarDet
            ? "X-BAND RADAR"
            : irDet || ms.seekerLock
              ? "MWIR IIR LOCK"
              : "DATALINK CUE";

      // Record brief phosphor trail for B-scope.
      const tr = trailRef.current;
      if (tr.length === 0 || Math.abs(tr[tr.length - 1].t - curT) > 0.05) {
        if (tr.length > 0 && curT < tr[tr.length - 1].t - 2) tr.length = 0;
        tr.push({ az: azDeg, rng: rangeM, t: curT });
        if (tr.length > 26) tr.shift();
      }

      // 1) Draw Radar Canvas (B-Scope or cached-ImageData Range-Doppler)
      const decActive = (ms.decoyActive ?? 0) > 0.5;
      const decAz = ms.decoyAzDeg ?? azDeg + 3.2;
      const decEl = ms.decoyElDeg ?? elDeg - 2.0;
      drawRadar(
        radarRef.current,
        rdOffscreen,
        radarView,
        nowMs * 0.001,
        rangeM,
        azDeg,
        vc,
        tgtRadVel,
        radarSnr,
        radarDet,
        inBlind,
        inFov,
        tr,
        decActive,
        decAz,
      );

      // 2) Draw MWIR IIR Focal-Plane Array Canvas (reusable 128x84 ImageData)
      drawIir(
        irRef.current,
        irOffscreen,
        irPalette,
        nowMs * 0.001,
        rangeM,
        azDeg,
        elDeg,
        aspectDeg,
        irSnr,
        wallTempK,
        irDet || ms.seekerLock,
        inBlind,
        inFov,
        decActive,
        decAz,
        decEl,
      );

      // 3) Draw 360-deg Target RCS Polar Plot
      drawRcsPolar(rcsRef.current, aspectDeg, rcsM2);

      // Throttle React state updates to ~12 Hz for crisp telemetry numbers.
      if (nowMs - lastHudSync > 80) {
        lastHudSync = nowMs;
        const fuzeMetric = typeof tel.metrics.fuzePk === "number" ? tel.metrics.fuzePk * 100 : (bplane?.pkPct ?? 0);
        setHud({
          time: curT,
          rangeM,
          vc,
          tgtRadVel,
          radarSnr,
          irSnr,
          rcsM2,
          aspectDeg,
          azDeg,
          elDeg,
          fovDeg: ms.fovDeg,
          heatFlux,
          wallTempK,
          wallTempEqK: ms.wallTempEqK ?? wallTempK,
          mach: ms.mach,
          altKm: ms.altM / 1000,
          locked: ms.seekerLock || radarDet || irDet,
          mode,
          decoyActive: decActive,
          immPCv: ms.immPCv ?? 0.34,
          immPCa: ms.immPCa ?? 0.33,
          immPCt: ms.immPCt ?? 0.33,
          fuzePkPct: fuzeMetric,
        });
      }
    };

    raf = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(raf);
  }, [telemetry, radarView, irPalette, bplane]);

  const rcsDbsm = 10 * Math.log10(Math.max(hud.rcsM2, 1e-6));
  const dopplerKhz = (2 * hud.vc) / LAMBDA_X_M / 1000;
  const thermalFrac = Math.min(100, Math.max(0, ((hud.wallTempK - 220) / (2500 - 220)) * 100));

  return (
    <div className="seeker-overlay" role="dialog" aria-modal="true" aria-label={t("seekerTitle")}>
      <header className="seeker-overlay__head">
        <div>
          <div className="seeker-overlay__title-row">
            <h2>{t("seekerTitle")}</h2>
            <span className={`seeker-mode seeker-mode--${hud.mode.split(" ")[0].toLowerCase()}`}>
              {hud.mode}
            </span>
            <span className="seeker-clock">{formatMissionTime(hud.time)} ({hud.time.toFixed(2)} s)</span>
          </div>
          <p>{t("seekerSub")}</p>
        </div>
        <div className="seeker-overlay__actions">
          {jumpMarks && (
            <div className="seeker-jumps">
              <button type="button" className="ghost-btn ghost-btn--sm" onClick={() => seekDataTime(jumpMarks.beaming, false)}>
                {lang === "zh" ? "60km 机动" : "60km Beam"}
              </button>
              <button type="button" className="ghost-btn ghost-btn--sm" onClick={() => seekDataTime(jumpMarks.lock, false)}>
                {lang === "zh" ? "导引头截获" : "Seeker Lock"}
              </button>
              <button type="button" className="ghost-btn ghost-btn--sm" onClick={() => seekDataTime(jumpMarks.endgame, false)}>
                {lang === "zh" ? "末段 2.5s" : "Final 2.5s"}
              </button>
              <button type="button" className="ghost-btn ghost-btn--sm" onClick={() => toggleDataPlay()}>
                {dataPlaying ? t("pause") : t("play")}
              </button>
            </div>
          )}
          <button type="button" className="icon-button" onClick={close} title={t("close")}>
            ✕
          </button>
        </div>
      </header>

      {telemetry && (
        <div className="seeker-scrubber">
          <span>{formatMissionTime(telemetry.start)}</span>
          <input
            type="range"
            min={telemetry.start}
            max={telemetry.end}
            step={0.05}
            value={hud.time}
            onChange={(e) => seekDataTime(Number(e.target.value), true)}
          />
          <span>{formatMissionTime(telemetry.end)}</span>
        </div>
      )}

      <div className="seeker-grid">
        {/* Panel 1: X-Band Pulse-Doppler Radar */}
        <section className="seeker-card">
          <div className="seeker-card__head">
            <div>
              <h3>{lang === "zh" ? "X 波段脉冲多普勒雷达 (10 GHz)" : "X-Band Pulse-Doppler Radar (10 GHz)"}</h3>
              <span className="seeker-card__sub">
                SNR {hud.radarSnr.toFixed(1)} dB · f_d {dopplerKhz.toFixed(1)} kHz · CFAR {CFAR_DB.toFixed(0)} dB
              </span>
            </div>
            <div className="segmented segmented--sm">
              <button type="button" className={radarView === "bscope" ? "is-active" : ""} onClick={() => setRadarView("bscope")}>
                B-Scope
              </button>
              <button type="button" className={radarView === "rd" ? "is-active" : ""} onClick={() => setRadarView("rd")}>
                R-D
              </button>
            </div>
          </div>
          <canvas ref={radarRef} className="seeker-canvas" />
        </section>

        {/* Panel 2: MWIR Imaging Infrared Seeker */}
        <section className="seeker-card">
          <div className="seeker-card__head">
            <div>
              <h3>{lang === "zh" ? "中波红外成像导引头 (MWIR 3.7–4.8 μm)" : "MWIR Imaging Infrared Seeker (3.7–4.8 μm)"}</h3>
              <span className="seeker-card__sub">
                SNR {hud.irSnr.toFixed(1)} dB · AZ {hud.azDeg >= 0 ? "+" : ""}{hud.azDeg.toFixed(2)}° · EL {hud.elDeg >= 0 ? "+" : ""}{hud.elDeg.toFixed(2)}°
              </span>
            </div>
            <div className="segmented segmented--sm">
              <button type="button" className={irPalette === "ironbow" ? "is-active" : ""} onClick={() => setIrPalette("ironbow")}>
                {lang === "zh" ? "铁红" : "Iron"}
              </button>
              <button type="button" className={irPalette === "whitehot" ? "is-active" : ""} onClick={() => setIrPalette("whitehot")}>
                {lang === "zh" ? "白热" : "W-Hot"}
              </button>
              <button type="button" className={irPalette === "nvg" ? "is-active" : ""} onClick={() => setIrPalette("nvg")}>
                NVG
              </button>
            </div>
          </div>
          <canvas ref={irRef} className="seeker-canvas" />
        </section>

        {/* Panel 3: Target 360-deg RCS Polar Diagram */}
        <section className="seeker-card">
          <div className="seeker-card__head">
            <div>
              <h3>{lang === "zh" ? "目标 360° 单站 RCS 极坐标图 (F-35A 级)" : "Target 360° Monostatic RCS Polar (F-35A Class)"}</h3>
              <span className="seeker-card__sub">
                {lang === "zh" ? "姿态角" : "Aspect"} {hud.aspectDeg.toFixed(1)}° · σ = {hud.rcsM2.toFixed(4)} m² ({rcsDbsm.toFixed(1)} dBsm)
              </span>
            </div>
          </div>
          <canvas ref={rcsRef} className="seeker-canvas seeker-canvas--compact" />
        </section>

        {/* Panel 4: Terminal B-Plane Kill-Box / Miss-Budget Waterfall + Aerothermal TPS */}
        <section className="seeker-card">
          <div className="seeker-card__head">
            <div>
              <h3>{lang === "zh" ? "末段 B 平面杀伤盒 / 脱靶归因 & 气动热" : "B-Plane Kill-Box / Miss Waterfall & TPS"}</h3>
              <span className="seeker-card__sub">
                {bplane ? `Miss ${bplane.missM.toFixed(2)} m · Fuze Pk ${hud.fuzePkPct.toFixed(1)}% · R_L 15 m` : "—"}
              </span>
            </div>
            <div className="segmented segmented--sm">
              <button type="button" className={panel4View === "bplane" ? "is-active" : ""} onClick={() => setPanel4View("bplane")}>
                B-Plane
              </button>
              <button type="button" className={panel4View === "waterfall" ? "is-active" : ""} onClick={() => setPanel4View("waterfall")}>
                {lang === "zh" ? "归因瀑布" : "Waterfall"}
              </button>
            </div>
          </div>
          <div className="seeker-split">
            <canvas ref={bplaneRef} className="seeker-canvas seeker-canvas--bplane" />
            <div className="seeker-metrics">
              <div className="seeker-metric">
                <span>{lang === "zh" ? "斜距 R" : "Slant Range"}</span>
                <b>{hud.rangeM >= 1000 ? `${(hud.rangeM / 1000).toFixed(2)} km` : `${hud.rangeM.toFixed(1)} m`}</b>
              </div>
              <div className="seeker-metric">
                <span>{lang === "zh" ? "接近速度 Vc" : "Closing Vc"}</span>
                <b>{hud.vc.toFixed(0)} m/s</b>
              </div>
              <div className="seeker-metric">
                <span>{lang === "zh" ? "目标径向速" : "Tgt Radial V"}</span>
                <b className={Math.abs(hud.tgtRadVel) < 40 ? "is-warn" : ""}>
                  {hud.tgtRadVel.toFixed(0)} m/s {Math.abs(hud.tgtRadVel) < 40 ? "(NOTCH)" : ""}
                </b>
              </div>
              <div className="seeker-metric">
                <span>{lang === "zh" ? "驻点热流 q̇s" : "Stag. Heat Flux"}</span>
                <b>{hud.heatFlux.toFixed(2)} MW/m²</b>
              </div>
              <div className="seeker-metric">
                <span>{lang === "zh" ? "瞬态 / 平衡壁温" : "Tw / Teq"}</span>
                <b className={hud.wallTempK > 2100 ? "is-hot" : ""}>
                  {hud.wallTempK.toFixed(0)} / {hud.wallTempEqK.toFixed(0)} K
                </b>
              </div>
              <div className="thermal-bar" title="C-SiC TPS Nose Wall Temperature">
                <div className="thermal-bar__fill" style={{ width: `${thermalFrac}%` }} />
              </div>
              <div className="seeker-metric">
                <span>{lang === "zh" ? "IMM 模型权重" : "IMM Modes"}</span>
                <b>
                  CV {(hud.immPCv * 100).toFixed(0)}% · CA {(hud.immPCa * 100).toFixed(0)}% · CT {(hud.immPCt * 100).toFixed(0)}%
                </b>
              </div>
              <div className="seeker-metric">
                <span>{lang === "zh" ? "抗诱饵波门" : "ECM Gate"}</span>
                <b className={hud.decoyActive ? "is-warn" : ""}>
                  {hud.decoyActive
                    ? (lang === "zh" ? "诱饵/箔条已剔除" : "DECOY GATED")
                    : `M ${hud.mach.toFixed(2)} · ${hud.altKm.toFixed(1)} km`}
                </b>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ========================================================================= */
/* Canvas Renderers                                                          */
/* ========================================================================= */

function sizeCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(240, Math.round(rect.width));
  const h = Math.max(170, Math.round(rect.height));
  // Cap DPR to 1.25 for crisp sensor-native resolution without HiDPI overdraw.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawRadar(
  canvas: HTMLCanvasElement | null,
  rdOffRef: React.MutableRefObject<{ canvas: HTMLCanvasElement; img: ImageData } | null>,
  mode: RadarView,
  animT: number,
  rangeM: number,
  azDeg: number,
  vc: number,
  tgtRadVel: number,
  snrDb: number,
  radarDet: boolean,
  inBlind: boolean,
  inFov: boolean,
  trail: { az: number; rng: number; t: number }[],
  decoyActive = false,
  decoyAzDeg = 0,
) {
  if (!canvas) return;
  const sized = sizeCanvas(canvas);
  if (!sized) return;
  const { ctx, w, h } = sized;

  ctx.fillStyle = "#040d09";
  ctx.fillRect(0, 0, w, h);

  // Auto-ranging scale in km
  const maxRngKm =
    rangeM > 80000 ? 250 : rangeM > 32000 ? 80 : rangeM > 10000 ? 35 : rangeM > 2500 ? 12 : 3;
  const rangeKm = rangeM / 1000;

  if (mode === "bscope") {
    const cx = w * 0.5;
    const cy = h - 22;
    const rad = Math.min(h - 36, w * 0.62);
    const halfCone = (FOV_LIMIT_DEG * Math.PI) / 180;
    const displayCone = (36 * Math.PI) / 180; // display +/-36 deg sector, highlight +/-30 deg FOV

    // Subtle phosphor glow backdrop
    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, rad);
    grad.addColorStop(0, "rgba(18, 90, 56, 0.20)");
    grad.addColorStop(1, "rgba(4, 15, 10, 0.0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rad, -Math.PI / 2 - displayCone, -Math.PI / 2 + displayCone);
    ctx.closePath();
    ctx.fill();

    // Range rings
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    for (let i = 1; i <= 4; i++) {
      const r = (rad * i) / 4;
      ctx.strokeStyle = i === 4 ? "rgba(72, 232, 146, 0.36)" : "rgba(56, 198, 122, 0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2 - displayCone, -Math.PI / 2 + displayCone);
      ctx.stroke();
      ctx.fillStyle = "rgba(116, 232, 168, 0.72)";
      const labelKm = (maxRngKm * i) / 4;
      const lx = cx + r * Math.sin(displayCone) + 5;
      const ly = cy - r * Math.cos(displayCone) + 3;
      ctx.fillText(labelKm >= 10 ? `${labelKm.toFixed(0)}km` : `${labelKm.toFixed(1)}km`, lx, ly);
    }

    // Azimuth spokes (-30 FOV, -20, -10, 0, +10, +20, +30 FOV)
    for (const deg of [-30, -20, -10, 0, 10, 20, 30]) {
      const a = (deg * Math.PI) / 180;
      const isFov = Math.abs(deg) === FOV_LIMIT_DEG;
      ctx.strokeStyle = isFov
        ? "rgba(255, 194, 92, 0.55)"
        : deg === 0
          ? "rgba(96, 240, 162, 0.42)"
          : "rgba(56, 198, 122, 0.16)";
      ctx.setLineDash(isFov ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + rad * Math.sin(a), cy - rad * Math.cos(a));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Blind zone arc (200 m)
    const blindR = Math.max(8, (0.2 / maxRngKm) * rad);
    ctx.strokeStyle = "rgba(255, 96, 96, 0.75)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, blindR, -Math.PI / 2 - halfCone, -Math.PI / 2 + halfCone);
    ctx.stroke();

    // Sweeping beam inside +/-20 deg seeker gimbal FOV
    const sweepAng = Math.sin(animT * 3.1) * halfCone;
    ctx.strokeStyle = "rgba(94, 255, 168, 0.85)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + rad * Math.sin(sweepAng), cy - rad * Math.cos(sweepAng));
    ctx.stroke();

    // Look-down clutter speckles
    for (let k = 0; k < 42; k++) {
      const n1 = hashNoise(k, Math.floor(animT * 6), 1.3);
      const n2 = hashNoise(k, Math.floor(animT * 6), 9.7);
      const ca = (n1 * 2 - 1) * halfCone;
      const cr = (0.12 + n2 * 0.85) * rad;
      ctx.fillStyle = `rgba(60, 220, 130, ${0.06 + 0.12 * hashNoise(k, 3, animT)})`;
      ctx.fillRect(cx + cr * Math.sin(ca), cy - cr * Math.cos(ca), 2, 2);
    }

    // Target phosphor history trail
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i];
      if (p.rng / 1000 > maxRngKm) continue;
      const ta = Math.max(-displayCone, Math.min(displayCone, (p.az * Math.PI) / 180));
      const tr = ((p.rng / 1000) / maxRngKm) * rad;
      const alpha = ((i + 1) / trail.length) * 0.45;
      ctx.fillStyle = `rgba(90, 255, 165, ${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(cx + tr * Math.sin(ta), cy - tr * Math.cos(ta), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Current target radar echo
    if (rangeKm <= maxRngKm) {
      const ta = Math.max(-displayCone, Math.min(displayCone, (azDeg * Math.PI) / 180));
      const tr = Math.max(4, (rangeKm / maxRngKm) * rad);
      const tx = cx + tr * Math.sin(ta);
      const ty = cy - tr * Math.cos(ta);
      const strength = Math.max(0.18, Math.min(1, (snrDb + 15) / 45));

      const blip = ctx.createRadialGradient(tx, ty, 1, tx, ty, 8 + strength * 14);
      blip.addColorStop(0, radarDet ? "rgba(210, 255, 225, 0.98)" : "rgba(255, 200, 90, 0.8)");
      blip.addColorStop(0.4, radarDet ? "rgba(64, 255, 146, 0.65)" : "rgba(255, 160, 60, 0.35)");
      blip.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = blip;
      ctx.beginPath();
      ctx.arc(tx, ty, 8 + strength * 14, 0, Math.PI * 2);
      ctx.fill();

      // Track-while-scan gate diamond / brackets
      ctx.strokeStyle = inBlind ? "#ff6868" : radarDet ? "#78ffb6" : "#ffc566";
      ctx.lineWidth = 1.4;
      ctx.strokeRect(tx - 8, ty - 8, 16, 16);
      ctx.fillStyle = inBlind ? "#ff8888" : radarDet ? "#a4ffd0" : "#ffd68a";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(
        inBlind ? "BLIND <200m" : radarDet ? `TRK ${rangeKm.toFixed(2)}km` : `CUE ${rangeKm.toFixed(1)}km`,
        tx + 12,
        ty + 3,
      );

      // Decelerating radar chaff cloud (rejected by pulse-Doppler gate)
      if (decoyActive && !inBlind) {
        const da = Math.max(-displayCone, Math.min(displayCone, (decoyAzDeg * Math.PI) / 180));
        const dr = Math.min(rad, tr + 9);
        const dx = cx + dr * Math.sin(da);
        const dy = cy - dr * Math.cos(da);
        ctx.fillStyle = "rgba(255, 152, 64, 0.42)";
        ctx.beginPath();
        ctx.arc(dx, dy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ff9840";
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(dx - 6, dy - 6, 12, 12);
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffc285";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText("CHAFF REJ", dx + 9, dy + 3);
      }
    }

    // Top HUD annotations
    ctx.fillStyle = "rgba(130, 240, 178, 0.85)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`SCALE ${maxRngKm} km · FOV ±20°`, 10, 16);
    ctx.textAlign = "right";
    ctx.fillText(inFov ? "IN FOV" : "OFF BORESIGHT", w - 10, 16);
  } else {
    // Range-Doppler (R-D) Heatmap
    const padL = 44, padR = 14, padT = 20, padB = 28;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const vMin = -500, vMax = 3400; // closing velocity axis m/s
    const vcChaff = vc - 220;

    // Background thermal noise floor grid rendered into a cached 48x28 ImageData
    // offscreen bitmap (1 drawImage call instead of 1,344 fillRect + rgb strings!).
    const cols = 48, rows = 28;
    if (!rdOffRef.current) {
      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      const octxInit = off.getContext("2d")!;
      rdOffRef.current = { canvas: off, img: octxInit.createImageData(cols, rows) };
    }
    const { canvas: rdCanvas, img: rdImg } = rdOffRef.current;
    const rdCtx = rdCanvas.getContext("2d");
    const rdData = rdImg.data;
    const tick = Math.floor(animT * 5);
    for (let r = 0; r < rows; r++) {
      const rngVal = maxRngKm * (1 - (r + 0.5) / rows);
      const clutterDecay = 0.5 + 0.5 * Math.exp(-rngVal / (maxRngKm * 0.4));
      for (let c = 0; c < cols; c++) {
        const vVal = vMin + ((c + 0.5) / cols) * (vMax - vMin);
        let energy = 0.08 + 0.1 * hashNoise(c, r, tick);
        // Mainlobe ground clutter ridge around 0 m/s Doppler
        energy += 0.45 * Math.exp(-((vVal / 85) ** 2)) * clutterDecay;
        // Target Doppler return peak
        if (rangeKm <= maxRngKm) {
          const dv = (vVal - vc) / 140;
          const dr = (rngVal - rangeKm) / (maxRngKm * 0.055);
          const snrGain = Math.max(0.15, Math.min(1.4, (snrDb + 10) / 30));
          energy += snrGain * Math.exp(-(dv * dv + dr * dr));
          if (decoyActive) {
            const dvc = (vVal - vcChaff) / 170;
            const drc = (rngVal - (rangeKm + 0.12)) / (maxRngKm * 0.075);
            energy += 0.72 * Math.exp(-(dvc * dvc + drc * drc));
          }
        }
        const e = Math.min(1, energy);
        const idx = (r * cols + c) * 4;
        rdData[idx] = Math.min(255, Math.round(e > 0.65 ? (e - 0.65) * 700 : 12));
        rdData[idx + 1] = Math.round(Math.min(255, e * 280));
        rdData[idx + 2] = Math.round(Math.min(210, e * 140 + (e > 0.85 ? 90 : 0)));
        rdData[idx + 3] = 255;
      }
    }
    if (rdCtx) {
      rdCtx.putImageData(rdImg, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(rdCanvas, padL, padT, pw, ph);
      ctx.imageSmoothingEnabled = true;
    }

    // Zero-Doppler notch zone (+/-35 m/s around 0)
    const x0 = padL + ((0 - vMin) / (vMax - vMin)) * pw;
    const notchPx = Math.max(6, (70 / (vMax - vMin)) * pw);
    ctx.fillStyle = "rgba(255, 86, 86, 0.22)";
    ctx.fillRect(x0 - notchPx / 2, padT, notchPx, ph);
    ctx.strokeStyle = "rgba(255, 110, 110, 0.7)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, padT);
    ctx.lineTo(x0, padT + ph);
    ctx.stroke();
    ctx.setLineDash([]);

    // Axes & ticks
    ctx.strokeStyle = "rgba(120, 230, 170, 0.45)";
    ctx.strokeRect(padL, padT, pw, ph);
    ctx.fillStyle = "rgba(140, 240, 185, 0.85)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    for (const v of [0, 1000, 2000, 3000]) {
      const xv = padL + ((v - vMin) / (vMax - vMin)) * pw;
      ctx.fillText(`${v}`, xv, h - 10);
    }
    ctx.fillText("Vc (m/s) · Doppler", padL + pw / 2, h - 1);
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = padT + ph - (ph * i) / 4;
      const rk = (maxRngKm * i) / 4;
      ctx.fillText(rk >= 10 ? `${rk.toFixed(0)}k` : `${rk.toFixed(1)}k`, padL - 5, y + 3);
    }

    // Target peak reticle
    if (rangeKm <= maxRngKm) {
      const tx = padL + ((Math.max(vMin, Math.min(vMax, vc)) - vMin) / (vMax - vMin)) * pw;
      const ty = padT + ph - (rangeKm / maxRngKm) * ph;
      ctx.strokeStyle = radarDet ? "#aaffd2" : "#ffcf70";
      ctx.lineWidth = 1.4;
      ctx.strokeRect(tx - 7, ty - 7, 14, 14);
      ctx.textAlign = "left";
      ctx.fillStyle = "#eafff2";
      ctx.fillText(`TGT ${snrDb.toFixed(1)}dB`, Math.min(w - 84, tx + 10), Math.max(padT + 12, ty + 3));
      if (decoyActive) {
        const cxD = padL + ((Math.max(vMin, Math.min(vMax, vcChaff)) - vMin) / (vMax - vMin)) * pw;
        ctx.strokeStyle = "#ff9840";
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(cxD - 6, ty - 6, 12, 12);
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffc285";
        ctx.fillText("CHAFF GATED", Math.max(padL + 6, cxD - 66), Math.max(padT + 24, ty - 10));
      }
    }

    // Notch readout if beaming
    ctx.textAlign = "left";
    ctx.fillStyle = Math.abs(tgtRadVel) < 40 ? "#ff9898" : "rgba(180,240,210,0.8)";
    ctx.fillText(`CLUTTER NOTCH ±35 m/s`, padL + 6, padT + 12);
  }
}

function drawIir(
  canvas: HTMLCanvasElement | null,
  offRef: React.MutableRefObject<{ canvas: HTMLCanvasElement; img: ImageData } | null>,
  palette: IrPalette,
  animT: number,
  rangeM: number,
  azDeg: number,
  elDeg: number,
  aspectDeg: number,
  irSnrDb: number,
  wallTempK: number,
  irLock: boolean,
  inBlind: boolean,
  inFov: boolean,
  decoyActive = false,
  decoyAzDeg = 0,
  decoyElDeg = 0,
) {
  if (!canvas) return;
  const sized = sizeCanvas(canvas);
  if (!sized) return;
  const { ctx, w, h } = sized;

  // Sensor-native 128x84 FPA with cached offscreen canvas & reusable ImageData
  // (zero per-frame GC allocations, crisp pixel-scaled thermal imagery).
  const fw = 128, fh = 84;
  if (!offRef.current) {
    const offC = document.createElement("canvas");
    offC.width = fw;
    offC.height = fh;
    const initCtx = offC.getContext("2d")!;
    offRef.current = { canvas: offC, img: initCtx.createImageData(fw, fh) };
  }
  const { canvas: off, img } = offRef.current;
  const octx = off.getContext("2d");
  if (!octx) return;
  const data = img.data;

  // Map body-frame az/el (+/-20 deg) onto FPA pixel coordinates with glint micro-jitter
  const glintAmp = Math.min(1.6, 450 / Math.max(rangeM, 200));
  const jx = (Math.sin(animT * 17.3) + 0.5 * Math.cos(animT * 31.1)) * glintAmp;
  const jy = (Math.cos(animT * 19.7) + 0.5 * Math.sin(animT * 27.9)) * glintAmp;
  const tx = fw * 0.5 + (azDeg / FOV_LIMIT_DEG) * (fw * 0.42) + jx;
  const ty = fh * 0.5 - (elDeg / FOV_LIMIT_DEG) * (fh * 0.42) + jy;
  const fx = fw * 0.5 + (decoyAzDeg / FOV_LIMIT_DEG) * (fw * 0.42);
  const fy = fh * 0.5 - (decoyElDeg / FOV_LIMIT_DEG) * (fh * 0.42);

  // Hypersonic window dome aerothermal background glow (stronger near aperture rim)
  const domeGlow = Math.max(0, Math.min(0.45, ((wallTempK - 900) / 1700) * 0.38));
  // Sensor thermal noise inversely related to IR SNR
  const noiseLevel = Math.max(0.03, Math.min(0.24, 0.22 - (irSnrDb / 60) * 0.16));
  // Target angular size in pixels (F-35A ~15.7 m across +/-20 deg = 0.7 rad FOV)
  const angPx = Math.max(1.2, Math.min(22, (15.7 / Math.max(rangeM, 180)) / (40 * Math.PI / 180) * fw * 2.2));
  const sigBright = Math.max(0.18, Math.min(1.05, (irSnrDb + 8) / 38));
  const aspectRad = (aspectDeg * Math.PI) / 180;
  // Plume visibility & direction on focal plane
  const plumeStrength = 0.25 + 0.75 * (0.5 * (1 - Math.cos(aspectRad)));
  const plumeLen = angPx * (1.2 + 1.8 * Math.sin(aspectRad));
  const frameSeed = Math.floor(animT * 18);

  for (let y = 0; y < fh; y++) {
    const ny = (y - fh * 0.5) / (fh * 0.5);
    for (let x = 0; x < fw; x++) {
      const nx = (x - fw * 0.5) / (fw * 0.5);
      const r2 = nx * nx + ny * ny;

      // Sky/horizon vertical thermal gradient + hypersonic dome rim radiation
      let val = 0.08 + 0.06 * Math.max(0, ny) + domeGlow * Math.min(1.2, r2 * 0.9);
      val += (hashNoise(x, y, frameSeed) - 0.5) * noiseLevel;

      // Target hot airframe + aerodynamic leading edge + engine plume
      if (inFov || Math.abs(azDeg) < 24) {
        const dx = x - tx;
        const dy = y - ty;
        const d2 = dx * dx + dy * dy;
        const core = Math.exp(-d2 / Math.max(1.2, angPx * angPx * 0.35));
        // Swept delta wing shape visible once close (< 4 km)
        let wing = 0;
        if (angPx > 3.2) {
          const wx = dx / (angPx * 1.15);
          const wy = dy / (angPx * 0.52);
          wing = 0.65 * Math.exp(-(wx * wx * 2.2 + wy * wy * 3.8));
        }
        // Exhaust plume trailing horizontally based on beaming aspect
        const px = dx - plumeLen * 0.55;
        const py = dy - plumeLen * 0.12;
        const plume =
          plumeStrength *
          0.95 *
          Math.exp(-((px / Math.max(1.5, plumeLen * 0.65)) ** 2 + (py / Math.max(1.1, angPx * 0.32)) ** 2));

        val += sigBright * (0.95 * core + wing + plume);
      }

      // Separating hot IR flare decoy blooms
      if (decoyActive && !inBlind) {
        const fdx = x - fx;
        const fdy = y - fy;
        const mx = x - (fx + tx) * 0.55;
        const my = y - (fy + ty) * 0.55;
        val += 0.96 * Math.exp(-(fdx * fdx + fdy * fdy) / 7.5) + 0.48 * Math.exp(-(mx * mx + my * my) / 4.5);
      }

      const [R, G, B] = paletteColor(val, palette);
      const idx = (y * fw + x) * 4;
      data[idx] = R;
      data[idx + 1] = G;
      data[idx + 2] = B;
      data[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, w, h);

  // Optical seeker reticle, +/-20 deg circular FOV mask border, and tracking gate
  const cx = w * 0.5, cy = h * 0.5;
  const fovR = Math.min(w, h) * 0.43;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.34)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, fovR, 0, Math.PI * 2);
  ctx.stroke();

  // Inner 10-deg ring & boresight crosshair
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, fovR * 0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
  ctx.beginPath();
  ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 4, cy);
  ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 14, cy);
  ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 4);
  ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 14);
  ctx.stroke();

  // Tracking gate around target projection
  const sx = (tx / fw) * w;
  const sy = (ty / fh) * h;
  if (inFov) {
    const g = Math.max(11, Math.min(34, (angPx / fw) * w * 1.4));
    ctx.strokeStyle = inBlind ? "#ff6868" : irLock ? "#7effb5" : "#ffd26e";
    ctx.lineWidth = 1.6;
    const arm = Math.max(4, g * 0.38);
    // Corner brackets
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(sx + dx * g, sy + dy * (g - arm));
      ctx.lineTo(sx + dx * g, sy + dy * g);
      ctx.lineTo(sx + dx * (g - arm), sy + dy * g);
      ctx.stroke();
    }
    if (decoyActive && !inBlind) {
      const fsx = (fx / fw) * w;
      const fsy = (fy / fh) * h;
      ctx.strokeStyle = "#ff9840";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(fsx - 9, fsy - 9, 18, 18);
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffc480";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText("FLARE GATED", Math.min(w - 72, fsx + 11), Math.max(24, fsy + 3));
    }
  }

  // HUD text overlay
  ctx.fillStyle = "rgba(245, 250, 255, 0.9)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText(`MWIR FPA · FOV ±20°${decoyActive ? " · ANTI-DECOY" : ""}`, 10, 16);
  ctx.fillText(`DOME ~${Math.round(220 + 0.22 * Math.max(wallTempK - 220, 0))} K`, 10, h - 10);
  ctx.textAlign = "right";
  ctx.fillStyle = inBlind ? "#ff8888" : irLock ? "#8effc1" : "#ffdb8a";
  ctx.fillText(inBlind ? "BLIND <200m" : irLock ? "IIR TRACK LOCK" : "SEARCH / CUE", w - 10, 16);
  ctx.fillStyle = "rgba(240, 248, 255, 0.85)";
  ctx.fillText(`R ${rangeM >= 1000 ? `${(rangeM / 1000).toFixed(2)} km` : `${rangeM.toFixed(0)} m`}`, w - 10, h - 10);
}

function drawRcsPolar(canvas: HTMLCanvasElement | null, aspectDeg: number, curRcsM2: number) {
  if (!canvas) return;
  const sized = sizeCanvas(canvas);
  if (!sized) return;
  const { ctx, w, h } = sized;

  ctx.fillStyle = "#060d18";
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.5;
  const cy = h * 0.52;
  const rad = Math.min(w, h) * 0.39;
  const minDb = -30;
  const maxDb = 0;

  // Concentric dBsm rings (-30, -20, -10, 0 dBsm)
  ctx.font = "9.5px ui-monospace, monospace";
  ctx.textAlign = "left";
  for (const db of [-20, -10, 0]) {
    const r = ((db - minDb) / (maxDb - minDb)) * rad;
    ctx.strokeStyle = db === 0 ? "rgba(110, 175, 225, 0.34)" : "rgba(110, 175, 225, 0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(155, 195, 228, 0.65)";
    ctx.fillText(`${db} dBsm`, cx + 4, cy - r + 10);
  }

  // Cardinal angle spokes (0=Nose top, 90=Beam right, 180=Tail bottom)
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const a = (deg * Math.PI) / 180;
    ctx.strokeStyle = "rgba(110, 175, 225, 0.14)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + rad * Math.sin(a), cy - rad * Math.cos(a));
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(185, 215, 240, 0.78)";
  ctx.textAlign = "center";
  ctx.fillText("0° NOSE", cx, cy - rad - 6);
  ctx.fillText("180° TAIL", cx, cy + rad + 12);
  ctx.textAlign = "left";
  ctx.fillText("90° BEAM", cx + rad + 5, cy + 3);
  ctx.textAlign = "right";
  ctx.fillText("270°", cx - rad - 5, cy + 3);

  // Full 360-deg F-35A VLO RCS butterfly curve
  ctx.beginPath();
  for (let deg = 0; deg <= 360; deg += 2) {
    const db = 10 * Math.log10(aspectRcsM2(deg));
    const r = Math.max(2, ((Math.max(minDb, Math.min(maxDb, db)) - minDb) / (maxDb - minDb)) * rad);
    const a = (deg * Math.PI) / 180;
    const x = cx + r * Math.sin(a);
    const y = cy - r * Math.cos(a);
    if (deg === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(64, 198, 255, 0.16)";
  ctx.fill();
  ctx.strokeStyle = "#5ad4ff";
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Miniature fighter silhouette at center (nose pointing up = 0 deg)
  ctx.fillStyle = "rgba(210, 232, 250, 0.65)";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 11);
  ctx.lineTo(cx + 3, cy - 4);
  ctx.lineTo(cx + 11, cy + 3);
  ctx.lineTo(cx + 10, cy + 6);
  ctx.lineTo(cx + 3, cy + 5);
  ctx.lineTo(cx + 5, cy + 10);
  ctx.lineTo(cx, cy + 8);
  ctx.lineTo(cx - 5, cy + 10);
  ctx.lineTo(cx - 3, cy + 5);
  ctx.lineTo(cx - 10, cy + 6);
  ctx.lineTo(cx - 11, cy + 3);
  ctx.lineTo(cx - 3, cy - 4);
  ctx.closePath();
  ctx.fill();

  // Live incoming radar LOS aspect needle
  const curDb = 10 * Math.log10(Math.max(curRcsM2, 1e-6));
  const curR = Math.max(4, ((Math.max(minDb, Math.min(maxDb, curDb)) - minDb) / (maxDb - minDb)) * rad);
  const aa = (aspectDeg * Math.PI) / 180;
  const px = cx + curR * Math.sin(aa);
  const py = cy - curR * Math.cos(aa);

  ctx.strokeStyle = "#ffb957";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + rad * Math.sin(aa), cy - rad * Math.cos(aa));
  ctx.stroke();

  ctx.fillStyle = "#ffcb6b";
  ctx.beginPath();
  ctx.arc(px, py, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#060d18";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function drawBPlane(canvas: HTMLCanvasElement | null, bp: BPlaneInfo | null) {
  if (!canvas) return;
  const sized = sizeCanvas(canvas);
  if (!sized) return;
  const { ctx, w, h } = sized;

  ctx.fillStyle = "#060d18";
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.5;
  const cy = h * 0.5;
  const maxM = Math.max(25, bp ? bp.missM * 1.45 : 25);
  const scale = (Math.min(w, h) * 0.42) / maxM;

  // Crosshair axes
  ctx.strokeStyle = "rgba(130, 175, 210, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(10, cy); ctx.lineTo(w - 10, cy);
  ctx.moveTo(cx, 10); ctx.lineTo(cx, h - 10);
  ctx.stroke();

  // 15 m Lethal radius kill-zone ring
  const r15 = 15 * scale;
  ctx.fillStyle = "rgba(68, 224, 152, 0.11)";
  ctx.beginPath();
  ctx.arc(cx, cy, r15, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(86, 236, 165, 0.72)";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.setLineDash([]);

  // 5 m direct-hit core
  ctx.strokeStyle = "rgba(255, 194, 92, 0.45)";
  ctx.beginPath();
  ctx.arc(cx, cy, 5 * scale, 0, Math.PI * 2);
  ctx.stroke();

  // True-scale F-35A front/plan silhouette (10.7 m wingspan)
  const halfSpan = 5.35 * scale;
  ctx.strokeStyle = "rgba(120, 210, 255, 0.72)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - halfSpan, cy);
  ctx.lineTo(cx + halfSpan, cy);
  ctx.moveTo(cx - 1.4 * scale, cy - 2.1 * scale);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx + 1.4 * scale, cy - 2.1 * scale);
  ctx.stroke();
  ctx.fillStyle = "rgba(120, 210, 255, 0.85)";
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, 1.3 * scale), 0, Math.PI * 2);
  ctx.fill();

  // Actual closest-approach crossing point
  if (bp) {
    const ix = cx + bp.btM * scale;
    const iy = cy - bp.brM * scale;
    ctx.strokeStyle = "rgba(255, 118, 92, 0.85)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ix, iy);
    ctx.stroke();

    ctx.fillStyle = bp.missM <= 15 ? "#ff9e57" : "#ff5c5c";
    ctx.beginPath();
    ctx.arc(ix, iy, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(155, 228, 188, 0.85)";
  ctx.font = "9.5px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText("R_L = 15 m", cx + r15 * 0.68, cy - r15 * 0.72);
  ctx.fillStyle = "rgba(165, 198, 224, 0.75)";
  ctx.fillText("B_T (m)", w - 44, cy - 4);
  ctx.fillText("B_R", cx + 4, 14);
}

function drawWaterfall(
  canvas: HTMLCanvasElement | null,
  bp: BPlaneInfo | null,
  manifest: unknown,
  lang: string,
) {
  if (!canvas) return;
  const sized = sizeCanvas(canvas);
  if (!sized) return;
  const { ctx, w, h } = sized;

  ctx.fillStyle = "#060d18";
  ctx.fillRect(0, 0, w, h);

  const mbObj = (manifest as { metrics?: { missBudget?: { nominal?: Record<string, number> } } } | null | undefined)?.metrics?.missBudget;
  const mb = mbObj?.nominal;
  const fullV = mb?.full ?? bp?.missM ?? 5.1;
  const truthV = mb?.truth_nav ?? Math.max(0.35, fullV * 0.22);
  const noNoise = mb?.no_sensor_noise ?? Math.max(truthV + 0.4, fullV * 0.42);
  const noEvade = mb?.no_evade ?? Math.max(0.4, fullV * 0.35);

  const baseI = Math.max(0.2, truthV * 0.55);
  const dDel = Math.max(0, noNoise - truthV);
  const dNoi = Math.max(0, fullV - noNoise);
  const dMan = Math.min(Math.max(0, fullV - noEvade), fullV * 0.35);
  const dLag = Math.max(0, truthV - baseI);
  const rawS = baseI + dDel + dNoi + dMan + dLag;
  const scN = rawS > 1e-6 ? fullV / rawS : 1;

  const s0 = baseI * scN;
  const s1 = dDel * scN;
  const s2 = dNoi * scN;
  const s3 = dMan * scN;
  const s4 = Math.max(0, fullV - (s0 + s1 + s2 + s3));

  const bars = [
    { lbl: lang === "zh" ? "基准" : "Base", y0: 0, dh: s0, col: "#38bdf8" },
    { lbl: lang === "zh" ? "+延迟" : "+Del", y0: s0, dh: s1, col: "#a78bfa" },
    { lbl: lang === "zh" ? "+闪烁" : "+Glint", y0: s0 + s1, dh: s2, col: "#f59e0b" },
    { lbl: lang === "zh" ? "+9g" : "+9g", y0: s0 + s1 + s2, dh: s3, col: "#ef4444" },
    { lbl: lang === "zh" ? "+舵滞" : "+Lag", y0: s0 + s1 + s2 + s3, dh: s4, col: "#fb923c" },
    { lbl: lang === "zh" ? "总脱靶" : "Total", y0: 0, dh: fullV, col: "#22c55e" },
  ];

  const pL = 28, pR = 8, pT = 22, pB = 24;
  const pw = w - pL - pR;
  const ph = h - pT - pB;
  const yMax = Math.max(fullV * 1.25, 2.0);
  const bw = pw / bars.length;

  ctx.strokeStyle = "rgba(130, 175, 210, 0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pL, pT); ctx.lineTo(pL, pT + ph); ctx.lineTo(pL + pw, pT + ph);
  ctx.stroke();

  ctx.fillStyle = "#d8f2ff";
  ctx.font = "9.5px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText(`MISS WATERFALL (m) · ${fullV.toFixed(2)}m`, 8, 13);

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const x = pL + i * bw + bw * 0.14;
    const ww = bw * 0.72;
    const yTop = pT + ph - ((b.y0 + b.dh) / yMax) * ph;
    const yBot = pT + ph - (b.y0 / yMax) * ph;
    ctx.fillStyle = b.col;
    ctx.fillRect(x, yTop, ww, Math.max(2, yBot - yTop));
    ctx.fillStyle = "#e6f4ff";
    ctx.font = "8.5px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(b.dh.toFixed(1), x + ww * 0.5, yTop - 3);
    ctx.fillStyle = "#9ec5e6";
    ctx.fillText(b.lbl, x + ww * 0.5, h - 7);
  }
}
