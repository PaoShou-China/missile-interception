import { useEffect, useMemo, useRef } from "react";
import type { ScenarioManifest, TrajectorySample } from "../scientific/types";
import { useI18n } from "../i18n";

/** Simplified East-Asia coastline polylines [lonDeg, latDeg] for SBIRS theater map. */
const COASTLINES: [number, number][][] = [
  // Mainland China coast (Bohai -> Shandong -> Jiangsu -> Zhejiang -> Fujian -> Guangdong)
  [
    [117.7, 39.0], [119.5, 39.9], [121.6, 38.9], [122.4, 39.6], [124.2, 39.9],
    [122.1, 37.5], [122.7, 37.0], [120.4, 36.1], [119.5, 35.1], [120.3, 34.4],
    [121.9, 31.4], [121.5, 30.2], [122.2, 29.8], [121.4, 28.0], [120.5, 27.1],
    [119.6, 26.0], [118.2, 24.5], [116.7, 23.4], [114.2, 22.3],
  ],
  // Korean Peninsula
  [
    [124.4, 39.8], [125.3, 38.6], [126.6, 37.5], [126.4, 35.8], [126.5, 34.6],
    [128.8, 35.1], [129.5, 36.0], [129.1, 37.6], [127.6, 39.3], [129.8, 41.8],
  ],
  // Kyushu / Western Japan / Ryukyu arc
  [
    [130.9, 34.0], [131.6, 33.2], [131.4, 31.4], [130.5, 31.0], [129.9, 32.8], [130.9, 34.0],
  ],
  [[128.0, 26.8], [127.7, 26.1], [125.3, 24.8], [124.2, 24.3]],
  // Taiwan
  [
    [121.5, 25.3], [121.9, 25.0], [121.6, 23.6], [120.8, 22.0], [120.2, 22.7], [120.1, 23.8], [121.0, 25.0], [121.5, 25.3],
  ],
];

function sampleAtTime(samples: TrajectorySample[], t: number): TrajectorySample {
  if (samples.length === 0) {
    throw new Error("Empty sample list");
  }
  if (t <= samples[0].t) return samples[0];
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1];
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(samples[hi].t - t) < Math.abs(t - samples[lo].t) ? samples[hi] : samples[lo];
}

export function SpaceBasedCard({
  manifest,
  missile,
  target,
  time,
  onSeek,
  theme = "dark",
}: {
  manifest: ScenarioManifest;
  missile: TrajectorySample[];
  target: TrajectorySample[];
  time?: number;
  onSeek?: (t: number) => void;
  theme?: "dark" | "light";
}) {
  const { lang } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isLight = theme === "light";

  // Precompute cumulative horizontal ground range (km) for altitude profile.
  const downrangeKm = useMemo(() => {
    const out = new Float64Array(missile.length);
    const lat0 = (missile[0]?.latDeg ?? 40) * (Math.PI / 180);
    const lon0 = (missile[0]?.lonDeg ?? 110) * (Math.PI / 180);
    for (let i = 0; i < missile.length; i++) {
      const lat = missile[i].latDeg * (Math.PI / 180);
      const lon = missile[i].lonDeg * (Math.PI / 180);
      const dlat = lat - lat0;
      const dlon = lon - lon0;
      const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat0) * Math.cos(lat) * Math.sin(dlon / 2) ** 2;
      out[i] = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    }
    return out;
  }, [missile]);

  const curT = time ?? (missile[missile.length - 1]?.t ?? 0);
  const mCur = useMemo(() => sampleAtTime(missile, curT), [missile, curT]);
  const tCur = useMemo(() => (target.length ? sampleAtTime(target, curT) : null), [target, curT]);

  // Bounding box for East-Asia theater projection
  const bounds = useMemo(() => {
    let minLon = 107, maxLon = 131, minLat = 24, maxLat = 43;
    for (const s of missile) {
      if (s.lonDeg - 2 < minLon) minLon = s.lonDeg - 2;
      if (s.lonDeg + 2 > maxLon) maxLon = s.lonDeg + 2;
      if (s.latDeg - 2 < minLat) minLat = s.latDeg - 2;
      if (s.latDeg + 2 > maxLat) maxLat = s.latDeg + 2;
    }
    return { minLon, maxLon, minLat, maxLat };
  }, [missile]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !missile.length) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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
    const profY = mapH + 8;
    const profH = H - profY - 6;

    // 1. Background
    ctx.fillStyle = isLight ? "#f4f8fc" : "#060e1a";
    ctx.fillRect(0, 0, W, H);

    const padL = 36, padR = 14, padT = 18, padB = 18;
    const mw = W - padL - padR;
    const mh = mapH - padT - padB;

    const projX = (lon: number) => padL + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * mw;
    const projY = (lat: number) => padT + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * mh;

    // 2. Ocean/Land tint & Lat/Lon Graticule
    ctx.fillStyle = isLight ? "#e6f1fa" : "#08172a";
    ctx.fillRect(padL, padT, mw, mh);

    ctx.strokeStyle = isLight ? "rgba(11,49,92,0.10)" : "rgba(95,165,220,0.12)";
    ctx.lineWidth = 1;
    ctx.font = "9.5px ui-monospace, monospace";
    ctx.fillStyle = isLight ? "rgba(11,49,92,0.58)" : "rgba(150,195,230,0.6)";
    for (let lon = Math.ceil(bounds.minLon / 4) * 4; lon <= bounds.maxLon; lon += 4) {
      const x = projX(lon);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + mh);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(`${lon}°E`, x, padT + mh + 12);
    }
    for (let lat = Math.ceil(bounds.minLat / 4) * 4; lat <= bounds.maxLat; lat += 4) {
      const y = projY(lat);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + mw, y);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(`${lat}°N`, padL - 4, y + 3);
    }

    // 3. Simplified East-Asia Coastlines
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, mw, mh);
    ctx.clip();

    ctx.strokeStyle = isLight ? "rgba(15,76,129,0.34)" : "rgba(92,168,214,0.36)";
    ctx.lineWidth = 1.25;
    for (const poly of COASTLINES) {
      ctx.beginPath();
      poly.forEach(([lon, lat], idx) => {
        const x = projX(lon);
        const y = projY(lat);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // 4. SBIRS GEO/LEO Early-Warning Satellite Swath & Scan Footprint
    const satLon = 117.5 + 2.4 * Math.sin(curT * 0.005);
    const satLat = 34.5 + 1.2 * Math.cos(curT * 0.004);
    const sx = projX(satLon);
    const sy = projY(satLat);
    const swathRx = mw * 0.44;
    const swathRy = mh * 0.46;
    ctx.strokeStyle = isLight ? "rgba(14,116,144,0.28)" : "rgba(56,189,248,0.26)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.ellipse(sx, sy, swathRx, swathRy, -0.18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // SBIRS detection beam to missile during boost/midcourse
    const mx = projX(mCur.lonDeg);
    const my = projY(mCur.latDeg);
    ctx.strokeStyle = mCur.phase === "boost"
      ? "rgba(255,107,74,0.55)"
      : (isLight ? "rgba(14,116,144,0.22)" : "rgba(56,189,248,0.22)");
    ctx.lineWidth = mCur.phase === "boost" ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(mx, my);
    ctx.stroke();

    // Satellite icon
    ctx.fillStyle = isLight ? "#0369a1" : "#38bdf8";
    ctx.fillRect(sx - 3, sy - 3, 6, 6);
    ctx.strokeStyle = isLight ? "#0369a1" : "#7dd3fc";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(sx - 11, sy); ctx.lineTo(sx - 4, sy);
    ctx.moveTo(sx + 4, sy); ctx.lineTo(sx + 11, sy);
    ctx.stroke();
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      mCur.phase === "boost" ? "SBIRS-GEO · BOOST IR ALERT" : "SBIRS-LEO/GEO TRACK",
      sx + 13,
      sy + 3,
    );

    // 5. Target full track (dashed cyan)
    if (target.length > 1) {
      ctx.strokeStyle = isLight ? "rgba(8,145,178,0.55)" : "rgba(56,189,248,0.55)";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      target.forEach((p, idx) => {
        const x = projX(p.lonDeg);
        const y = projY(p.latDeg);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 6. Missile full reference ground-track (dim) + flown phase-colored ground-track
    ctx.strokeStyle = isLight ? "rgba(11,49,92,0.18)" : "rgba(180,210,240,0.18)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    missile.forEach((p, idx) => {
      const x = projX(p.lonDeg);
      const y = projY(p.latDeg);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const phaseColor = (ph: string) =>
      ph === "boost" ? "#ef4444" : ph === "terminal" ? "#f59e0b" : (isLight ? "#005bac" : "#38bdf8");

    ctx.lineWidth = 2.3;
    for (let i = 1; i < missile.length; i++) {
      const p0 = missile[i - 1];
      const p1 = missile[i];
      if (p0.t > curT) break;
      ctx.strokeStyle = phaseColor(p1.phase);
      ctx.beginPath();
      ctx.moveTo(projX(p0.lonDeg), projY(p0.latDeg));
      ctx.lineTo(projX(p1.lonDeg), projY(p1.latDeg));
      ctx.stroke();
    }

    // 7. Handover gate ring & Intercept marker
    const lastM = missile[missile.length - 1];
    const ix = projX(lastM.lonDeg);
    const iy = projY(lastM.latDeg);
    ctx.strokeStyle = "rgba(245,158,11,0.55)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(ix, iy, 12, 0, Math.PI * 2);
    ctx.stroke();

    // Launch beacon
    const lx = projX(manifest.launchSite.lonDeg);
    const ly = projY(manifest.launchSite.latDeg);
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(lx, ly, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = isLight ? "#0b315c" : "#d8eeff";
    ctx.font = "9.5px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(lang === "zh" ? "发射阵地" : "LAUNCH", lx + 6, ly - 4);

    // Live target marker + LOS
    if (tCur) {
      const tx = projX(tCur.lonDeg);
      const ty = projY(tCur.latDeg);
      ctx.strokeStyle = "rgba(245,158,11,0.38)";
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 1.6;
      ctx.strokeRect(tx - 4.5, ty - 4.5, 9, 9);
      ctx.fillStyle = isLight ? "#0e7490" : "#67e8f9";
      ctx.fillText("F-35A", tx + 7, ty + 3);
    }

    // Live missile marker + boost plume ring
    if (mCur.phase === "boost") {
      ctx.fillStyle = "rgba(255,107,74,0.28)";
      ctx.beginPath();
      ctx.arc(mx, my, 11, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#ff6b4a";
    ctx.beginPath();
    ctx.arc(mx, my, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.3;
    ctx.stroke();

    ctx.restore();

    // Map border & HUD banner
    ctx.strokeStyle = isLight ? "rgba(11,49,92,0.24)" : "rgba(120,175,220,0.28)";
    ctx.strokeRect(padL, padT, mw, mh);
    ctx.fillStyle = isLight ? "#0b315c" : "#cfe9ff";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      `LAT ${mCur.latDeg.toFixed(2)}°N · LON ${mCur.lonDeg.toFixed(2)}°E · ALT ${(mCur.altM / 1000).toFixed(1)} km · R ${(mCur.rangeM / 1000).toFixed(1)} km`,
      padL + 6,
      padT + 12,
    );

    // 8. Bottom Altitude vs Downrange Vertical Profile
    if (profH > 26) {
      const pL = padL;
      const pW = mw;
      const maxDr = Math.max(downrangeKm[downrangeKm.length - 1] || 1660, 100);
      const maxAlt = 36;
      ctx.fillStyle = isLight ? "#eef5fb" : "#071323";
      ctx.fillRect(pL, profY, pW, profH);
      ctx.strokeStyle = isLight ? "rgba(11,49,92,0.2)" : "rgba(120,175,220,0.22)";
      ctx.strokeRect(pL, profY, pW, profH);

      const drX = (dr: number) => pL + (dr / maxDr) * pW;
      const altY = (km: number) => profY + profH - (Math.max(0, Math.min(maxAlt, km)) / maxAlt) * (profH - 12) - 4;

      // Full profile curve
      ctx.strokeStyle = isLight ? "rgba(0,91,172,0.25)" : "rgba(56,189,248,0.25)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let i = 0; i < missile.length; i++) {
        const x = drX(downrangeKm[i]);
        const y = altY(missile[i].altM / 1000);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Flown profile fill + stroke
      let curIdx = 0;
      ctx.strokeStyle = isLight ? "#005bac" : "#38bdf8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < missile.length; i++) {
        if (missile[i].t > curT) break;
        curIdx = i;
        const x = drX(downrangeKm[i]);
        const y = altY(missile[i].altM / 1000);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Target altitude reference line
      const tgtAltKm = (tCur?.altM ?? manifest.targetSite.altM) / 1000;
      const tyLine = altY(tgtAltKm);
      ctx.strokeStyle = "rgba(34,211,238,0.45)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pL, tyLine);
      ctx.lineTo(pL + pW, tyLine);
      ctx.stroke();
      ctx.setLineDash([]);

      // Current marker on profile
      const cx = drX(downrangeKm[curIdx]);
      const cy = altY(mCur.altM / 1000);
      ctx.fillStyle = "#ff6b4a";
      ctx.beginPath();
      ctx.arc(cx, cy, 3.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = isLight ? "rgba(11,49,92,0.7)" : "rgba(165,210,245,0.78)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(
        lang === "zh"
          ? `纵剖面 · 航程 ${downrangeKm[curIdx].toFixed(0)}/${maxDr.toFixed(0)} km · 高度 ${(mCur.altM / 1000).toFixed(1)} km`
          : `PROFILE · DR ${downrangeKm[curIdx].toFixed(0)}/${maxDr.toFixed(0)} km · ALT ${(mCur.altM / 1000).toFixed(1)} km`,
        pL + 6,
        profY + 11,
      );
    }
  }, [missile, target, mCur, tCur, curT, bounds, downrangeKm, isLight, lang, manifest]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek || !missile.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const mapH = rect.height * 0.68;
    const padL = 36, padR = 14, padT = 18, padB = 18;
    const mw = rect.width - padL - padR;
    const mh = mapH - padT - padB;
    if (y > mapH) {
      // Click on altitude profile -> seek by downrange fraction
      const frac = Math.max(0, Math.min(1, (x - padL) / Math.max(mw, 1)));
      const targetDr = frac * (downrangeKm[downrangeKm.length - 1] || 1);
      let best = 0;
      let bestErr = Infinity;
      for (let i = 0; i < downrangeKm.length; i++) {
        const d = Math.abs(downrangeKm[i] - targetDr);
        if (d < bestErr) {
          bestErr = d;
          best = i;
        }
      }
      onSeek(missile[best].t);
      return;
    }
    // Click on ground-track map -> find nearest sample
    let best = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < missile.length; i++) {
      const px = padL + ((missile[i].lonDeg - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * mw;
      const py = padT + ((bounds.maxLat - missile[i].latDeg) / (bounds.maxLat - bounds.minLat)) * mh;
      const d2 = (px - x) ** 2 + (py - y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    onSeek(missile[best].t);
  };

  return (
    <div className={`sensor-card ${isLight ? "sensor-card--light" : ""}`}>
      <div className="sensor-card__head">
        <span>
          {lang === "zh"
            ? "天基预警与战区轨下点态势（SBIRS + 高度纵剖面）"
            : "Space-Based SBIRS Theater Track & Altitude Profile"}
        </span>
        <em>
          {mCur.phase.toUpperCase()} · Ma {mCur.mach.toFixed(2)}
        </em>
      </div>
      <canvas
        ref={canvasRef}
        className="sensor-card__canvas sensor-card__canvas--tall"
        onClick={handleClick}
        title={lang === "zh" ? "点击轨迹或纵剖面可跳转到对应时刻" : "Click track or profile to seek time"}
      />
    </div>
  );
}
