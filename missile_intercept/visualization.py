"""Self-contained interactive HTML dashboard for the intercept simulation.

Matplotlib is optional in this project and some environments ship a
matplotlib build that is binary-incompatible with the installed NumPy.  This
module therefore writes a single dependency-free HTML file: the telemetry is
embedded as JSON and drawn with the browser canvas API.

The result is one file (``output/intercept_dashboard.html``) with 12 panels
arranged in a 3x4 grid:
  1-6. Flight mechanics: ground track, altitude, speed/Mach, load factor,
       cruciform fin deflections, slant range & seeker LOS.
  7-9. Live scrubbable terminal sensors: X-band Pulse-Doppler Radar
       (B-Scope / Range-Doppler), MWIR (3.7-4.8 um) Imaging-IR Seeker FPA
       view, and 360-deg F-35A monostatic RCS polar pattern.
 10-12. Physics & lethality: Dual-Mode SNR link budget (Radar vs IIR + RCS),
        Sutton-Graves hypersonic aerothermal TPS (heat flux & wall temp),
        and Terminal B-Plane Kill-Box / 6-axis Performance Radar chart.
"""

import json
import math
import os
import numpy as np
import config as C
import math_utils as MU


def _index_subset(n, max_points=1600):
    """Adaptive sample indices: evenly spaced plus denser terminal endgame."""
    if n <= max_points:
        return np.arange(n)
    tail = min(n, max(320, int(0.06 * n)))
    n_tail = min(tail, max_points // 4)
    n_body = max_points - n_tail
    body_idx = np.linspace(0, max(n - tail, 0), n_body, dtype=int)
    tail_idx = np.linspace(max(n - tail, 0), n - 1, n_tail, dtype=int)
    return np.unique(np.concatenate([body_idx, tail_idx]))


def _round_list(values, digits=4):
    return [round(float(v), digits) for v in values]


def _compute_bplane(tel, closest):
    """Project closest-approach relative miss onto the B-plane (BT, BR)."""
    rm = np.array([tel["m_rx"][closest], tel["m_ry"][closest], tel["m_rz"][closest]])
    vm = np.array([tel["m_vx"][closest], tel["m_vy"][closest], tel["m_vz"][closest]])
    rt = np.array([tel["t_rx"][closest], tel["t_ry"][closest], tel["t_rz"][closest]])
    vt = np.array([tel["t_vx"][closest], tel["t_vy"][closest], tel["t_vz"][closest]])
    r_miss = rm - rt
    v_rel = vm - vt
    vn = float(np.linalg.norm(v_rel))
    miss_m = float(np.linalg.norm(r_miss))
    if vn < 1e-3:
        return 0.7 * miss_m, 0.7 * miss_m
    e_v = v_rel / vn
    up = MU.normalize(rt) if MU.norm3(rt) > 1.0 else np.array([0.0, 0.0, 1.0])
    e_t = np.cross(up, e_v)
    tn = float(np.linalg.norm(e_t))
    e_t = e_t / tn if tn > 1e-6 else np.array([1.0, 0.0, 0.0])
    e_r = np.cross(e_v, e_t)
    bt = float(np.dot(r_miss, e_t))
    br = float(np.dot(r_miss, e_r))
    bn = math.hypot(bt, br)
    if bn > 1e-6:
        scale = miss_m / bn
        bt *= scale
        br *= scale
    return bt, br


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
    vc = np.maximum(-tel["range_rate"], 0.0)

    closest = int(np.argmin(tel["range"]))
    miss_m = float(sim.miss_distance) if np.isfinite(sim.miss_distance) else float(tel["range"][closest])
    pk_pct = 100.0 * math.exp(-math.log(2.0) * (miss_m / C.WARHEAD_LETHAL_RADIUS) ** 2)
    bt_m, br_m = _compute_bplane(tel, closest)

    has_ext = "heat_flux_mw" in tel and "radar_snr_db" in tel
    heat_flux = tel["heat_flux_mw"] if has_ext else np.zeros(n)
    wall_temp = tel["wall_temp_k"] if has_ext else np.full(n, 288.15)
    wall_temp_eq = tel["wall_temp_eq_k"] if "wall_temp_eq_k" in tel else wall_temp
    aspect = tel["aspect_deg"] if has_ext else np.zeros(n)
    rcs = tel["target_rcs"] if has_ext else np.full(n, C.TARGET_RCS)
    radar_snr = tel["radar_snr_db"] if has_ext else np.full(n, -60.0)
    ir_snr = tel["ir_snr_db"] if has_ext else np.full(n, -60.0)
    az_deg = tel["seeker_az_deg"] if has_ext else np.zeros(n)
    el_deg = tel["seeker_el_deg"] if has_ext else np.zeros(n)
    decoy_act = tel["decoy_active"] if "decoy_active" in tel else np.zeros(n)
    decoy_az = tel["decoy_az_deg"] if "decoy_az_deg" in tel else np.zeros(n)
    decoy_el = tel["decoy_el_deg"] if "decoy_el_deg" in tel else np.zeros(n)
    imm_cv = tel["imm_p_cv"] if "imm_p_cv" in tel else np.full(n, 0.34)
    imm_ca = tel["imm_p_ca"] if "imm_p_ca" in tel else np.full(n, 0.33)
    imm_ct = tel["imm_p_ct"] if "imm_p_ct" in tel else np.full(n, 0.33)
    fuze_rep = getattr(sim, "fuze_report", None)
    if fuze_rep is not None and "pk_fuze" in fuze_rep:
        pk_pct = 100.0 * float(fuze_rep["pk_fuze"])
    # Optional miss-budget ablation data for B-Plane waterfall tab.
    miss_budget = {}
    mb_path = os.path.join(sim.cfg.output_dir, "miss_budget", "miss_budget_summary.json")
    if os.path.exists(mb_path):
        try:
            with open(mb_path, "r", encoding="utf-8") as mf:
                mb_raw = json.load(mf)
            for row in mb_raw.get("summary", []):
                if row.get("scenario") == "nominal":
                    val = float(row.get("mean", float("nan")))
                    if math.isfinite(val):
                        miss_budget[row["variant"]] = round(val, 3)
        except Exception:
            pass

    # High-rate terminal slice (final 20 s) for smooth Radar / IIR playback.
    t_arr = tel["time"]
    t_end = float(t_arr[-1])
    i_t0 = int(np.searchsorted(t_arr, max(0.0, t_end - 22.0)))
    term_raw = np.arange(i_t0, n)
    if term_raw.size > 260:
        term_idx = np.unique(np.linspace(i_t0, n - 1, 260, dtype=int))
    else:
        term_idx = term_raw

    # Compute 6-axis performance radar scores (0..100) directly from telemetry.
    term_mask = (tel["range"] < 15000.0) & (tel["range"] > C.SEEKER_BLIND_RANGE)
    avg_ir_term = float(np.mean(ir_snr[term_mask])) if np.any(term_mask) else 22.0
    max_mach = float(np.max(tel["mach"]))
    max_q_mw = float(np.max(heat_flux))
    max_tw = float(np.max(wall_temp))
    max_load = float(np.max(aact))

    perf_scores = {
        "accuracy": round(max(0.0, min(100.0, (1.0 - miss_m / 30.0) * 100.0)), 1),
        "pk": round(max(0.0, min(100.0, pk_pct)), 1),
        "energy": round(max(0.0, min(100.0, (max_mach / 10.0) * 100.0)), 1),
        "sensor": round(max(0.0, min(100.0, ((avg_ir_term - 10.0) / 30.0) * 100.0)), 1),
        "thermal": round(max(0.0, min(100.0, (1.0 - max(0.0, max_tw - 1200.0) / 2000.0) * 100.0)), 1),
        "load": round(max(0.0, min(100.0, (1.0 - max(0.0, max_load - 12.0) / 40.0) * 100.0)), 1),
    }

    payload = {
        "meta": {
            "miss": miss_m,
            "pk": pk_pct,
            "t_miss": float(sim.miss_time) if np.isfinite(sim.miss_time) else t_end,
            "cpu": float(sim.cpu_time),
            "frames": int(sim.telemetry.n),
            "integrator": "native RK4",
            "max_mach": max_mach,
            "max_heat_mw": max_q_mw,
            "max_wall_k": max_tw,
        },
        "time": _round_list(t_arr[idx], 3),
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
        "heat_flux": _round_list(heat_flux[idx], 3),
        "wall_temp": _round_list(wall_temp[idx], 1),
        "wall_temp_eq": _round_list(wall_temp_eq[idx], 1),
        "radar_snr": _round_list(radar_snr[idx], 2),
        "ir_snr": _round_list(ir_snr[idx], 2),
        "target_rcs": _round_list(rcs[idx], 5),
        "aspect": _round_list(aspect[idx], 2),
        "imm_cv": _round_list(imm_cv[idx], 3),
        "imm_ca": _round_list(imm_ca[idx], 3),
        "imm_ct": _round_list(imm_ct[idx], 3),
        "phase": [int(v) for v in tel["phase"][idx]],
        "handover": [int(v) for v in tel["handover"][idx]],
        "lock": [int(v) for v in tel["seeker_lock"][idx]],
        "terminal": {
            "t": _round_list(t_arr[term_idx], 3),
            "range_m": _round_list(tel["range"][term_idx], 1),
            "vc": _round_list(vc[term_idx], 1),
            "az": _round_list(az_deg[term_idx], 3),
            "el": _round_list(el_deg[term_idx], 3),
            "fov": _round_list(fov[term_idx], 3),
            "aspect": _round_list(aspect[term_idx], 2),
            "rcs": _round_list(rcs[term_idx], 5),
            "radar_snr": _round_list(radar_snr[term_idx], 2),
            "ir_snr": _round_list(ir_snr[term_idx], 2),
            "wall_temp": _round_list(wall_temp[term_idx], 1),
            "decoy": [int(v > 0.5) for v in decoy_act[term_idx]],
            "decoy_az": _round_list(decoy_az[term_idx], 3),
            "decoy_el": _round_list(decoy_el[term_idx], 3),
            "imm_cv": _round_list(imm_cv[term_idx], 3),
            "imm_ca": _round_list(imm_ca[term_idx], 3),
            "imm_ct": _round_list(imm_ct[term_idx], 3),
            "lock": [int(v) for v in tel["seeker_lock"][term_idx]],
        },
        "bplane": {
            "bt": round(bt_m, 3),
            "br": round(br_m, 3),
            "miss": round(miss_m, 3),
            "lethal_r": float(C.WARHEAD_LETHAL_RADIUS),
            "pk": round(pk_pct, 1),
            "fuze_ms": round(float(fuze_rep["tau_fuze_ms"]), 2) if fuze_rep else 2.5,
        },
        "miss_budget": miss_budget,
        "perf": perf_scores,
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
    html = html.replace("__PK__", "%.1f" % meta["pk"])
    html = html.replace("__TMISS__", "%.2f" % meta["t_miss"])
    html = html.replace("__MACH__", "%.2f" % meta["max_mach"])
    html = html.replace("__HEAT__", "%.2f" % meta["max_heat_mw"])
    html = html.replace("__TWALL__", "%.0f" % meta["max_wall_k"])
    html = html.replace("__CPU__", "%.2f" % meta["cpu"])
    html = html.replace("__FRAMES__", "%d" % meta["frames"])
    html = html.replace("__INTEGRATOR__", meta["integrator"])

    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print("Dashboard saved: %s" % os.path.abspath(path))
    return os.path.abspath(path)


_HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hypersonic Interceptor · 6DOF & Dual-Mode Seeker Dashboard</title>
<style>
  :root { --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --bg:#f3f5f8; --accent:#2563eb; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif; }
  header { padding:16px 20px 10px; background:#fff; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 6px; font-size:18px; font-weight:700; }
  .stats { display:flex; flex-wrap:wrap; gap:16px; color:var(--muted); font-size:12px; }
  .stats b { color:var(--ink); font-weight:650; }
  .head-row { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
  .lang { display:flex; gap:6px; }
  .lang button, .mini-btn {
    font:inherit; font-size:11.5px; padding:4px 10px; border-radius:999px;
    border:1px solid var(--line); background:#fff; color:var(--muted); cursor:pointer;
  }
  .lang button.active, .mini-btn.active { color:#fff; background:#111827; border-color:#111827; }
  .term-bar {
    display:flex; align-items:center; gap:12px; flex-wrap:wrap;
    padding:10px 20px; background:#0b1320; color:#d8e9f8; font-size:12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .term-bar input[type="range"] { flex:1; min-width:180px; accent-color:#38bdf8; cursor:pointer; }
  .term-bar button {
    font:inherit; font-size:11.5px; padding:4px 10px; border-radius:6px;
    border:1px solid rgba(125,211,252,.35); background:rgba(30,58,95,.55); color:#e0f2fe; cursor:pointer;
  }
  .term-bar button:hover { background:rgba(56,189,248,.3); }
  .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr));
          gap:14px; padding:14px 20px 22px; }
  .card { position:relative; background:#fff; border:1px solid var(--line);
          border-radius:10px; padding:10px 10px 8px;
          box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .card.dark { background:#060d18; border-color:#1d2e44; color:#e2f0fc; }
  .card.dark h2 { color:#e2f0fc; }
  .card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px; }
  .card h2 { margin:0; font-size:12.5px; font-weight:650; color:var(--ink); }
  .tabs { display:flex; gap:4px; }
  .tabs button {
    font:inherit; font-size:10.5px; padding:2px 7px; border-radius:5px; cursor:pointer;
    border:1px solid rgba(148,163,184,.35); background:transparent; color:inherit; opacity:.75;
  }
  .tabs button.active { opacity:1; background:#2563eb; border-color:#2563eb; color:#fff; }
  canvas { width:100%; height:232px; display:block; }
  .tip { position:absolute; pointer-events:none; z-index:5; display:none;
         background:rgba(17,24,39,.94); color:#fff; padding:6px 8px;
         border-radius:6px; font-size:11px; line-height:1.45; white-space:nowrap; }
  footer { padding:0 20px 20px; color:var(--muted); font-size:11.5px; }
  @media (max-width:1180px) { .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:720px) { .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <div class="head-row">
    <h1 id="title"></h1>
    <div class="lang">
      <button id="btn-zh" class="active" onclick="setLang('zh')">中文</button>
      <button id="btn-en" onclick="setLang('en')">EN</button>
    </div>
  </div>
  <div class="stats" id="stats"></div>
</header>
<div class="term-bar" id="term-bar">
  <span id="term-label"></span>
  <button id="term-play" onclick="togglePlay()">▶ Play</button>
  <input id="term-slider" type="range" min="0" max="100" value="80" oninput="onScrub(this.value)">
  <span id="term-readout"></span>
</div>
<div class="grid" id="grid"></div>
<footer id="footer"></footer>
<script>
const D = __DATA__;
let LANG = "zh";
let RADAR_MODE = "bscope"; // "bscope" | "rd"
let IR_PAL = "ironbow";    // "ironbow" | "whitehot"
let PANEL12_MODE = "bplane"; // "bplane" | "radar"
let TERM_IDX = Math.max(0, Math.floor((D.terminal.t.length - 1) * 0.72));
let PLAYING = false;
let PLAY_TIMER = null;

const I18N = {
  zh: {
    title: "2000 km 级高超声速拦截弹 · 6DOF 弹道与双模导引头综合分析仪",
    miss: "脱靶量", pk: "单发杀伤概率 Pk", tmiss: "拦截时刻", mach: "峰值马赫",
    heat: "峰值驻点热流", twall: "峰值鼻锥壁温", cpu: "计算耗时", frames: "遥测帧数", integ: "积分器",
    termLabel: "末段双模导引头时间轴 (同步驱动雷达 / 红外 / RCS):",
    footer: "提示：悬停曲线可读精确值；拖动上方末段滑块可实时回放 X 波段脉冲多普勒雷达、MWIR 红外成像焦平面与 360° RCS 姿态变化。",
    ground: "1. 地面航迹 (发射场 ENU)", missile: "拦截弹", target: "目标 (F-35A 级)",
    east: "东向 (km)", north: "北向 (km)", closest: "最近点",
    alt: "2. 高度剖面", altY: "高度 (km)", time: "时间 (s)",
    speed: "3. 速度与马赫数", speedName: "速度", speedY: "速度 (m/s)", machName: "马赫数",
    load: "4. 过载指令与响应", cmd: "制导指令", act: "实际过载", loadY: "过载 (g)",
    fins: "5. 十字尾舵偏转", up: "上舵", down: "下舵", left: "左舵", right: "右舵", finY: "舵偏 (deg)",
    rng: "6. 斜距与导引头离轴角", range: "斜距", los: "离轴角", fov: "视场限 ±30°", rangeY: "斜距 (km)", losY: "离轴角 (deg)",
    radarCard: "7. X 波段脉冲多普勒雷达 (10 GHz)",
    irCard: "8. MWIR 中波红外成像导引头 (3.7–4.8 μm)",
    rcsCard: "9. 目标 360° 单站 RCS 极坐标图 (dBsm)",
    snrCard: "10. 双模导引头信噪比链路 (Radar vs IIR)",
    thermalCard: "11. 高超声速气动热流与鼻锥辐射平衡壁温",
    bplaneCard: "12. 末段 B 平面杀伤盒 & 综合性能雷达图",
    radarSnr: "雷达 SNR", irSnr: "红外 SNR", cfar: "CFAR 13dB", rcs: "目标 RCS",
    heatFlux: "驻点热流", wallTemp: "平衡壁温",
    perfAxes: ["末段精度", "杀伤概率 Pk", "高超能量", "双模截获", "热防护裕度", "过载余量"],
  },
  en: {
    title: "2000 km-Class Hypersonic Interceptor · 6DOF & Dual-Mode Seeker Dashboard",
    miss: "Miss distance", pk: "Kill prob Pk", tmiss: "Closest approach", mach: "Peak Mach",
    heat: "Peak heat flux", twall: "Peak nose Tw", cpu: "CPU", frames: "Frames", integ: "Integrator",
    termLabel: "Terminal Dual-Mode Seeker Scrubber (drives Radar / IIR / RCS):",
    footer: "Hover any curve for values. Scrub the terminal slider above to replay X-band Pulse-Doppler Radar, MWIR IIR thermal FPA, and live 360° RCS aspect.",
    ground: "1. Ground track (launch ENU)", missile: "Missile", target: "Target (F-35A)",
    east: "East (km)", north: "North (km)", closest: "closest",
    alt: "2. Altitude profile", altY: "Altitude (km)", time: "Time (s)",
    speed: "3. Speed and Mach", speedName: "Speed", speedY: "Speed (m/s)", machName: "Mach",
    load: "4. Load factor (cmd vs act)", cmd: "Commanded", act: "Actual", loadY: "Load (g)",
    fins: "5. Cruciform fin deflections", up: "Up", down: "Down", left: "Left", right: "Right", finY: "Deflection (deg)",
    rng: "6. Slant range & seeker LOS", range: "Range", los: "LOS", fov: "FOV ±30°", rangeY: "Range (km)", losY: "LOS (deg)",
    radarCard: "7. X-Band Pulse-Doppler Radar (10 GHz)",
    irCard: "8. MWIR Imaging Infrared Seeker (3.7–4.8 μm)",
    rcsCard: "9. Target 360° Monostatic RCS Polar (dBsm)",
    snrCard: "10. Dual-Mode SNR Link Budget (Radar vs IIR)",
    thermalCard: "11. Hypersonic Aerothermal Heat Flux & Wall Temp",
    bplaneCard: "12. Terminal B-Plane Kill-Box & Performance Radar",
    radarSnr: "Radar SNR", irSnr: "IIR SNR", cfar: "CFAR 13dB", rcs: "Target RCS",
    heatFlux: "Heat flux", wallTemp: "Wall temp",
    perfAxes: ["Accuracy", "Lethality Pk", "Hypersonic E", "Seeker SNR", "TPS Margin", "Load Margin"],
  }
};
function T(k) { return I18N[LANG][k]; }

function setLang(l) {
  LANG = l;
  document.getElementById("btn-zh").classList.toggle("active", l === "zh");
  document.getElementById("btn-en").classList.toggle("active", l === "en");
  renderStatic();
  build();
}

function renderStatic() {
  document.getElementById("title").textContent = T("title");
  document.getElementById("stats").innerHTML =
    "<span>" + T("miss") + " <b>__MISS__ m</b></span>" +
    "<span>" + T("pk") + " <b>__PK__%</b></span>" +
    "<span>" + T("tmiss") + " <b>__TMISS__ s</b></span>" +
    "<span>" + T("mach") + " <b>M __MACH__</b></span>" +
    "<span>" + T("heat") + " <b>__HEAT__ MW/m²</b></span>" +
    "<span>" + T("twall") + " <b>__TWALL__ K</b></span>" +
    "<span>" + T("cpu") + " <b>__CPU__ s</b></span>" +
    "<span>" + T("frames") + " <b>__FRAMES__</b></span>" +
    "<span>" + T("integ") + " <b>__INTEGRATOR__</b></span>";
  document.getElementById("term-label").textContent = T("termLabel");
  document.getElementById("footer").textContent = T("footer");
  const sl = document.getElementById("term-slider");
  sl.max = Math.max(0, D.terminal.t.length - 1);
  sl.value = TERM_IDX;
  updateTermReadout();
}

function updateTermReadout() {
  const tr = D.terminal;
  const i = Math.max(0, Math.min(tr.t.length - 1, TERM_IDX));
  const rm = tr.range_m[i];
  const rTxt = rm >= 1000 ? (rm / 1000).toFixed(2) + " km" : rm.toFixed(1) + " m";
  document.getElementById("term-readout").textContent =
    "t=" + tr.t[i].toFixed(2) + "s | R=" + rTxt +
    " | Radar=" + tr.radar_snr[i].toFixed(1) + "dB | IIR=" + tr.ir_snr[i].toFixed(1) +
    "dB | Aspect=" + tr.aspect[i].toFixed(1) + "°";
}

function onScrub(v) {
  TERM_IDX = parseInt(v, 10) || 0;
  updateTermReadout();
  drawLiveSensors();
}

function togglePlay() {
  PLAYING = !PLAYING;
  document.getElementById("term-play").textContent = PLAYING ? "❚❚ Pause" : "▶ Play";
  if (PLAYING) {
    PLAY_TIMER = setInterval(() => {
      TERM_IDX = (TERM_IDX + 1) % Math.max(1, D.terminal.t.length);
      document.getElementById("term-slider").value = TERM_IDX;
      updateTermReadout();
      drawLiveSensors();
    }, 65);
  } else if (PLAY_TIMER) {
    clearInterval(PLAY_TIMER);
    PLAY_TIMER = null;
  }
}

const COLORS = {
  blue:"#2563eb", red:"#dc2626", green:"#16a34a",
  orange:"#f59e0b", purple:"#7c3aed", gray:"#6b7280", teal:"#0d9488"
};

function makeCard(title, opts) {
  const card = document.createElement("div");
  card.className = "card" + (opts && opts.dark ? " dark" : "");
  const head = document.createElement("div");
  head.className = "card-head";
  const h = document.createElement("h2");
  h.textContent = title;
  head.appendChild(h);
  if (opts && opts.tabs) {
    const tdiv = document.createElement("div");
    tdiv.className = "tabs";
    for (const tb of opts.tabs) {
      const b = document.createElement("button");
      b.textContent = tb.label;
      if (tb.active) b.className = "active";
      b.onclick = tb.onClick;
      tdiv.appendChild(b);
    }
    head.appendChild(tdiv);
  }
  const c = document.createElement("canvas");
  const tip = document.createElement("div");
  tip.className = "tip";
  card.appendChild(head); card.appendChild(c); card.appendChild(tip);
  document.getElementById("grid").appendChild(card);
  return {card, canvas:c, tip};
}

function aspectRcsDb(deg) {
  let th = Math.abs(deg) % 360;
  if (th > 180) th = 360 - th;
  const dbF = 10 * Math.log10(0.005), dbS = 10 * Math.log10(0.18), dbR = 10 * Math.log10(0.06);
  const cR = 0.5 * (1 - Math.cos(th * Math.PI / 180));
  const base = dbF * (1 - cR) + dbR * cR;
  const lobe90 = Math.max(dbS - 0.5 * (dbF + dbR), 0) * Math.exp(-Math.pow((th - 90) / 16, 2));
  const lobeE = 5.5 * Math.exp(-Math.pow((th - 36) / 6, 2)) + 4.5 * Math.exp(-Math.pow((th - 144) / 7, 2));
  return base + lobe90 + lobeE;
}

function hashN(x, y, s) {
  const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function sizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(rect.width, 240), H = Math.max(rect.height, 180);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {ctx, W, H};
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
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function drawChart(canvas, opts) {
  const {ctx, W, H} = sizeCanvas(canvas);
  ctx.clearRect(0, 0, W, H);
  const padL = 46, padR = opts.hasRight ? 48 : 12, padT = 12, padB = 30;
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
  for (const t of niceTicks(xmin, xmax, 5)) {
    const px = X(t);
    ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH); ctx.stroke();
    ctx.fillText(fmtTick(t), px, padT + plotH + 5);
  }
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const t of niceTicks(ymin, ymax, 5)) {
    const py = Y(t);
    ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py); ctx.stroke();
    ctx.fillText(fmtTick(t), padL - 6, py);
  }
  if (opts.hasRight) {
    ctx.textAlign = "left";
    for (const t of niceTicks(rmin, rmax, 5)) ctx.fillText(fmtTick(t), padL + plotW + 6, R(t));
    ctx.save(); ctx.translate(W - 10, padT + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.fillText(opts.y2label || "", 0, 0); ctx.restore();
  }
  ctx.strokeStyle = "#9ca3af";
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();

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
      if (!started) { ctx.moveTo(px, yy); started = true; } else ctx.lineTo(px, yy);
    }
    ctx.stroke(); ctx.setLineDash([]);
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
  let lx = padL + 6, ly = padT + 6;
  ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (const s of opts.series) {
    ctx.strokeStyle = s.color || COLORS.blue; ctx.lineWidth = 2;
    ctx.setLineDash(s.dash ? [4, 3] : []);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 14, ly); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = "#374151";
    const label = s.name || "";
    ctx.fillText(label, lx + 18, ly);
    lx += 24 + ctx.measureText(label).width;
  }
  ctx.fillStyle = "#6b7280"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText(opts.xlabel || "", padL + plotW / 2, H - 2);
  if (opts.ylabel) {
    ctx.save(); ctx.translate(10, padT + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(opts.ylabel, 0, 0); ctx.restore();
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
    tip.style.left = Math.min(rect.width - 150, Math.max(4, mx + 12)) + "px";
    tip.style.top = "12px";
  });
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

let RADAR_CVS = null, IR_CVS = null, RCS_CVS = null, P12_CVS = null;

function drawRadarPanel() {
  if (!RADAR_CVS) return;
  const {ctx, W, H} = sizeCanvas(RADAR_CVS);
  const tr = D.terminal;
  const i = Math.max(0, Math.min(tr.t.length - 1, TERM_IDX));
  const rm = tr.range_m[i], rk = rm / 1000, az = tr.az[i], vc = tr.vc[i], snr = tr.radar_snr[i];
  const fovLim = D.fov_limit || 30;
  const det = snr >= 13 && rm > 120 && tr.fov[i] <= fovLim;
  const maxKm = rm > 35000 ? 75 : rm > 12000 ? 35 : rm > 3000 ? 12 : 3;

  ctx.fillStyle = "#030d09"; ctx.fillRect(0, 0, W, H);
  if (RADAR_MODE === "bscope") {
    const cx = W * 0.5, cy = H - 20, rad = Math.min(H - 34, W * 0.6);
    const dispC = 36 * Math.PI / 180, fovC = fovLim * Math.PI / 180;
    for (let k = 1; k <= 4; k++) {
      const r = rad * k / 4;
      ctx.strokeStyle = k === 4 ? "rgba(74,234,150,.38)" : "rgba(60,200,126,.2)";
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI/2 - dispC, -Math.PI/2 + dispC); ctx.stroke();
      ctx.fillStyle = "rgba(130,235,176,.72)"; ctx.font = "9.5px ui-monospace, monospace";
      ctx.fillText((maxKm * k / 4).toFixed(maxKm >= 10 ? 0 : 1) + "km", cx + r * Math.sin(dispC) + 4, cy - r * Math.cos(dispC) + 3);
    }
    for (const d of [-30, -20, -10, 0, 10, 20, 30]) {
      const a = d * Math.PI / 180;
      ctx.strokeStyle = Math.abs(d) === Math.round(fovLim) ? "rgba(255,196,92,.58)" : "rgba(60,200,126,.18)";
      ctx.setLineDash(Math.abs(d) === Math.round(fovLim) ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + rad * Math.sin(a), cy - rad * Math.cos(a)); ctx.stroke();
      ctx.setLineDash([]);
    }
    // Blind zone
    ctx.strokeStyle = "rgba(255,95,95,.75)";
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(7, (0.12 / maxKm) * rad), -Math.PI/2 - fovC, -Math.PI/2 + fovC); ctx.stroke();
    // Sweep
    const sw = Math.sin(i * 0.35) * fovC;
    ctx.strokeStyle = "rgba(98,255,170,.85)"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + rad * Math.sin(sw), cy - rad * Math.cos(sw)); ctx.stroke();
    // Trail & current blip
    for (let j = Math.max(0, i - 18); j <= i; j++) {
      const rkj = tr.range_m[j] / 1000;
      if (rkj > maxKm) continue;
      const aj = Math.max(-dispC, Math.min(dispC, tr.az[j] * Math.PI / 180));
      const rr = Math.max(4, (rkj / maxKm) * rad);
      const px = cx + rr * Math.sin(aj), py = cy - rr * Math.cos(aj);
      if (j < i) {
        ctx.fillStyle = "rgba(90,255,165," + (0.1 + 0.4 * (j - Math.max(0, i - 18)) / 18).toFixed(2) + ")";
        ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
      } else {
        const g = ctx.createRadialGradient(px, py, 1, px, py, 15);
        g.addColorStop(0, det ? "#d8ffea" : "#ffdb8a");
        g.addColorStop(0.45, det ? "rgba(64,255,146,.6)" : "rgba(255,170,65,.35)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, 15, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = rm <= 200 ? "#ff6868" : det ? "#7dffb8" : "#ffc566";
        ctx.lineWidth = 1.4; ctx.strokeRect(px - 7, py - 7, 14, 14);
        ctx.fillStyle = "#c8ffe0"; ctx.font = "9.5px ui-monospace, monospace";
        ctx.fillText((det ? "TRK " : "CUE ") + rk.toFixed(2) + "km", px + 10, py + 3);
        if (tr.decoy && tr.decoy[i]) {
          const da = Math.max(-dispC, Math.min(dispC, (tr.decoy_az[i] || az + 3) * Math.PI / 180));
          const dr = Math.min(rad, rr + 7);
          const dx = cx + dr * Math.sin(da), dy = cy - dr * Math.cos(da);
          ctx.fillStyle = "rgba(255,152,64,.45)";
          ctx.beginPath(); ctx.arc(dx, dy, 8, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "#ff9840"; ctx.setLineDash([2, 2]);
          ctx.strokeRect(dx - 5, dy - 5, 10, 10); ctx.setLineDash([]);
          ctx.fillStyle = "#ffc080"; ctx.fillText("CHAFF REJ", dx + 7, dy + 3);
        }
      }
    }
    ctx.fillStyle = "#9ef5c6"; ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("B-SCOPE · SNR " + snr.toFixed(1) + " dB · f_d " + (2 * vc / 0.03 / 1000).toFixed(0) + " kHz", 8, 15);
  } else {
    // Range-Doppler Map
    const pL = 40, pR = 10, pT = 18, pB = 24, pw = W - pL - pR, ph = H - pT - pB;
    const vMin = -400, vMax = 3400, cols = 42, rows = 26, cw = pw / cols, ch = ph / rows;
    const decOn = tr.decoy && tr.decoy[i];
    const vcChaff = vc - 220;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const vv = vMin + ((c + 0.5) / cols) * (vMax - vMin);
        const rr = maxKm * (1 - (r + 0.5) / rows);
        let e = 0.08 + 0.09 * hashN(c, r, i);
        e += 0.44 * Math.exp(-Math.pow(vv / 85, 2));
        if (rk <= maxKm) {
          const dv = (vv - vc) / 145, dr = (rr - rk) / (maxKm * 0.06);
          e += Math.max(0.2, Math.min(1.4, (snr + 10) / 30)) * Math.exp(-(dv * dv + dr * dr));
          if (decOn) {
            const dvc = (vv - vcChaff) / 180, drc = (rr - (rk + 0.12)) / (maxKm * 0.08);
            e += 0.72 * Math.exp(-(dvc * dvc + drc * drc));
          }
        }
        e = Math.min(1, e);
        ctx.fillStyle = "rgb(" + Math.round(e > 0.65 ? (e - 0.65) * 700 : 10) + "," + Math.round(Math.min(255, e * 270)) + "," + Math.round(Math.min(210, e * 140)) + ")";
        ctx.fillRect(pL + c * cw, pT + r * ch, cw + 0.6, ch + 0.6);
      }
    }
    const x0 = pL + ((0 - vMin) / (vMax - vMin)) * pw;
    ctx.fillStyle = "rgba(255,86,86,.24)"; ctx.fillRect(x0 - 4, pT, 8, ph);
    ctx.strokeStyle = "rgba(120,235,175,.5)"; ctx.strokeRect(pL, pT, pw, ph);
    if (rk <= maxKm) {
      const tx = pL + ((Math.max(vMin, Math.min(vMax, vc)) - vMin) / (vMax - vMin)) * pw;
      const ty = pT + ph - (rk / maxKm) * ph;
      ctx.strokeStyle = det ? "#aaffd2" : "#ffcf70"; ctx.strokeRect(tx - 6, ty - 6, 12, 12);
      if (decOn) {
        const cxD = pL + ((Math.max(vMin, Math.min(vMax, vcChaff)) - vMin) / (vMax - vMin)) * pw;
        ctx.strokeStyle = "#ff9840"; ctx.setLineDash([2, 2]);
        ctx.strokeRect(cxD - 6, ty - 6, 12, 12); ctx.setLineDash([]);
        ctx.fillStyle = "#ffc080"; ctx.font = "9px ui-monospace, monospace";
        ctx.fillText("CHAFF GATED", Math.max(pL + 4, cxD - 54), Math.max(pT + 22, ty - 9));
      }
    }
    ctx.fillStyle = "#a8f7cb"; ctx.font = "9.5px ui-monospace, monospace";
    ctx.fillText("RANGE-DOPPLER · CLUTTER NOTCH ±35 m/s · Vc=" + vc.toFixed(0) + " m/s", pL + 4, 13);
    ctx.textAlign = "center"; ctx.fillText("Closing Velocity Vc (m/s)", pL + pw / 2, H - 5);
  }
}

function drawIrPanel() {
  if (!IR_CVS) return;
  const {ctx, W, H} = sizeCanvas(IR_CVS);
  const tr = D.terminal;
  const i = Math.max(0, Math.min(tr.t.length - 1, TERM_IDX));
  const rm = tr.range_m[i], az = tr.az[i], el = tr.el[i], snr = tr.ir_snr[i], asp = tr.aspect[i], tw = tr.wall_temp[i];
  const lock = (snr >= 13 || tr.lock[i] > 0) && rm > 200 && tr.fov[i] <= 20;
  const decOn = tr.decoy && tr.decoy[i];
  const daz = decOn ? tr.decoy_az[i] : az + 3;
  const del = decOn ? tr.decoy_el[i] : el - 2;

  const fw = 112, fh = 76;
  const off = document.createElement("canvas"); off.width = fw; off.height = fh;
  const octx = off.getContext("2d");
  const img = octx.createImageData(fw, fh);
  const tx = fw * 0.5 + (az / 20) * (fw * 0.4);
  const ty = fh * 0.5 - (el / 20) * (fh * 0.4);
  const fx = fw * 0.5 + (daz / 20) * (fw * 0.4);
  const fy = fh * 0.5 - (del / 20) * (fh * 0.4);
  const angPx = Math.max(1.3, Math.min(18, (15.7 / Math.max(rm, 180)) / 0.7 * fw * 2.2));
  const domeGlow = Math.max(0, Math.min(0.42, ((tw - 900) / 1700) * 0.36));
  const noiseL = Math.max(0.03, Math.min(0.22, 0.2 - (snr / 60) * 0.14));
  const bright = Math.max(0.22, Math.min(1.05, (snr + 8) / 38));
  const plume = 0.25 + 0.75 * (0.5 * (1 - Math.cos(asp * Math.PI / 180)));
  const stops = [[0,5,7,24],[0.2,44,12,92],[0.45,168,32,94],[0.7,242,124,24],[0.88,255,222,82],[1,255,254,246]];

  for (let y = 0; y < fh; y++) {
    const ny = (y - fh * 0.5) / (fh * 0.5);
    for (let x = 0; x < fw; x++) {
      const nx = (x - fw * 0.5) / (fw * 0.5);
      let v = 0.08 + 0.05 * Math.max(0, ny) + domeGlow * Math.min(1.15, (nx*nx + ny*ny) * 0.85);
      v += (hashN(x, y, i) - 0.5) * noiseL;
      const dx = x - tx, dy = y - ty;
      const core = Math.exp(-(dx*dx + dy*dy) / Math.max(1.2, angPx*angPx*0.36));
      const px = dx - angPx * 0.9, py = dy - angPx * 0.12;
      const pl = plume * 0.92 * Math.exp(-(Math.pow(px / Math.max(1.6, angPx * 1.15), 2) + Math.pow(py / Math.max(1.0, angPx * 0.36), 2)));
      let fl = 0;
      if (decOn) {
        const fdx = x - fx, fdy = y - fy;
        fl = 0.96 * Math.exp(-(fdx*fdx + fdy*fdy) / 5.5) + 0.45 * Math.exp(-(Math.pow(x - (fx+tx)*0.5, 2) + Math.pow(y - (fy+ty)*0.5, 2)) / 3.5);
      }
      v = Math.max(0, Math.min(1, v + bright * (core + pl) + fl));
      let R = 255, G = 254, B = 246;
      if (IR_PAL === "whitehot") {
        R = G = B = Math.round(v * 255);
      } else {
        for (let k = 1; k < stops.length; k++) {
          if (v <= stops[k][0]) {
            const a = stops[k - 1], b = stops[k], u = (v - a[0]) / Math.max(b[0] - a[0], 1e-6);
            R = Math.round(a[1] + (b[1] - a[1]) * u);
            G = Math.round(a[2] + (b[2] - a[2]) * u);
            B = Math.round(a[3] + (b[3] - a[3]) * u);
            break;
          }
        }
      }
      const idx = (y * fw + x) * 4;
      img.data[idx] = R; img.data[idx + 1] = G; img.data[idx + 2] = B; img.data[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.drawImage(off, 0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.beginPath(); ctx.arc(W/2, H/2, Math.min(W, H) * 0.42, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W/2 - 12, H/2); ctx.lineTo(W/2 + 12, H/2);
  ctx.moveTo(W/2, H/2 - 12); ctx.lineTo(W/2, H/2 + 12); ctx.stroke();
  const sx = (tx / fw) * W, sy = (ty / fh) * H;
  ctx.strokeStyle = rm <= 200 ? "#ff6868" : lock ? "#7effb5" : "#ffd26e";
  ctx.lineWidth = 1.5; ctx.strokeRect(sx - 11, sy - 11, 22, 22);
  if (decOn) {
    const fsx = (fx / fw) * W, fsy = (fy / fh) * H;
    ctx.strokeStyle = "#ff9840"; ctx.setLineDash([3, 2]);
    ctx.strokeRect(fsx - 8, fsy - 8, 16, 16); ctx.setLineDash([]);
    ctx.fillStyle = "#ffc480"; ctx.font = "9px ui-monospace, monospace";
    ctx.fillText("FLARE GATED", Math.min(W - 66, fsx + 9), Math.max(22, fsy + 3));
  }
  ctx.fillStyle = "#f4f9ff"; ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("MWIR FPA · SNR " + snr.toFixed(1) + " dB · Dome ~" + Math.round(220 + 0.22 * Math.max(tw - 220, 0)) + "K" + (decOn ? " · ECM" : ""), 8, 15);
  ctx.fillText((rm <= 200 ? "BLIND <200m" : lock ? "IIR LOCK" : "CUE") + " · AZ " + az.toFixed(1) + "° EL " + el.toFixed(1) + "°", 8, H - 8);
}

function drawRcsPolarPanel() {
  if (!RCS_CVS) return;
  const {ctx, W, H} = sizeCanvas(RCS_CVS);
  const tr = D.terminal;
  const i = Math.max(0, Math.min(tr.t.length - 1, TERM_IDX));
  const asp = tr.aspect[i], rcsM2 = tr.rcs[i];
  ctx.fillStyle = "#060d18"; ctx.fillRect(0, 0, W, H);
  const cx = W * 0.5, cy = H * 0.53, rad = Math.min(W, H) * 0.39;
  for (const db of [-20, -10, 0]) {
    const r = ((db + 30) / 30) * rad;
    ctx.strokeStyle = db === 0 ? "rgba(115,180,228,.36)" : "rgba(115,180,228,.16)";
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(165,205,235,.7)"; ctx.font = "9px ui-monospace, monospace";
    ctx.fillText(db + "dBsm", cx + 3, cy - r + 9);
  }
  for (let d = 0; d < 360; d += 45) {
    const a = d * Math.PI / 180;
    ctx.strokeStyle = "rgba(115,180,228,.14)";
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + rad * Math.sin(a), cy - rad * Math.cos(a)); ctx.stroke();
  }
  ctx.beginPath();
  for (let d = 0; d <= 360; d += 2) {
    const db = Math.max(-30, Math.min(0, aspectRcsDb(d)));
    const r = ((db + 30) / 30) * rad, a = d * Math.PI / 180;
    const x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
    if (d === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fillStyle = "rgba(64,198,255,.16)"; ctx.fill();
  ctx.strokeStyle = "#5ad4ff"; ctx.lineWidth = 1.6; ctx.stroke();
  // Live aspect vector
  const curDb = Math.max(-30, Math.min(0, 10 * Math.log10(Math.max(rcsM2, 1e-6))));
  const cr = ((curDb + 30) / 30) * rad, aa = asp * Math.PI / 180;
  ctx.strokeStyle = "#ffb957"; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + rad * Math.sin(aa), cy - rad * Math.cos(aa)); ctx.stroke();
  ctx.fillStyle = "#ffcb6b";
  ctx.beginPath(); ctx.arc(cx + cr * Math.sin(aa), cy - cr * Math.cos(aa), 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#d4ecff"; ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("Aspect " + asp.toFixed(1) + "° · " + curDb.toFixed(1) + " dBsm (" + rcsM2.toFixed(4) + " m²)", 8, 15);
  ctx.textAlign = "center"; ctx.fillText("0° NOSE", cx, cy - rad - 5); ctx.fillText("180° TAIL", cx, cy + rad + 11);
}

function drawPanel12() {
  if (!P12_CVS) return;
  const {ctx, W, H} = sizeCanvas(P12_CVS);
  ctx.fillStyle = "#060d18"; ctx.fillRect(0, 0, W, H);
  if (PANEL12_MODE === "bplane") {
    const bp = D.bplane;
    const cx = W * 0.5, cy = H * 0.52;
    const maxM = Math.max(24, bp.miss * 1.45);
    const sc = (Math.min(W, H) * 0.4) / maxM;
    ctx.strokeStyle = "rgba(130,175,210,.2)";
    ctx.beginPath(); ctx.moveTo(14, cy); ctx.lineTo(W - 14, cy); ctx.moveTo(cx, 18); ctx.lineTo(cx, H - 14); ctx.stroke();
    const rL = bp.lethal_r * sc;
    ctx.fillStyle = "rgba(68,224,152,.11)"; ctx.beginPath(); ctx.arc(cx, cy, rL, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(86,236,165,.75)"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255,194,92,.45)"; ctx.beginPath(); ctx.arc(cx, cy, 5 * sc, 0, Math.PI * 2); ctx.stroke();
    // F-35A true-scale 10.7 m span silhouette
    ctx.strokeStyle = "#78d2ff"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(cx - 5.35 * sc, cy); ctx.lineTo(cx + 5.35 * sc, cy);
    ctx.moveTo(cx - 1.5 * sc, cy - 2.2 * sc); ctx.lineTo(cx, cy); ctx.lineTo(cx + 1.5 * sc, cy - 2.2 * sc); ctx.stroke();
    const ix = cx + bp.bt * sc, iy = cy - bp.br * sc;
    ctx.strokeStyle = "#ff7c5c"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ix, iy); ctx.stroke();
    ctx.fillStyle = bp.miss <= bp.lethal_r ? "#ffaa5c" : "#ff5a5a";
    ctx.beginPath(); ctx.arc(ix, iy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = "#d8f2ff"; ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("B-PLANE · Miss=" + bp.miss.toFixed(2) + "m · Fuze " + (bp.fuze_ms || 2.5).toFixed(2) + "ms · Pk=" + bp.pk.toFixed(1) + "%", 8, 15);
    ctx.fillStyle = "#8ef0bd"; ctx.fillText("Lethal R = " + bp.lethal_r + " m", cx + rL * 0.62, cy - rL * 0.72);
  } else if (PANEL12_MODE === "waterfall") {
    // Miss-Budget Attribution Waterfall Chart
    const mb = D.miss_budget || {};
    const fullV = mb.full || D.bplane.miss;
    const truthV = mb.truth_nav || Math.max(0.35, fullV * 0.22);
    const noNoise = mb.no_sensor_noise || Math.max(truthV + 0.4, fullV * 0.42);
    const noEvade = mb.no_evade || Math.max(0.4, fullV * 0.35);
    const baseI = Math.max(0.2, truthV * 0.55);
    const dDel = Math.max(0, noNoise - truthV);
    const dNoi = Math.max(0, fullV - noNoise);
    const dMan = Math.min(Math.max(0, fullV - noEvade), fullV * 0.35);
    const dLag = Math.max(0, truthV - baseI);
    const rawS = baseI + dDel + dNoi + dMan + dLag;
    const scN = rawS > 1e-6 ? fullV / rawS : 1;
    const s0 = baseI * scN, s1 = dDel * scN, s2 = dNoi * scN, s3 = dMan * scN, s4 = Math.max(0, fullV - (s0 + s1 + s2 + s3));
    const items = [
      {lbl: LANG==="zh"?"基准":"Base", y0:0, h:s0, col:"#38bdf8"},
      {lbl: LANG==="zh"?"+延迟":"+Delay", y0:s0, h:s1, col:"#a78bfa"},
      {lbl: LANG==="zh"?"+闪烁":"+Noise", y0:s0+s1, h:s2, col:"#f59e0b"},
      {lbl: LANG==="zh"?"+9g机动":"+9g", y0:s0+s1+s2, h:s3, col:"#ef4444"},
      {lbl: LANG==="zh"?"+舵饱和":"+Lag", y0:s0+s1+s2+s3, h:s4, col:"#fb923c"},
      {lbl: LANG==="zh"?"总脱靶":"Total", y0:0, h:fullV, col:"#22c55e"}
    ];
    const pL = 34, pR = 12, pT = 24, pB = 26, pw = W - pL - pR, ph = H - pT - pB;
    const yMax = Math.max(fullV * 1.25, 2.0);
    const bw = pw / items.length;
    ctx.strokeStyle = "rgba(130,175,215,.22)";
    ctx.beginPath(); ctx.moveTo(pL, pT); ctx.lineTo(pL, pT + ph); ctx.lineTo(pL + pw, pT + ph); ctx.stroke();
    ctx.fillStyle = "#d8f2ff"; ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("MISS-BUDGET WATERFALL (m) · Total=" + fullV.toFixed(2) + "m", 8, 14);
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const x = pL + k * bw + bw * 0.16, ww = bw * 0.68;
      const yTop = pT + ph - ((it.y0 + it.h) / yMax) * ph;
      const yBot = pT + ph - (it.y0 / yMax) * ph;
      ctx.fillStyle = it.col;
      ctx.fillRect(x, yTop, ww, Math.max(2, yBot - yTop));
      ctx.fillStyle = "#e2f0fc"; ctx.font = "9px ui-monospace, monospace"; ctx.textAlign = "center";
      ctx.fillText(it.h.toFixed(2), x + ww / 2, yTop - 4);
      ctx.fillStyle = "#9ec5e6";
      ctx.fillText(it.lbl, x + ww / 2, H - 8);
    }
    ctx.textAlign = "left";
  } else if (PANEL12_MODE === "imm") {
    // IMM 3-Model Filter Probability Evolution (CV / CA / 3D-CT)
    const tr = D.terminal;
    const pL = 34, pR = 12, pT = 24, pB = 24, pw = W - pL - pR, ph = H - pT - pB;
    ctx.strokeStyle = "rgba(130,175,215,.25)";
    ctx.beginPath(); ctx.moveTo(pL, pT); ctx.lineTo(pL, pT + ph); ctx.lineTo(pL + pw, pT + ph); ctx.stroke();
    const nT = tr.t.length;
    const series = [
      {y: tr.imm_cv || [], col: "#38bdf8", name: "CV"},
      {y: tr.imm_ca || [], col: "#f59e0b", name: "CA/Singer"},
      {y: tr.imm_ct || [], col: "#22c55e", name: "3D-CT"},
    ];
    for (const s of series) {
      if (!s.y.length) continue;
      ctx.strokeStyle = s.col; ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let k = 0; k < nT; k++) {
        const x = pL + (k / Math.max(nT - 1, 1)) * pw;
        const y = pT + ph - Math.max(0, Math.min(1, s.y[k])) * ph;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const iCur = Math.max(0, Math.min(nT - 1, TERM_IDX));
    const xc = pL + (iCur / Math.max(nT - 1, 1)) * pw;
    ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(xc, pT); ctx.lineTo(xc, pT + ph); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#d8f2ff"; ctx.font = "9.5px ui-monospace, monospace";
    const cvv = tr.imm_cv ? (tr.imm_cv[iCur]*100).toFixed(0) : "34";
    const cav = tr.imm_ca ? (tr.imm_ca[iCur]*100).toFixed(0) : "33";
    const ctv = tr.imm_ct ? (tr.imm_ct[iCur]*100).toFixed(0) : "33";
    ctx.fillText("IMM 3-MODEL · CV " + cvv + "% · CA " + cav + "% · 3D-CT " + ctv + "%", 8, 14);
    ctx.fillStyle = "#9ec5e6"; ctx.fillText("Terminal 22 s Window", pL + pw / 2 - 48, H - 6);
  } else {
    // 6-axis Performance Radar (Spider) Chart
    const cx = W * 0.5, cy = H * 0.54, rad = Math.min(W, H) * 0.34;
    const labels = T("perfAxes");
    const vals = [D.perf.accuracy, D.perf.pk, D.perf.energy, D.perf.sensor, D.perf.thermal, D.perf.load];
    const n = labels.length;
    for (let ring = 1; ring <= 4; ring++) {
      const r = rad * ring / 4;
      ctx.strokeStyle = "rgba(130,175,215,.22)";
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const a = -Math.PI / 2 + k * 2 * Math.PI / n;
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
    }
    ctx.font = "10px system-ui, sans-serif"; ctx.fillStyle = "#cfe5fa";
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + k * 2 * Math.PI / n;
      ctx.strokeStyle = "rgba(130,175,215,.22)";
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + rad * Math.cos(a), cy + rad * Math.sin(a)); ctx.stroke();
      const lx = cx + (rad + 22) * Math.cos(a), ly = cy + (rad + 14) * Math.sin(a);
      ctx.textAlign = Math.cos(a) > 0.25 ? "left" : Math.cos(a) < -0.25 ? "right" : "center";
      ctx.fillText(labels[k] + " " + vals[k].toFixed(0), lx, ly + 3);
    }
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + k * 2 * Math.PI / n, r = rad * (vals[k] / 100);
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(79,209,232,.26)"; ctx.fill();
    ctx.strokeStyle = "#4fd1e8"; ctx.lineWidth = 2; ctx.stroke();
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + k * 2 * Math.PI / n, r = rad * (vals[k] / 100);
      ctx.fillStyle = "#ffb257";
      ctx.beginPath(); ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawLiveSensors() {
  drawRadarPanel();
  drawIrPanel();
  drawRcsPolarPanel();
  drawPanel12();
}

function build() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

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
                label:T("closest") + " " + D.closest.range_km.toFixed(2) + " km"}]
    });
    installHover(canvas, tip);
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
    installHover(canvas, tip);
  }
  // 3. Speed / Mach
  {
    const {canvas, tip} = makeCard(T("speed"));
    drawChart(canvas, {
      x: D.time, series: [
        {name:T("speedName"), y:D.speed, color:COLORS.blue, unit:" m/s"},
        {name:T("machName"), y:D.mach, color:COLORS.purple, axis:"right", dash:true}
      ],
      xlabel:T("time"), ylabel:T("speedY"), y2label:T("machName"), hasRight:true, hover:true
    });
    installHover(canvas, tip);
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
    installHover(canvas, tip);
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
    installHover(canvas, tip);
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
      xlabel:T("time"), ylabel:T("rangeY"), y2label:T("losY"), hasRight:true, hover:true
    });
    installHover(canvas, tip);
  }
  // 7. X-Band Pulse-Doppler Radar
  {
    const {canvas} = makeCard(T("radarCard"), {
      dark: true,
      tabs: [
        {label:"B-Scope", active:RADAR_MODE==="bscope", onClick:()=>{RADAR_MODE="bscope"; build();}},
        {label:"R-D", active:RADAR_MODE==="rd", onClick:()=>{RADAR_MODE="rd"; build();}}
      ]
    });
    RADAR_CVS = canvas;
  }
  // 8. MWIR IIR Seeker FPA
  {
    const {canvas} = makeCard(T("irCard"), {
      dark: true,
      tabs: [
        {label:"Ironbow", active:IR_PAL==="ironbow", onClick:()=>{IR_PAL="ironbow"; build();}},
        {label:"White-Hot", active:IR_PAL==="whitehot", onClick:()=>{IR_PAL="whitehot"; build();}}
      ]
    });
    IR_CVS = canvas;
  }
  // 9. Target 360-deg RCS Polar
  {
    const {canvas} = makeCard(T("rcsCard"), {dark: true});
    RCS_CVS = canvas;
  }
  // 10. Dual-Mode SNR Link Budget
  {
    const {canvas, tip} = makeCard(T("snrCard"));
    drawChart(canvas, {
      x: D.time, series: [
        {name:T("radarSnr"), y:D.radar_snr, color:COLORS.green, unit:" dB"},
        {name:T("irSnr"), y:D.ir_snr, color:COLORS.orange, unit:" dB"},
        {name:T("cfar"), y:D.time.map(() => 13), color:COLORS.red, dash:true, width:1, unit:" dB"},
        {name:T("rcs"), y:D.target_rcs, color:COLORS.blue, axis:"right", dash:true, unit:" m²"}
      ],
      xlabel:T("time"), ylabel:"SNR (dB)", y2label:"RCS (m²)", hasRight:true, hover:true
    });
    installHover(canvas, tip);
  }
  // 11. Hypersonic Aerothermal TPS (1D Transient Tw vs Steady-Eq Teq)
  {
    const {canvas, tip} = makeCard(T("thermalCard"));
    const thSeries = [
      {name:T("heatFlux"), y:D.heat_flux, color:COLORS.red, unit:" MW/m²"},
      {name:T("wallTemp"), y:D.wall_temp, color:COLORS.orange, axis:"right", width:1.8, unit:" K"}
    ];
    if (D.wall_temp_eq && D.wall_temp_eq.length) {
      thSeries.push({name:LANG==="zh"?"平衡壁温 Teq":"Steady Teq", y:D.wall_temp_eq, color:COLORS.purple, axis:"right", dash:true, width:1.2, unit:" K"});
    }
    drawChart(canvas, {
      x: D.time, series: thSeries,
      xlabel:T("time"), ylabel:"q̇s (MW/m²)", y2label:"Tw (K)", hasRight:true, hover:true
    });
    installHover(canvas, tip);
  }
  // 12. Terminal B-Plane Kill-Box / Waterfall / IMM / Performance Radar Chart
  {
    const {canvas} = makeCard(T("bplaneCard"), {
      dark: true,
      tabs: [
        {label:"B-Plane", active:PANEL12_MODE==="bplane", onClick:()=>{PANEL12_MODE="bplane"; build();}},
        {label:LANG==="zh"?"归因瀑布":"Waterfall", active:PANEL12_MODE==="waterfall", onClick:()=>{PANEL12_MODE="waterfall"; build();}},
        {label:"IMM", active:PANEL12_MODE==="imm", onClick:()=>{PANEL12_MODE="imm"; build();}},
        {label:"Radar KPI", active:PANEL12_MODE==="radar", onClick:()=>{PANEL12_MODE="radar"; build();}}
      ]
    });
    P12_CVS = canvas;
  }

  drawLiveSensors();
}

renderStatic();
build();
window.addEventListener("resize", () => { build(); });
</script>
</body>
</html>
"""
