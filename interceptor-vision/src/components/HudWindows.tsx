import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";
import { dataClock, sampleAt, seekDataTime, targetSampleAt, type Telemetry } from "../data/telemetry";

type RadarView = "bscope" | "rd";
type IrPalette = "ironbow" | "whitehot" | "nvg";
type PlotTab = "traj" | "aero" | "ctrl" | "snr" | "tps" | "mass" | "ecm";

const FOV_DEG = 30;
const CFAR_DB = 13.0;
const BLIND_M = 120;
const LAMBDA_X = 0.03;

/** Simplified East-Asia coastline polylines [lonDeg, latDeg] for SBIRS theater map. */
const COASTLINES: [number, number][][] = [
  [
    [117.7, 39.0], [119.5, 39.9], [121.6, 38.9], [122.4, 39.6], [124.2, 39.9],
    [122.1, 37.5], [122.7, 37.0], [120.4, 36.1], [119.5, 35.1], [120.3, 34.4],
    [121.9, 31.4], [121.5, 30.2], [122.2, 29.8], [121.4, 28.0], [120.5, 27.1],
    [119.6, 26.0], [118.2, 24.5], [116.7, 23.4], [114.2, 22.3],
  ],
  [
    [124.4, 39.8], [125.3, 38.6], [126.6, 37.5], [126.4, 35.8], [126.5, 34.6],
    [128.8, 35.1], [129.5, 36.0], [129.1, 37.6], [127.6, 39.3], [129.8, 41.8],
  ],
  [[130.9, 34.0], [131.6, 33.2], [131.4, 31.4], [130.5, 31.0], [129.9, 32.8], [130.9, 34.0]],
  [[128.0, 26.8], [127.7, 26.1], [125.3, 24.8], [124.2, 24.3]],
  [[121.5, 25.3], [121.9, 25.0], [121.6, 23.6], [120.8, 22.0], [120.2, 22.7], [120.1, 23.8], [121.0, 25.0], [121.5, 25.3]],
];

let nextZIndex = 42;

function hashNoise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function irColor(v: number, pal: IrPalette): [number, number, number] {
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
  const stops: [number, number, number, number][] = [
    [0.0, 4, 6, 22],
    [0.2, 42, 12, 90],
    [0.42, 134, 24, 114],
    [0.62, 214, 64, 54],
    [0.8, 250, 168, 36],
    [1.0, 255, 254, 242],
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
  return [255, 254, 242];
}

interface DraggableProps {
  winKey: string;
  icon: string;
  title: string;
  defaultPos: () => { x: number; y: number };
  width: number;
  headerExtra?: React.ReactNode;
  onExpand?: () => void;
  expandTitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}

function DraggableHudWindow({
  winKey,
  icon,
  title,
  defaultPos,
  width,
  headerExtra,
  onExpand,
  expandTitle,
  onClose,
  children,
}: DraggableProps) {
  const compact = useApp((s) => s.compact);
  const [pos, setPos] = useState(defaultPos);
  const [collapsed, setCollapsed] = useState(false);
  const [zIndex, setZIndex] = useState(() => ++nextZIndex);
  const dragRef = useRef<{ dx: number; dy: number; active: boolean }>({ dx: 0, dy: 0, active: false });

  // Clamp into viewport on resize so floating windows never vanish off-screen.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => ({
        x: Math.max(8, Math.min(window.innerWidth - width - 8, p.x)),
        y: Math.max(66, Math.min(window.innerHeight - 120, p.y)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width]);

  const bringFront = () => setZIndex(++nextZIndex);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (compact) return;
    if ((e.target as HTMLElement).closest("button")) return;
    bringFront();
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, active: true };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const nx = Math.max(8, Math.min(window.innerWidth - width - 8, e.clientX - dragRef.current.dx));
    const ny = Math.max(66, Math.min(window.innerHeight - 90, e.clientY - dragRef.current.dy));
    setPos({ x: nx, y: ny });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore if capture already ended
    }
  };

  return (
    <section
      className={`hud-win hud-win--${winKey} ${collapsed ? "is-collapsed" : ""}`}
      style={compact ? undefined : { left: pos.x, top: pos.y, width, zIndex }}
      onMouseDown={bringFront}
      aria-label={title}
    >
      <header
        className="hud-win__head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="hud-win__title">
          <span aria-hidden>{icon}</span>
          <span>{title}</span>
        </div>
        <div className="hud-win__tools">
          {headerExtra}
          {onExpand && (
            <button type="button" className="hud-win__btn" onClick={onExpand} title={expandTitle}>
              ⤢
            </button>
          )}
          <button
            type="button"
            className="hud-win__btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand" : "Minimize"}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <button type="button" className="hud-win__btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
      </header>
      {!collapsed && <div className="hud-win__body">{children}</div>}
    </section>
  );
}

/* ========================================================================= */
/* 1) Space-Based SBIRS Ground-Track & Altitude Profile PiP Window           */
/* ========================================================================= */
function SpaceHudWindow({ telemetry, onClose }: { telemetry: Telemetry; onClose: () => void }) {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);

  const pre = useMemo(() => {
    const samples = telemetry.samples;
    const dr = new Float64Array(samples.length);
    const lat0 = (samples[0]?.latDeg ?? 40) * (Math.PI / 180);
    const lon0 = (samples[0]?.lonDeg ?? 110) * (Math.PI / 180);
    let minLon = 107, maxLon = 131, minLat = 24, maxLat = 43;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.lonDeg - 2 < minLon) minLon = s.lonDeg - 2;
      if (s.lonDeg + 2 > maxLon) maxLon = s.lonDeg + 2;
      if (s.latDeg - 2 < minLat) minLat = s.latDeg - 2;
      if (s.latDeg + 2 > maxLat) maxLat = s.latDeg + 2;
      const lat = s.latDeg * (Math.PI / 180);
      const lon = s.lonDeg * (Math.PI / 180);
      const dlat = lat - lat0;
      const dlon = lon - lon0;
      const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat0) * Math.cos(lat) * Math.sin(dlon / 2) ** 2;
      dr[i] = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    }
    return { dr, minLon, maxLon, minLat, maxLat, maxDr: Math.max(dr[dr.length - 1] || 1660, 100) };
  }, [telemetry]);

  useEffect(() => {
    let raf = 0;
    let lastDraw = 0;
    let lastT = -1;

    const draw = (now: number) => {
      const curT = dataClock.t;
      const scrubbed = Math.abs(curT - lastT) > 1e-4 && !dataClock.playing;
      if (!scrubbed && lastDraw > 0 && now - lastDraw < 40) return;
      lastDraw = now;
      lastT = curT;

      const canvas = canvasRef.current;
      const ms = sampleAt(curT);
      if (!canvas || !ms) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      const cw = Math.round(rect.width * dpr);
      const ch = Math.round(rect.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = rect.width;
      const H = rect.height;
      const mapH = Math.round(H * 0.68);
      const profY = mapH + 6;
      const profH = H - profY - 4;
      const padL = 26, padR = 8, padT = 12, padB = 12;
      const mw = W - padL - padR;
      const mh = mapH - padT - padB;

      const projX = (lon: number) => padL + ((lon - pre.minLon) / (pre.maxLon - pre.minLon)) * mw;
      const projY = (lat: number) => padT + ((pre.maxLat - lat) / (pre.maxLat - pre.minLat)) * mh;

      ctx.fillStyle = "#050d18";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#08172b";
      ctx.fillRect(padL, padT, mw, mh);

      // Lat/lon grid
      ctx.strokeStyle = "rgba(95,165,220,0.12)";
      ctx.lineWidth = 1;
      for (let lon = Math.ceil(pre.minLon / 5) * 5; lon <= pre.maxLon; lon += 5) {
        const x = projX(lon);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + mh); ctx.stroke();
      }
      for (let lat = Math.ceil(pre.minLat / 5) * 5; lat <= pre.maxLat; lat += 5) {
        const y = projY(lat);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + mw, y); ctx.stroke();
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(padL, padT, mw, mh); ctx.clip();

      // Coastlines
      ctx.strokeStyle = "rgba(96,175,224,0.36)";
      ctx.lineWidth = 1.1;
      for (const poly of COASTLINES) {
        ctx.beginPath();
        poly.forEach(([lon, lat], i) => {
          const x = projX(lon), y = projY(lat);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      // SBIRS satellite & footprint
      const satLon = 117.5 + 2.4 * Math.sin(curT * 0.005);
      const satLat = 34.5 + 1.2 * Math.cos(curT * 0.004);
      const sx = projX(satLon), sy = projY(satLat);
      ctx.strokeStyle = "rgba(56,189,248,0.28)";
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.ellipse(sx, sy, mw * 0.44, mh * 0.46, -0.18, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);

      const mx = projX(ms.lonDeg), my = projY(ms.latDeg);
      ctx.strokeStyle = ms.phase === "boost" ? "rgba(255,107,74,0.65)" : "rgba(56,189,248,0.24)";
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(mx, my); ctx.stroke();
      ctx.fillStyle = "#38bdf8";
      ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);

      // Target dashed track
      const tgt = telemetry.targetSamples;
      if (tgt.length > 1) {
        ctx.strokeStyle = "rgba(56,189,248,0.52)";
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < tgt.length; i += 4) {
          const x = projX(tgt[i].lonDeg), y = projY(tgt[i].latDeg);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Reference full missile ground track
      const arr = telemetry.samples;
      ctx.strokeStyle = "rgba(180,210,240,0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 3) {
        const x = projX(arr[i].lonDeg), y = projY(arr[i].latDeg);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Phase-colored flown track
      ctx.lineWidth = 2;
      for (let i = 3; i < arr.length; i += 3) {
        const p0 = arr[i - 3], p1 = arr[i];
        if (p0.t > curT) break;
        ctx.strokeStyle = p1.phase === "boost" ? "#ef4444" : p1.phase === "terminal" ? "#f59e0b" : "#38bdf8";
        ctx.beginPath();
        ctx.moveTo(projX(p0.lonDeg), projY(p0.latDeg));
        ctx.lineTo(projX(p1.lonDeg), projY(p1.latDeg));
        ctx.stroke();
      }

      // Target & missile live beacons
      const ts = targetSampleAt(curT);
      if (ts) {
        const tx = projX(ts.lonDeg), ty = projY(ts.latDeg);
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 1.4;
        ctx.strokeRect(tx - 3.5, ty - 3.5, 7, 7);
      }
      ctx.fillStyle = "#ff6b4a";
      ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.1; ctx.stroke();

      ctx.restore();

      ctx.strokeStyle = "rgba(120,175,220,0.26)";
      ctx.strokeRect(padL, padT, mw, mh);

      // Altitude profile
      if (profH > 22) {
        ctx.fillStyle = "#071323";
        ctx.fillRect(padL, profY, mw, profH);
        ctx.strokeStyle = "rgba(120,175,220,0.2)";
        ctx.strokeRect(padL, profY, mw, profH);
        const drX = (d: number) => padL + (d / pre.maxDr) * mw;
        const altY = (km: number) => profY + profH - (Math.max(0, Math.min(36, km)) / 36) * (profH - 8) - 3;

        ctx.strokeStyle = "rgba(56,189,248,0.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i += 4) {
          const x = drX(pre.dr[i]), y = altY(arr[i].altM / 1000);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        let curIdx = 0;
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i += 3) {
          if (arr[i].t > curT) break;
          curIdx = i;
          const x = drX(pre.dr[i]), y = altY(arr[i].altM / 1000);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.fillStyle = "#ff6b4a";
        ctx.beginPath();
        ctx.arc(drX(pre.dr[curIdx]), altY(ms.altM / 1000), 3.2, 0, Math.PI * 2);
        ctx.fill();

        if (footRef.current) {
          footRef.current.textContent =
            `${ms.latDeg.toFixed(1)}°N ${ms.lonDeg.toFixed(1)}°E · ` +
            `${lang === "zh" ? "航程" : "DR"} ${pre.dr[curIdx].toFixed(0)}km · ` +
            `H ${(ms.altM / 1000).toFixed(1)}km`;
        }
      }
    };

    const tick = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(tick);
    };
    draw(performance.now());
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [telemetry, pre, lang, wide]);

  const onClickCanvas = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const mapH = rect.height * 0.68;
    const padL = 26, padR = 8, padT = 12, padB = 12;
    const mw = rect.width - padL - padR;
    const mh = mapH - padT - padB;
    const arr = telemetry.samples;
    if (y > mapH) {
      const frac = Math.max(0, Math.min(1, (x - padL) / Math.max(mw, 1)));
      const targetDr = frac * pre.maxDr;
      let best = 0, bestErr = Infinity;
      for (let i = 0; i < pre.dr.length; i++) {
        const d = Math.abs(pre.dr[i] - targetDr);
        if (d < bestErr) { bestErr = d; best = i; }
      }
      seekDataTime(arr[best].t);
      return;
    }
    let best = 0, bestD2 = Infinity;
    for (let i = 0; i < arr.length; i += 2) {
      const px = padL + ((arr[i].lonDeg - pre.minLon) / (pre.maxLon - pre.minLon)) * mw;
      const py = padT + ((pre.maxLat - arr[i].latDeg) / (pre.maxLat - pre.minLat)) * mh;
      const d2 = (px - x) ** 2 + (py - y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    seekDataTime(arr[best].t);
  };

  return (
    <DraggableHudWindow
      winKey="space"
      icon="🛰"
      title={t("hudSpaceTitle")}
      defaultPos={() => ({ x: 18, y: 70 })}
      width={wide ? 470 : 326}
      onExpand={() => setWide((w) => !w)}
      expandTitle={t("hudExpand")}
      onClose={onClose}
    >
      <canvas
        ref={canvasRef}
        className="hud-win__canvas"
        style={{ height: wide ? 260 : 172, cursor: "crosshair" }}
        onClick={onClickCanvas}
        title={lang === "zh" ? "点击轨道或纵剖面跳转时刻" : "Click track or profile to seek"}
      />
      <div className="hud-win__foot" ref={footRef}>SBIRS-GEO/LEO · STANDBY</div>
    </DraggableHudWindow>
  );
}

/* ========================================================================= */
/* 2) X-Band Pulse-Doppler Radar PiP Window (B-Scope / R-D)                  */
/* ========================================================================= */
function RadarHudWindow({ telemetry, onClose }: { telemetry: Telemetry; onClose: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<RadarView>("bscope");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const rdOffRef = useRef<{ canvas: HTMLCanvasElement; img: ImageData } | null>(null);

  useEffect(() => {
    let raf = 0;
    let lastDraw = 0;
    let lastT = -1;

    const draw = (now: number) => {
      const curT = dataClock.t;
      const scrubbed = Math.abs(curT - lastT) > 1e-4 && !dataClock.playing;
      if (!scrubbed && lastDraw > 0 && now - lastDraw < 40) return;
      lastDraw = now;
      lastT = curT;

      const canvas = canvasRef.current;
      const ms = sampleAt(curT);
      if (!canvas || !ms) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      const cw = Math.round(rect.width * dpr);
      const ch = Math.round(rect.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width, h = rect.height;

      const ts = targetSampleAt(curT);
      let vc = ms.speedMS;
      if (ts) {
        const dx = ts.position.x - ms.position.x;
        const dy = ts.position.y - ms.position.y;
        const dz = ts.position.z - ms.position.z;
        const dist = Math.hypot(dx, dy, dz) || 1;
        vc = ((ms.velocity.x - ts.velocity.x) * dx + (ms.velocity.y - ts.velocity.y) * dy + (ms.velocity.z - ts.velocity.z) * dz) / dist;
      }

      const rangeM = ms.rangeM;
      const rangeKm = rangeM / 1000;
      const maxRngKm = rangeM > 80000 ? 250 : rangeM > 32000 ? 80 : rangeM > 10000 ? 35 : rangeM > 2500 ? 12 : 3;
      const snrDb = ms.radarSnrDb ?? -40;
      const azDeg = ms.seekerAzDeg ?? 0;
      const inBlind = rangeM <= BLIND_M;
      const inFov = ms.fovDeg <= FOV_DEG;
      const det = !inBlind && inFov && snrDb >= CFAR_DB;
      const decOn = (ms.decoyActive ?? 0) > 0.5;
      const decAz = ms.decoyAzDeg ?? azDeg + 3.2;

      ctx.fillStyle = "#040d09";
      ctx.fillRect(0, 0, w, h);

      if (mode === "bscope") {
        const cx = w * 0.5, cy = h - 14;
        const rad = Math.min(h - 26, w * 0.62);
        const cone = (36 * Math.PI) / 180;
        const halfFov = (FOV_DEG * Math.PI) / 180;

        for (let i = 1; i <= 4; i++) {
          ctx.strokeStyle = i === 4 ? "rgba(72,232,146,0.34)" : "rgba(56,198,122,0.18)";
          ctx.beginPath();
          ctx.arc(cx, cy, (rad * i) / 4, -Math.PI / 2 - cone, -Math.PI / 2 + cone);
          ctx.stroke();
        }
        for (const d of [-30, -15, 0, 15, 30]) {
          const a = (d * Math.PI) / 180;
          ctx.strokeStyle = Math.abs(d) === 30 ? "rgba(255,194,92,0.5)" : "rgba(56,198,122,0.18)";
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + rad * Math.sin(a), cy - rad * Math.cos(a));
          ctx.stroke();
        }
        const sw = Math.sin(now * 0.0031) * halfFov;
        ctx.strokeStyle = "rgba(94,255,168,0.8)";
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + rad * Math.sin(sw), cy - rad * Math.cos(sw)); ctx.stroke();

        if (rangeKm <= maxRngKm) {
          const ta = Math.max(-cone, Math.min(cone, (azDeg * Math.PI) / 180));
          const tr = Math.max(4, (rangeKm / maxRngKm) * rad);
          const tx = cx + tr * Math.sin(ta), ty = cy - tr * Math.cos(ta);
          const g = ctx.createRadialGradient(tx, ty, 1, tx, ty, 13);
          g.addColorStop(0, det ? "rgba(210,255,225,0.96)" : "rgba(255,205,95,0.82)");
          g.addColorStop(0.5, det ? "rgba(64,255,146,0.55)" : "rgba(255,160,60,0.32)");
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(tx, ty, 13, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = inBlind ? "#ff6868" : det ? "#78ffb6" : "#ffc566";
          ctx.strokeRect(tx - 6, ty - 6, 12, 12);

          if (decOn && !inBlind) {
            const da = Math.max(-cone, Math.min(cone, (decAz * Math.PI) / 180));
            const dr = Math.min(rad, tr + 7);
            const dx = cx + dr * Math.sin(da), dy = cy - dr * Math.cos(da);
            ctx.strokeStyle = "#ff9840";
            ctx.setLineDash([2, 2]);
            ctx.strokeRect(dx - 5, dy - 5, 10, 10);
            ctx.setLineDash([]);
          }
        }
        ctx.fillStyle = "rgba(130,240,178,0.85)";
        ctx.font = "9.5px ui-monospace, monospace";
        ctx.fillText(`B-SCOPE · ${maxRngKm}km`, 8, 13);
      } else {
        const padL = 30, padR = 8, padT = 14, padB = 18;
        const pw = w - padL - padR, ph = h - padT - padB;
        const vMin = -400, vMax = 3400;
        const cols = 48, rows = 28;
        if (!rdOffRef.current) {
          const off = document.createElement("canvas");
          off.width = cols; off.height = rows;
          rdOffRef.current = { canvas: off, img: off.getContext("2d")!.createImageData(cols, rows) };
        }
        const { canvas: rdC, img: rdImg } = rdOffRef.current;
        const rdData = rdImg.data;
        const seed = Math.floor(now * 0.005);
        for (let r = 0; r < rows; r++) {
          const rk = maxRngKm * (1 - (r + 0.5) / rows);
          for (let c = 0; c < cols; c++) {
            const vv = vMin + ((c + 0.5) / cols) * (vMax - vMin);
            let e = 0.08 + 0.09 * hashNoise(c, r, seed) + 0.4 * Math.exp(-((vv / 85) ** 2));
            if (rangeKm <= maxRngKm) {
              const dv = (vv - vc) / 150;
              const dr = (rk - rangeKm) / (maxRngKm * 0.06);
              e += Math.max(0.2, Math.min(1.3, (snrDb + 10) / 30)) * Math.exp(-(dv * dv + dr * dr));
              if (decOn) {
                const dvc = (vv - (vc - 220)) / 180;
                e += 0.65 * Math.exp(-(dvc * dvc + dr * dr));
              }
            }
            const k = Math.min(1, e);
            const idx = (r * cols + c) * 4;
            rdData[idx] = Math.min(255, Math.round(k > 0.65 ? (k - 0.65) * 700 : 12));
            rdData[idx + 1] = Math.min(255, Math.round(k * 280));
            rdData[idx + 2] = Math.min(210, Math.round(k * 140));
            rdData[idx + 3] = 255;
          }
        }
        rdC.getContext("2d")?.putImageData(rdImg, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(rdC, padL, padT, pw, ph);
        ctx.imageSmoothingEnabled = true;
        ctx.strokeStyle = "rgba(120,230,170,0.4)";
        ctx.strokeRect(padL, padT, pw, ph);
        ctx.fillStyle = "rgba(140,240,185,0.85)";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(`R-D · Vc ${vc.toFixed(0)}m/s`, padL + 4, padT + 10);
      }

      if (footRef.current) {
        const fdKhz = (2 * vc) / LAMBDA_X / 1000;
        const rcs = ms.targetRcsM2 ?? 0.005;
        footRef.current.textContent =
          `SNR ${snrDb.toFixed(1)}dB · f_d ${fdKhz.toFixed(0)}kHz · σ ${rcs.toFixed(4)}m²${decOn ? " · CHAFF REJ" : ""}`;
      }
    };

    const tick = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(tick);
    };
    draw(performance.now());
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [telemetry, mode]);

  return (
    <DraggableHudWindow
      winKey="radar"
      icon="📡"
      title={t("hudRadarTitle")}
      defaultPos={() => ({ x: Math.max(18, window.innerWidth - 338), y: 70 })}
      width={320}
      headerExtra={
        <>
          <button
            type="button"
            className="hud-win__pill-btn"
            onClick={() => seekDataTime(Math.max(telemetry.start, telemetry.end - 3.5), false)}
            title="Jump to terminal seeker lock"
          >
            锁定
          </button>
          <div className="hud-win__seg">
            <button type="button" className={mode === "bscope" ? "is-active" : ""} onClick={() => setMode("bscope")}>B</button>
            <button type="button" className={mode === "rd" ? "is-active" : ""} onClick={() => setMode("rd")}>R-D</button>
          </div>
        </>
      }
      onExpand={() => useApp.getState().setSeekerOpen(true)}
      expandTitle={t("hudExpand")}
      onClose={onClose}
    >
      <canvas ref={canvasRef} className="hud-win__canvas" style={{ height: 185 }} />
      <div className="hud-win__foot" ref={footRef}>X-BAND RADAR · STANDBY</div>
    </DraggableHudWindow>
  );
}

/* ========================================================================= */
/* 3) MWIR Imaging Infrared Thermal PiP Window (128x84 FPA)                  */
/* ========================================================================= */
function IrHudWindow({ telemetry, onClose }: { telemetry: Telemetry; onClose: () => void }) {
  const t = useT();
  const [pal, setPal] = useState<IrPalette>("ironbow");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const offRef = useRef<{ canvas: HTMLCanvasElement; img: ImageData } | null>(null);

  useEffect(() => {
    let raf = 0;
    let lastDraw = 0;
    let lastT = -1;

    const draw = (now: number) => {
      const curT = dataClock.t;
      const scrubbed = Math.abs(curT - lastT) > 1e-4 && !dataClock.playing;
      if (!scrubbed && lastDraw > 0 && now - lastDraw < 40) return;
      lastDraw = now;
      lastT = curT;

      const canvas = canvasRef.current;
      const ms = sampleAt(curT);
      if (!canvas || !ms) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      const cw = Math.round(rect.width * dpr);
      const ch = Math.round(rect.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width, h = rect.height;

      const fw = 128, fh = 84;
      if (!offRef.current) {
        const off = document.createElement("canvas");
        off.width = fw; off.height = fh;
        offRef.current = { canvas: off, img: off.getContext("2d")!.createImageData(fw, fh) };
      }
      const { canvas: off, img } = offRef.current;
      const data = img.data;

      const animT = now * 0.001;
      const az = ms.seekerAzDeg ?? 0;
      const el = ms.seekerElDeg ?? 0;
      const snr = ms.irSnrDb ?? -40;
      const tw = ms.wallTempK ?? 288;
      const teq = ms.wallTempEqK ?? tw;
      const qdot = ms.heatFluxMWm2 ?? 0;
      const aspect = ((ms.aspectDeg ?? 60) * Math.PI) / 180;
      const inBlind = ms.rangeM <= BLIND_M;
      const inFov = ms.fovDeg <= FOV_DEG;
      const irLock = !inBlind && inFov && (snr >= CFAR_DB || ms.seekerLock);
      const decOn = (ms.decoyActive ?? 0) > 0.5;
      const decAz = ms.decoyAzDeg ?? az + 3.2;
      const decEl = ms.decoyElDeg ?? el - 2.0;

      const tx = fw * 0.5 + (az / FOV_DEG) * (fw * 0.42);
      const ty = fh * 0.5 - (el / FOV_DEG) * (fh * 0.42);
      const fx = fw * 0.5 + (decAz / FOV_DEG) * (fw * 0.42);
      const fy = fh * 0.5 - (decEl / FOV_DEG) * (fh * 0.42);
      const domeGlow = Math.max(0, Math.min(0.42, ((tw - 900) / 1700) * 0.36));
      const noise = Math.max(0.03, Math.min(0.22, 0.21 - (snr / 60) * 0.15));
      const angPx = Math.max(1.3, Math.min(18, (15.7 / Math.max(ms.rangeM, 180)) / (40 * Math.PI / 180) * fw * 2.1));
      const bright = Math.max(0.18, Math.min(1.05, (snr + 8) / 38));
      const plumeStr = 0.25 + 0.75 * (0.5 * (1 - Math.cos(aspect)));
      const plumeLen = angPx * (1.2 + 1.6 * Math.sin(aspect));
      const seed = Math.floor(animT * 16);

      for (let y = 0; y < fh; y++) {
        const ny = (y - fh * 0.5) / (fh * 0.5);
        for (let x = 0; x < fw; x++) {
          const nx = (x - fw * 0.5) / (fw * 0.5);
          let val = 0.08 + 0.05 * Math.max(0, ny) + domeGlow * Math.min(1.2, (nx * nx + ny * ny) * 0.9);
          val += (hashNoise(x, y, seed) - 0.5) * noise;
          if (inFov || Math.abs(az) < 24) {
            const dx = x - tx, dy = y - ty;
            const core = Math.exp(-(dx * dx + dy * dy) / Math.max(1.2, angPx * angPx * 0.35));
            const px = dx - plumeLen * 0.5, py = dy - plumeLen * 0.1;
            const plume = plumeStr * 0.9 * Math.exp(-((px / Math.max(1.5, plumeLen * 0.65)) ** 2 + (py / Math.max(1.1, angPx * 0.34)) ** 2));
            val += bright * (0.95 * core + plume);
          }
          if (decOn && !inBlind) {
            const fdx = x - fx, fdy = y - fy;
            val += 0.95 * Math.exp(-(fdx * fdx + fdy * fdy) / 7.0);
          }
          const [R, G, B] = irColor(val, pal);
          const idx = (y * fw + x) * 4;
          data[idx] = R; data[idx + 1] = G; data[idx + 2] = B; data[idx + 3] = 255;
        }
      }
      off.getContext("2d")?.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, w, h);

      // FOV ring + boresight + gate
      const cx = w * 0.5, cy = h * 0.5, fovR = Math.min(w, h) * 0.43;
      ctx.strokeStyle = "rgba(255,255,255,0.32)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, fovR, 0, Math.PI * 2); ctx.stroke();

      if (inFov) {
        const sx = (tx / fw) * w, sy = (ty / fh) * h;
        ctx.strokeStyle = inBlind ? "#ff6868" : irLock ? "#7effb5" : "#ffd26e";
        ctx.lineWidth = 1.4;
        ctx.strokeRect(sx - 9, sy - 9, 18, 18);
        if (decOn && !inBlind) {
          const fsx = (fx / fw) * w, fsy = (fy / fh) * h;
          ctx.strokeStyle = "#ff9840";
          ctx.setLineDash([2, 2]);
          ctx.strokeRect(fsx - 7, fsy - 7, 14, 14);
          ctx.setLineDash([]);
        }
      }
      ctx.fillStyle = "rgba(245,250,255,0.9)";
      ctx.font = "9.5px ui-monospace, monospace";
      ctx.fillText(`MWIR FPA${decOn ? " · FLARE REJ" : ""}`, 8, 13);

      if (footRef.current) {
        footRef.current.textContent =
          `IIR ${snr.toFixed(1)}dB · q̇s ${qdot.toFixed(2)}MW/m² · Tw ${tw.toFixed(0)}/${teq.toFixed(0)}K`;
      }
    };

    const tick = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(tick);
    };
    draw(performance.now());
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [telemetry, pal]);

  return (
    <DraggableHudWindow
      winKey="ir"
      icon="🔥"
      title={t("hudIrTitle")}
      defaultPos={() => ({ x: Math.max(18, window.innerWidth - 338), y: Math.max(305, window.innerHeight - 365) })}
      width={320}
      headerExtra={
        <>
          <button
            type="button"
            className="hud-win__pill-btn"
            onClick={() => seekDataTime(Math.max(telemetry.start, telemetry.end - 3.5), false)}
            title="Jump to terminal IR lock"
          >
            锁定
          </button>
          <div className="hud-win__seg">
            <button type="button" className={pal === "ironbow" ? "is-active" : ""} onClick={() => setPal("ironbow")}>IR</button>
            <button type="button" className={pal === "whitehot" ? "is-active" : ""} onClick={() => setPal("whitehot")}>WH</button>
            <button type="button" className={pal === "nvg" ? "is-active" : ""} onClick={() => setPal("nvg")}>NV</button>
          </div>
        </>
      }
      onExpand={() => useApp.getState().setSeekerOpen(true)}
      expandTitle={t("hudExpand")}
      onClose={onClose}
    >
      <canvas ref={canvasRef} className="hud-win__canvas" style={{ height: 185 }} />
      <div className="hud-win__foot" ref={footRef}>MWIR · STANDBY</div>
    </DraggableHudWindow>
  );
}

/* ========================================================================= */
/* 4) Unified Rich Telemetry Charts PiP Window (7 Tabs × Dual Stacked SVG)   */
/* ========================================================================= */
const SVG_W = 340;
const SVG_H = 88;

interface MiniPlotGroup {
  title: string;
  unit: string;
  lo: number;
  hi: number;
  series: { name: string; color: string; d: string; unit: string; hi: number }[];
}

function ChartsHudWindow({ telemetry, onClose }: { telemetry: Telemetry; onClose: () => void }) {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const [tab, setTab] = useState<PlotTab>("traj");
  const cursorARef = useRef<SVGLineElement>(null);
  const cursorBRef = useRef<SVGLineElement>(null);
  const footRef = useRef<HTMLDivElement>(null);

  const plots = useMemo<Record<PlotTab, [MiniPlotGroup, MiniPlotGroup]>>(() => {
    const step = Math.max(1, Math.ceil(telemetry.samples.length / 280));
    const rows = telemetry.samples.filter((_, i) => i % step === 0);
    const span = telemetry.end - telemetry.start || 1;

    const buildPlot = (
      title: string,
      unit: string,
      items: { name: string; color: string; unit?: string; fn: (s: (typeof rows)[number]) => number }[],
      sharedAxis = true,
    ): MiniPlotGroup => {
      if (sharedAxis) {
        let lo = Infinity, hi = -Infinity;
        for (const it of items) {
          for (const s of rows) {
            const v = it.fn(s);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (hi - lo < 1e-4) { lo -= 0.5; hi += 0.5; }
        const pad = (hi - lo) * 0.08;
        lo -= pad; hi += pad;
        const denom = Math.max(1e-6, hi - lo);
        return {
          title,
          unit,
          lo,
          hi,
          series: items.map((it) => {
            let sHi = -Infinity;
            const d = rows
              .map((s, i) => {
                const v = it.fn(s);
                if (v > sHi) sHi = v;
                const x = ((s.t - telemetry.start) / span) * SVG_W;
                const y = SVG_H - ((v - lo) / denom) * (SVG_H - 8) - 4;
                return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(" ");
            return { name: it.name, color: it.color, unit: it.unit ?? unit, hi: sHi, d };
          }),
        };
      }
      // Independently normalized curves when units differ (e.g. km + m/s)
      let firstLo = 0, firstHi = 1;
      const built = items.map((it, idx) => {
        let lo = Infinity, hi = -Infinity;
        for (const s of rows) {
          const v = it.fn(s);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (hi - lo < 1e-4) { lo -= 0.5; hi += 0.5; }
        if (idx === 0) { firstLo = lo; firstHi = hi; }
        const denom = Math.max(1e-6, hi - lo);
        const d = rows
          .map((s, i) => {
            const x = ((s.t - telemetry.start) / span) * SVG_W;
            const y = SVG_H - ((it.fn(s) - lo) / denom) * (SVG_H - 8) - 4;
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        return { name: it.name, color: it.color, unit: it.unit ?? "", hi, d };
      });
      return { title, unit, lo: firstLo, hi: firstHi, series: built };
    };

    const zh = lang === "zh";
    return {
      traj: [
        buildPlot(
          zh ? "高度与速度" : "Altitude & Speed",
          "km / m·s⁻¹",
          [
            { name: zh ? "高度" : "Alt", unit: "km", color: "#38bdf8", fn: (s) => s.altM / 1000 },
            { name: zh ? "速度" : "Vel", unit: "m/s", color: "#4ade80", fn: (s) => s.speedMS },
          ],
          false,
        ),
        buildPlot(
          zh ? "马赫数与弹目斜距" : "Mach & Slant Range",
          "Ma / km",
          [
            { name: "Mach", unit: "", color: "#fbbf24", fn: (s) => s.mach },
            { name: zh ? "斜距" : "Range", unit: "km", color: "#a78bfa", fn: (s) => s.rangeM / 1000 },
          ],
          false,
        ),
      ],
      aero: [
        buildPlot(
          zh ? "动压 q∞ 与过载 (实际/指令)" : "Dyn. Pressure & Load (Act/Cmd)",
          "kPa / g",
          [
            { name: "q∞", unit: "kPa", color: "#60a5fa", fn: (s) => s.qPa / 1000 },
            { name: zh ? "实际n" : "Load", unit: "g", color: "#f87171", fn: (s) => s.loadG },
            { name: zh ? "指令nc" : "Cmd", unit: "g", color: "#fbbf24", fn: (s) => s.loadCmdG },
          ],
          false,
        ),
        buildPlot(
          zh ? "攻角 α 与侧滑角 β" : "AoA α & Sideslip β",
          "deg",
          [
            { name: "α", color: "#38bdf8", fn: (s) => s.alphaDeg ?? 0 },
            { name: "β", color: "#fb923c", fn: (s) => s.betaDeg ?? 0 },
          ],
          true,
        ),
      ],
      ctrl: [
        buildPlot(
          zh ? "四通道尾舵偏转 δ" : "4-Channel Tail Fin Deflections",
          "deg",
          [
            { name: "up", color: "#38bdf8", fn: (s) => (s.finDeflectionsRad?.up ?? 0) * 57.2958 },
            { name: "down", color: "#fbbf24", fn: (s) => (s.finDeflectionsRad?.down ?? 0) * 57.2958 },
            { name: "left", color: "#4ade80", fn: (s) => (s.finDeflectionsRad?.left ?? 0) * 57.2958 },
            { name: "right", color: "#f472b6", fn: (s) => (s.finDeflectionsRad?.right ?? 0) * 57.2958 },
          ],
          true,
        ),
        buildPlot(
          zh ? "三轴角速率 p/q/r 与 DACS" : "Body Rates p/q/r & DACS",
          "°/s",
          [
            { name: "p", color: "#38bdf8", fn: (s) => (s.bodyRatesRadS?.p ?? 0) * 57.2958 },
            { name: "q", color: "#fb923c", fn: (s) => (s.bodyRatesRadS?.q ?? 0) * 57.2958 },
            { name: "r", color: "#4ade80", fn: (s) => (s.bodyRatesRadS?.r ?? 0) * 57.2958 },
          ],
          true,
        ),
      ],
      snr: [
        buildPlot(
          zh ? "双模导引头信噪比 (Radar / MWIR)" : "Dual-Mode SNR (Radar / MWIR)",
          "dB",
          [
            { name: "Radar", color: "#4ade80", fn: (s) => s.radarSnrDb ?? -60 },
            { name: "MWIR", color: "#fb923c", fn: (s) => s.irSnrDb ?? -60 },
            { name: "CFAR", color: "#fde047", fn: () => 13 },
          ],
          true,
        ),
        buildPlot(
          zh ? "目标 RCS σ 与导引头离轴角 FOV" : "Target RCS & Seeker Off-Boresight",
          "m² / °",
          [
            { name: "RCS", unit: "m²", color: "#38bdf8", fn: (s) => s.targetRcsM2 ?? 0.005 },
            { name: "FOV", unit: "°", color: "#c084fc", fn: (s) => s.fovDeg },
          ],
          false,
        ),
      ],
      tps: [
        buildPlot(
          zh ? "高超声速驻点气动热流 q̇s" : "Stagnation Heat Flux q̇s",
          "MW/m²",
          [{ name: "q̇s", color: "#f87171", fn: (s) => s.heatFluxMWm2 ?? 0 }],
          true,
        ),
        buildPlot(
          zh ? "瞬态壁温 Tw vs 辐射平衡壁温 Teq" : "Transient Tw vs Equilibrium Teq",
          "K",
          [
            { name: "Tw", color: "#fbbf24", fn: (s) => s.wallTempK ?? 288 },
            { name: "Teq", color: "#f472b6", fn: (s) => s.wallTempEqK ?? s.wallTempK ?? 288 },
          ],
          true,
        ),
      ],
      mass: [
        buildPlot(
          zh ? "实时弹体质量（含13s级间分离）" : "Vehicle Mass (w/ 13s Stage Sep)",
          "kg",
          [{ name: zh ? "质量" : "Mass", color: "#38bdf8", fn: (s) => s.massKg }],
          true,
        ),
        buildPlot(
          zh ? "质心 CG / 压心 CP 与静稳定裕度" : "CG / CP Station & Static Margin",
          "m",
          [
            { name: "CG", color: "#fbbf24", fn: (s) => s.cgPos ?? 4.2 },
            { name: "CP", color: "#38bdf8", fn: (s) => s.cpPos ?? 4.9 },
            { name: "SM", color: "#4ade80", fn: (s) => (s.cpPos ?? 4.9) - (s.cgPos ?? 4.2) },
          ],
          true,
        ),
      ],
      ecm: [
        buildPlot(
          zh ? "IMM 三模型滤波权重 (CV / CA / 3D-CT)" : "IMM 3-Model Filter Probabilities",
          "prob",
          [
            { name: "CV", color: "#38bdf8", fn: (s) => s.immPCv ?? 0.34 },
            { name: "CA", color: "#fb923c", fn: (s) => s.immPCa ?? 0.33 },
            { name: "3D-CT", color: "#4ade80", fn: (s) => s.immPCt ?? 0.33 },
          ],
          true,
        ),
        buildPlot(
          zh ? "诱饵对抗 / 不起动标志 / 近炸 Pk" : "Decoy / Unstart Flags & Fuze Pk",
          "0–1",
          [
            { name: "Decoy", color: "#fb923c", fn: (s) => s.decoyActive ?? 0 },
            { name: "Unstart", color: "#f87171", fn: (s) => s.unstartFlag ?? 0 },
            { name: "Pk", color: "#4ade80", fn: (s) => s.fuzePk ?? 0 },
          ],
          true,
        ),
      ],
    };
  }, [telemetry, lang]);

  useEffect(() => {
    let raf = 0;
    let lastDraw = 0;
    const span = telemetry.end - telemetry.start || 1;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (lastDraw > 0 && now - lastDraw < 40) return;
      lastDraw = now;
      const curT = dataClock.t;
      const x = ((Math.max(telemetry.start, Math.min(telemetry.end, curT)) - telemetry.start) / span) * SVG_W;
      for (const ref of [cursorARef, cursorBRef]) {
        if (ref.current) {
          ref.current.setAttribute("x1", x.toFixed(1));
          ref.current.setAttribute("x2", x.toFixed(1));
        }
      }
      const ms = sampleAt(curT);
      if (ms && footRef.current) {
        if (tab === "traj") {
          footRef.current.textContent = `H ${(ms.altM / 1000).toFixed(2)}km · V ${ms.speedMS.toFixed(0)}m/s · Ma ${ms.mach.toFixed(2)} · R ${(ms.rangeM / 1000).toFixed(1)}km`;
        } else if (tab === "aero") {
          footRef.current.textContent = `q∞ ${(ms.qPa / 1000).toFixed(1)}kPa · n ${ms.loadG.toFixed(1)}/${ms.loadCmdG.toFixed(1)}g · α ${(ms.alphaDeg ?? 0).toFixed(1)}° β ${(ms.betaDeg ?? 0).toFixed(1)}°`;
        } else if (tab === "ctrl") {
          footRef.current.textContent = `δu ${((ms.finDeflectionsRad?.up ?? 0) * 57.3).toFixed(1)}° δr ${((ms.finDeflectionsRad?.right ?? 0) * 57.3).toFixed(1)}° · q ${((ms.bodyRatesRadS?.q ?? 0) * 57.3).toFixed(1)}°/s`;
        } else if (tab === "snr") {
          footRef.current.textContent = `Radar ${(ms.radarSnrDb ?? -60).toFixed(1)}dB · IIR ${(ms.irSnrDb ?? -60).toFixed(1)}dB · σ ${(ms.targetRcsM2 ?? 0.005).toFixed(4)}m²`;
        } else if (tab === "tps") {
          footRef.current.textContent = `q̇s ${(ms.heatFluxMWm2 ?? 0).toFixed(2)}MW/m² · Tw ${(ms.wallTempK ?? 288).toFixed(0)}K · Teq ${(ms.wallTempEqK ?? ms.wallTempK ?? 288).toFixed(0)}K`;
        } else if (tab === "mass") {
          const cg = ms.cgPos ?? 4.2, cp = ms.cpPos ?? 4.9;
          footRef.current.textContent = `m ${ms.massKg.toFixed(0)}kg · CG ${cg.toFixed(2)}m · CP ${cp.toFixed(2)}m · SM +${(cp - cg).toFixed(2)}m`;
        } else {
          footRef.current.textContent = `CV ${((ms.immPCv ?? 0.34) * 100).toFixed(0)}% CA ${((ms.immPCa ?? 0.33) * 100).toFixed(0)}% CT ${((ms.immPCt ?? 0.33) * 100).toFixed(0)}% · Decoy ${(ms.decoyActive ?? 0) > 0.5 ? "ON" : "OFF"}`;
        }
      }
    };
    tick(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [telemetry, tab]);

  const [plotA, plotB] = plots[tab];
  const tabs: [PlotTab, string, string][] = [
    ["traj", "弹道", "Traj"],
    ["aero", "气动", "Aero"],
    ["ctrl", "姿控", "Ctrl"],
    ["snr", "感知", "SNR"],
    ["tps", "气动热", "TPS"],
    ["mass", "质量", "Mass"],
    ["ecm", "对抗", "IMM"],
  ];

  const onClickSvg = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekDataTime(telemetry.start + frac * (telemetry.end - telemetry.start));
  };

  const renderSubPlot = (p: MiniPlotGroup, cRef: React.RefObject<SVGLineElement | null>) => {
    const dec = Math.abs(p.hi) >= 100 ? 0 : Math.abs(p.hi) >= 10 ? 1 : 2;
    return (
      <div className="hud-win__subplot">
        <div className="hud-win__subplot-head">
          <span>{p.title}</span>
          <em>{p.unit}</em>
        </div>
        <div className="hud-win__svg-wrap">
          <svg
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            preserveAspectRatio="none"
            className="hud-win__svg hud-win__svg--sm"
            onClick={onClickSvg}
          >
            {[0.25, 0.5, 0.75].map((r) => (
              <line key={r} x1={0} x2={SVG_W} y1={SVG_H * r} y2={SVG_H * r} stroke="rgba(120,165,205,0.15)" strokeWidth={1} />
            ))}
            {p.series.map((s) => (
              <path key={s.name} d={s.d} fill="none" stroke={s.color} strokeWidth={1.45} vectorEffect="non-scaling-stroke" />
            ))}
            <line ref={cRef} x1={0} x2={0} y1={0} y2={SVG_H} stroke="#fbbf24" strokeWidth={1.3} strokeDasharray="3 2" />
          </svg>
          <span className="hud-win__ymax">{p.hi.toFixed(dec)}</span>
          <span className="hud-win__ymin">{p.lo.toFixed(dec)}</span>
        </div>
        <div className="hud-win__legend">
          {p.series.map((s) => (
            <span key={s.name} style={{ color: s.color }}>
              ● {s.name} ({s.hi >= 100 ? s.hi.toFixed(0) : s.hi.toFixed(1)}{s.unit})
            </span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <DraggableHudWindow
      winKey="charts"
      icon="📈"
      title={t("hudChartsTitle")}
      defaultPos={() => ({ x: 18, y: Math.max(306, window.innerHeight - 404) })}
      width={356}
      headerExtra={
        <button
          type="button"
          className="hud-win__pill-btn"
          onClick={() => useApp.getState().setChartsOpen(true)}
          title={t("hudExpand")}
        >
          {lang === "zh" ? "全屏18图" : "All 18"}
        </button>
      }
      onExpand={() => useApp.getState().setChartsOpen(true)}
      expandTitle={t("hudExpand")}
      onClose={onClose}
    >
      <div className="hud-win__tabs">
        {tabs.map(([id, zh, en]) => (
          <button key={id} type="button" className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>
            {lang === "zh" ? zh : en}
          </button>
        ))}
      </div>
      <div className="hud-win__plots">
        {renderSubPlot(plotA, cursorARef)}
        {renderSubPlot(plotB, cursorBRef)}
      </div>
      <div className="hud-win__foot" ref={footRef}>LIVE TELEMETRY</div>
    </DraggableHudWindow>
  );
}

/* ========================================================================= */
/* Root Multi-Window HUD Manager                                             */
/* ========================================================================= */
export function HudWindows() {
  const telemetry = useApp((s) => s.telemetry);
  const hudSpace = useApp((s) => s.hudSpace);
  const hudRadar = useApp((s) => s.hudRadar);
  const hudIr = useApp((s) => s.hudIr);
  const hudCharts = useApp((s) => s.hudCharts);
  const setHudSpace = useApp((s) => s.setHudSpace);
  const setHudRadar = useApp((s) => s.setHudRadar);
  const setHudIr = useApp((s) => s.setHudIr);
  const setHudCharts = useApp((s) => s.setHudCharts);

  if (!telemetry) return null;
  if (!hudSpace && !hudRadar && !hudIr && !hudCharts) return null;

  return (
    <div className="hud-windows">
      {hudSpace && <SpaceHudWindow telemetry={telemetry} onClose={() => setHudSpace(false)} />}
      {hudRadar && <RadarHudWindow telemetry={telemetry} onClose={() => setHudRadar(false)} />}
      {hudIr && <IrHudWindow telemetry={telemetry} onClose={() => setHudIr(false)} />}
      {hudCharts && <ChartsHudWindow telemetry={telemetry} onClose={() => setHudCharts(false)} />}
    </div>
  );
}
