"""Self-contained interactive HTML dashboard for the intercept simulation.

Matplotlib is optional in this project and some environments ship a
matplotlib build that is binary-incompatible with the installed NumPy.  This
module therefore writes a single dependency-free HTML file: the telemetry is
embedded as JSON and drawn with the browser canvas API.

The result is one file (``output/intercept_dashboard.html``) with six compact
panels: ground track, altitude, speed/Mach, load factor, fin deflections and
range / seeker LOS.
"""

import json
import os
import numpy as np
import config as C
import math_utils as MU


def _index_subset(n, max_points=1600):
    """Evenly spaced sample indices (keeps the HTML file small)."""
    if n <= max_points:
        return np.arange(n)
    return np.unique(np.linspace(0, n - 1, max_points, dtype=int))


def _round_list(values, digits=4):
    return [round(float(v), digits) for v in values]


def build_payload(sim):
    """Extract and downsample the telemetry arrays for the dashboard."""
    tel = sim.telemetry.as_dict()
    n = len(tel["time"])
    if n == 0:
        return None
    idx = _index_subset(n)

    r0 = MU.llh_to_eci(sim.scenario.launch_lat, sim.scenario.launch_lon,
                       sim.scenario.launch_alt, 0.0)
    enu = MU.local_enu_dcm(sim.scenario.launch_lat, sim.scenario.launch_lon, 0.0)
    rm = np.column_stack([tel["m_rx"], tel["m_ry"], tel["m_rz"]]) - r0
    rt = np.column_stack([tel["t_rx"], tel["t_ry"], tel["t_rz"]]) - r0
    em = rm.dot(enu) / 1000.0
    et = rt.dot(enu) / 1000.0

    speed = np.sqrt(tel["m_vx"] ** 2 + tel["m_vy"] ** 2 + tel["m_vz"] ** 2)
    talt = np.array([MU.altitude(r) for r in np.column_stack(
        [tel["t_rx"], tel["t_ry"], tel["t_rz"]])]) / 1000.0
    acmd = np.sqrt(tel["a_cmd_x"] ** 2 + tel["a_cmd_y"] ** 2
                   + tel["a_cmd_z"] ** 2) / C.G0
    aact = np.sqrt(tel["a_act_x"] ** 2 + tel["a_act_y"] ** 2
                   + tel["a_act_z"] ** 2) / C.G0
    rng = tel["range"] / 1000.0
    fov = np.degrees(tel["fov_angle"])

    closest = int(np.argmin(tel["range"]))
    payload = {
        "meta": {
            "miss": float(sim.miss_distance),
            "t_miss": float(sim.miss_time),
            "cpu": float(sim.cpu_time),
            "frames": int(sim.telemetry.n),
            "integrator": "native RK4",
        },
        "time": _round_list(tel["time"][idx], 3),
        "alt": _round_list(tel["alt"][idx] / 1000.0, 4),
        "talt": _round_list(talt[idx], 4),
        "speed": _round_list(speed[idx], 2),
        "mach": _round_list(tel["mach"][idx], 4),
        "acmd": _round_list(acmd[idx], 4),
        "aact": _round_list(aact[idx], 4),
        "fin": [
            _round_list(np.degrees(tel[k][idx]), 4)
            for k in ("fin_up", "fin_down", "fin_left", "fin_right")
        ],
        "range": _round_list(rng[idx], 4),
        "los": _round_list(fov[idx], 4),
        "fov_limit": float(np.degrees(C.SEEKER_FOV)),
        "east": _round_list(em[idx, 0], 4),
        "north": _round_list(em[idx, 1], 4),
        "teast": _round_list(et[idx, 0], 4),
        "tnorth": _round_list(et[idx, 1], 4),
        "closest": {
            "east": float(em[closest, 0]),
            "north": float(em[closest, 1]),
            "range_km": float(rng[closest]),
        },
        "phase": [int(v) for v in tel["phase"][idx]],
        "handover": [int(v) for v in tel["handover"][idx]],
        "lock": [int(v) for v in tel["seeker_lock"][idx]],
    }
    return payload


def write_dashboard(sim, out_dir=None):
    """Write ``intercept_dashboard.html`` and return its absolute path."""
    payload = build_payload(sim)
    if payload is None:
        print("No telemetry data; skipping dashboard")
        return None

    out_dir = out_dir or sim.cfg.output_dir
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    path = os.path.join(out_dir, "intercept_dashboard.html")
    meta = payload["meta"]

    html = _HTML_TEMPLATE.replace("__DATA__", json.dumps(payload, separators=(",", ":")))
    html = html.replace("__MISS__", "%.2f" % meta["miss"])
    html = html.replace("__TMISS__", "%.2f" % meta["t_miss"])
    html = html.replace("__CPU__", "%.2f" % meta["cpu"])
    html = html.replace("__FRAMES__", "%d" % meta["frames"])
    html = html.replace("__INTEGRATOR__", meta["integrator"])

    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print("Dashboard saved: %s" % os.path.abspath(path))
    return os.path.abspath(path)


_HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Intercept Dashboard</title>
<style>
  :root { --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --bg:#f6f7f9; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  header { padding:16px 20px 6px; }
  h1 { margin:0 0 6px; font-size:18px; font-weight:650; }
  .stats { display:flex; flex-wrap:wrap; gap:18px; color:var(--muted); font-size:12px; }
  .stats b { color:var(--ink); font-weight:600; }
  .head-row { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
  .lang { display:flex; gap:6px; }
  .lang button {
    font:inherit; font-size:12px; padding:4px 10px; border-radius:999px;
    border:1px solid var(--line); background:#fff; color:var(--muted); cursor:pointer;
  }
  .lang button.active { color:#fff; background:var(--ink); border-color:var(--ink); }
  .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr));
          gap:14px; padding:14px 20px 22px; }
  .card { position:relative; background:#fff; border:1px solid var(--line);
          border-radius:10px; padding:10px 10px 6px;
          box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .card h2 { margin:0 0 4px; font-size:12px; font-weight:600; color:var(--ink); }
  canvas { width:100%; height:220px; display:block; }
  .tip { position:absolute; pointer-events:none; z-index:5; display:none;
         background:rgba(17,24,39,.92); color:#fff; padding:6px 8px;
         border-radius:6px; font-size:11px; line-height:1.45; white-space:nowrap; }
  footer { padding:0 20px 18px; color:var(--muted); font-size:11px; }
  @media (max-width:1100px) { .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:700px) { .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <div class="head-row">
    <h1 id="title"></h1>
  </div>
  <div class="stats" id="stats"></div>
</header>
<div class="grid" id="grid"></div>
<footer id="footer"></footer>
<script>
const D = __DATA__;

const TEXT = {
  title: "2000 km-class interceptor · mission dashboard",
  miss: "Miss distance", tmiss: "Closest approach", cpu: "CPU", frames: "Frames", integ: "Integrator",
  footer: "Hover a chart to read values. Data are downsampled for display; CSV keeps every frame.",
  ground: "Ground track (launch-centred ENU)", missile: "Missile", target: "Target",
  east: "East (km)", north: "North (km)", closest: "closest",
  alt: "Altitude profile", altY: "Altitude (km)", time: "Time (s)",
  speed: "Speed and Mach", speedName: "Speed", speedY: "Speed (m/s)", mach: "Mach",
  load: "Load factor", cmd: "Commanded", act: "Actual", loadY: "Load factor (g)",
  fins: "Fin deflections", up: "Up", down: "Down", left: "Left", right: "Right",
  finY: "Deflection (deg)",
  rng: "Range and seeker LOS", range: "Range", los: "LOS", fov: "FOV limit",
  rangeY: "Range (km)", losY: "LOS (deg)"
};
function T(key) { return TEXT[key]; }
function renderStatic() {
  document.getElementById("title").textContent = T("title");
  document.getElementById("stats").innerHTML =
    "<span>" + T("miss") + " <b>__MISS__ m</b></span>" +
    "<span>" + T("tmiss") + " <b>__TMISS__ s</b></span>" +
    "<span>" + T("cpu") + " <b>__CPU__ s</b></span>" +
    "<span>" + T("frames") + " <b>__FRAMES__</b></span>" +
    "<span>" + T("integ") + " <b>__INTEGRATOR__</b></span>";
  document.getElementById("footer").textContent = T("footer");
  document.documentElement.lang = "en";
}


const COLORS = {
  blue:"#2563eb", red:"#dc2626", green:"#16a34a",
  orange:"#f59e0b", purple:"#7c3aed", gray:"#6b7280", teal:"#0d9488"
};

function makeCard(title) {
  const card = document.createElement("div");
  card.className = "card";
  const h = document.createElement("h2");
  h.textContent = title;
  const c = document.createElement("canvas");
  const tip = document.createElement("div");
  tip.className = "tip";
  card.appendChild(h); card.appendChild(c); card.appendChild(tip);
  document.getElementById("grid").appendChild(card);
  return {card, canvas:c, tip};
}

function extent(xs) {
  let lo = Infinity, hi = -Infinity;
  for (let i=0;i<xs.length;i++) { const v=xs[i]; if(v<lo)lo=v; if(v>hi)hi=v; }
  if (!isFinite(lo)) { lo=0; hi=1; }
  if (hi === lo) { hi = lo + 1; }
  return [lo, hi];
}

function niceTicks(lo, hi, n) {
  const span = hi - lo;
  if (!isFinite(span) || span <= 0) return [lo];
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function fmtTick(v) {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function drawChart(canvas, opts) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(rect.width, 240), H = Math.max(rect.height, 160);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const padL = 46, padR = opts.hasRight ? 46 : 12, padT = 10, padB = 30;
  const plotW = Math.max(20, W - padL - padR);
  const plotH = Math.max(20, H - padT - padB);

  const xs = opts.x;
  let [xmin, xmax] = opts.xlim || extent(xs);
  let leftSeries = opts.series.filter(s => (s.axis || "left") === "left");
  let rightSeries = opts.series.filter(s => s.axis === "right");

  let ymin = Infinity, ymax = -Infinity;
  for (const s of leftSeries) for (const v of s.y) { if(v<ymin)ymin=v; if(v>ymax)ymax=v; }
  if (!isFinite(ymin)) { ymin=0; ymax=1; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const yPad = (ymax - ymin) * 0.08; ymin -= yPad; ymax += yPad;

  let rmin = Infinity, rmax = -Infinity;
  for (const s of rightSeries) for (const v of s.y) { if(v<rmin)rmin=v; if(v>rmax)rmax=v; }
  if (!isFinite(rmin)) { rmin=0; rmax=1; }
  if (rmin === rmax) { rmin -= 1; rmax += 1; }
  const rPad = (rmax - rmin) * 0.08; rmin -= rPad; rmax += rPad;

  if (opts.equal) {
    const xc = (xmin + xmax) / 2, yc = (ymin + ymax) / 2;
    const span = Math.max(xmax - xmin, ymax - ymin);
    xmin = xc - span / 2; xmax = xc + span / 2;
    ymin = yc - span / 2; ymax = yc + span / 2;
  }

  const X = v => padL + (v - xmin) / (xmax - xmin) * plotW;
  const Y = v => padT + plotH - (v - ymin) / (ymax - ymin) * plotH;
  const R = v => padT + plotH - (v - rmin) / (rmax - rmin) * plotH;

  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  ctx.fillStyle = "#6b7280"; ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const xticks = niceTicks(xmin, xmax, 5);
  for (const t of xticks) {
    const px = X(t);
    ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH); ctx.stroke();
    ctx.fillText(fmtTick(t), px, padT + plotH + 5);
  }
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const yticks = niceTicks(ymin, ymax, 5);
  for (const t of yticks) {
    const py = Y(t);
    ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py); ctx.stroke();
    ctx.fillText(fmtTick(t), padL - 6, py);
  }
  if (opts.hasRight) {
    ctx.textAlign = "left";
    for (const t of niceTicks(rmin, rmax, 5)) {
      ctx.fillText(fmtTick(t), padL + plotW + 6, R(t));
    }
    ctx.save();
    ctx.translate(W - 10, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(opts.y2label || "", 0, 0);
    ctx.restore();
  }

  ctx.strokeStyle = "#9ca3af";
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();

  // Series
  for (const s of opts.series) {
    const py = (s.axis === "right") ? R : Y;
    ctx.strokeStyle = s.color || COLORS.blue;
    ctx.lineWidth = s.width || 1.5;
    ctx.setLineDash(s.dash ? [5, 4] : []);
    ctx.beginPath();
    let started = false;
    for (let i=0;i<xs.length;i++) {
      const v = s.y[i];
      if (!isFinite(v)) { started = false; continue; }
      const px = X(xs[i]), yy = py(v);
      if (!started) { ctx.moveTo(px, yy); started = true; }
      else ctx.lineTo(px, yy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (opts.markers) {
    for (const m of opts.markers) {
      ctx.fillStyle = m.color || COLORS.orange;
      ctx.beginPath(); ctx.arc(X(m.x), Y(m.y), m.r || 5, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      if (m.label) {
        ctx.fillStyle = "#374151"; ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(m.label, X(m.x) + 7, Y(m.y) - 5);
      }
    }
  }

  // Legend
  let lx = padL + 6, ly = padT + 6;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (const s of opts.series) {
    ctx.strokeStyle = s.color || COLORS.blue;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.dash ? [4, 3] : []);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#374151";
    const label = s.name || "";
    ctx.fillText(label, lx + 21, ly);
    lx += 23 + ctx.measureText(label).width;
  }

  // Axis labels
  ctx.fillStyle = "#6b7280";
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText(opts.xlabel || "", padL + plotW / 2, H - 2);
  if (opts.ylabel) {
    ctx.save();
    ctx.translate(10, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(opts.ylabel, 0, 0);
    ctx.restore();
  }

  canvas._chart = {opts, X, Y, R, xs, padL, padT, plotW, plotH, xmin, xmax};
}

function installHover(canvas, tip) {
  canvas.addEventListener("mousemove", ev => {
    const ch = canvas._chart;
    if (!ch || !ch.opts.hover) { tip.style.display = "none"; return; }
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    if (mx < ch.padL || mx > ch.padL + ch.plotW) { tip.style.display = "none"; return; }
    const xv = ch.xmin + (mx - ch.padL) / ch.plotW * (ch.xmax - ch.xmin);
    let best = 0, bestd = Infinity;
    for (let i=0;i<ch.xs.length;i++) {
      const dd = Math.abs(ch.xs[i] - xv);
      if (dd < bestd) { bestd = dd; best = i; }
    }
    const lines = ["t = " + ch.xs[best].toFixed(2) + " s"];
    for (const s of ch.opts.series) {
      const v = s.y[best];
      lines.push(s.name + ": " + (isFinite(v) ? v.toFixed(2) : "-") + (s.unit || ""));
    }
    tip.innerHTML = lines.join("<br>");
    tip.style.display = "block";
    const px = Math.min(rect.width - 140, Math.max(4, mx + 12));
    tip.style.left = px + "px";
    tip.style.top = "10px";
  });
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

function build() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  const charts = [];

  // 1. Ground track
  {
    const {canvas, tip} = makeCard(T("ground"));
    drawChart(canvas, {
      x: D.east, series: [
        {name:T("missile"), y:D.north, color:COLORS.blue, width:1.8},
        {name:T("target"), y:D.tnorth, color:COLORS.red, dash:true, width:1.4}
      ],
      xlabel:T("east"), ylabel:T("north"), equal:true, hover:false,
      markers:[{x:D.closest.east, y:D.closest.north, color:COLORS.orange,
                label:T("closest") + " " + D.closest.range_km.toFixed(1) + " km"}]
    });
    installHover(canvas, tip); charts.push(canvas);
  }

  // 2. Altitude
  {
    const {canvas, tip} = makeCard(T("alt"));
    drawChart(canvas, {
      x: D.time, series: [
        {name:T("missile"), y:D.alt, color:COLORS.blue, unit:" km"},
        {name:T("target"), y:D.talt, color:COLORS.red, dash:true, unit:" km"}
      ],
      xlabel:T("time"), ylabel:T("altY"), hover:true
    });
    installHover(canvas, tip); charts.push(canvas);
  }

  // 3. Speed / Mach
  {
    const {canvas, tip} = makeCard(T("speed"));
    drawChart(canvas, {
      x: D.time, series: [
        {name:T("speedName"), y:D.speed, color:COLORS.blue, unit:" m/s"},
        {name:T("mach"), y:D.mach, color:COLORS.purple, axis:"right", dash:true}
      ],
      xlabel:T("time"), ylabel:T("speedY"), y2label:T("mach"),
      hasRight:true, hover:true
    });
    installHover(canvas, tip); charts.push(canvas);
  }

  // 4. Load factor
  {
    const {canvas, tip} = makeCard(T("load"));
    drawChart(canvas, {
      x: D.time, series: [
        {name:T("cmd"), y:D.acmd, color:COLORS.blue, unit:" g"},
        {name:T("act"), y:D.aact, color:COLORS.red, unit:" g"}
      ],
      xlabel:T("time"), ylabel:T("loadY"), hover:true
    });
    installHover(canvas, tip); charts.push(canvas);
  }

  // 5. Fins
  {
    const {canvas, tip} = makeCard(T("fins"));
    const names = [T("up"), T("down"), T("left"), T("right")];
    const cols = [COLORS.blue, COLORS.orange, COLORS.green, COLORS.red];
    drawChart(canvas, {
      x: D.time, series: D.fin.map((y,i) => ({name:names[i], y:y, color:cols[i], unit:" deg", width:1.2})),
      xlabel:T("time"), ylabel:T("finY"), hover:true
    });
    installHover(canvas, tip); charts.push(canvas);
  }

  // 6. Range / seeker LOS
  {
    const {canvas, tip} = makeCard(T("rng"));
    drawChart(canvas, {
      x: D.time, series: [
        {name:T("range"), y:D.range, color:COLORS.blue, unit:" km"},
        {name:T("los"), y:D.los, color:COLORS.purple, axis:"right", dash:true, unit:" deg"},
        {name:T("fov"), y:D.los.map(() => D.fov_limit), color:COLORS.red, axis:"right", dash:true, width:1}
      ],
      xlabel:T("time"), ylabel:T("rangeY"), y2label:T("losY"),
      hasRight:true, hover:true
    });
    installHover(canvas, tip); charts.push(canvas);
  }

  window._charts = charts;
}

renderStatic();
build();
window.addEventListener("resize", () => { build(); });
</script>
</body>
</html>
"""
