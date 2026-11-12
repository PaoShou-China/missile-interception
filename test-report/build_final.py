"""Generate the test report (kept outside the workspace root so that parallel in-project tasks cannot overwrite it).

Reads the test artefacts under missile_intercept/output and writes a self-contained HTML report.
"""

import base64
import csv
import datetime
import html
import json
import math
import os

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(ROOT)
PROJ = os.path.join(WS, "missile_intercept")
ART = os.path.join(PROJ, "output", "mc1000", "analysis")
TST = os.path.join(PROJ, "output", "tests")
OUT = os.path.join(ROOT, "missile_interceptor_test_report.html")


def load_json(p, default=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def b64img(name):
    p = os.path.join(ART, name)
    if not os.path.isfile(p):
        return ""
    with open(p, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode("ascii")


def f(x, nd=1):
    try:
        x = float(x)
        if not math.isfinite(x):
            return "—"
        return ("%." + str(nd) + "f") % x
    except Exception:
        return "—"


def pc(x, nd=1):
    try:
        return ("%." + str(nd) + "f%%") % (100.0 * float(x))
    except Exception:
        return "—"


def tr(cells, cls=""):
    return "<tr%s>%s</tr>" % ((' class="%s"' % cls) if cls else "",
                              "".join("<td>%s</td>" % c for c in cells))


def nominal():
    p = os.path.join(PROJ, "output", "telemetry.csv")
    if not os.path.isfile(p):
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        if not rows:
            return {}

        def c(n):
            return np.array([float(r[n]) for r in rows])

        t = c("time"); alt = c("alt"); mach = c("mach"); q = c("q_dyn")
        mass = c("mass"); rng = c("range"); ph = c("phase"); ho = c("handover")
        sp = np.sqrt(c("m_vx") ** 2 + c("m_vy") ** 2 + c("m_vz") ** 2)
        term = np.where(ph >= 1.5)[0]
        ih = int(np.argmax(ho > 0)) if np.any(ho > 0) else None
        return {
            "frames": len(rows), "duration": float(t[-1]),
            "vmax": float(sp.max()), "vmax_t": float(t[int(np.argmax(sp))]),
            "mmax": float(mach.max()), "mmax_t": float(t[int(np.argmax(mach))]),
            "qmax": float(q.max() / 1e3), "qmax_t": float(t[int(np.argmax(q))]),
            "hmax": float(alt.max() / 1e3), "hmax_t": float(t[int(np.argmax(alt))]),
            "m0": float(mass[0]), "mend": float(mass[-1]), "fuel": float(mass[0] - mass[-1]),
            "rmin": float(rng.min()), "rmin_t": float(t[int(np.argmin(rng))]),
            "ho_t": (float(t[ih]) if ih is not None else None),
            "ho_r": (float(rng[ih] / 1e3) if ih is not None else None),
            "term_t": (float(t[term[0]]) if term.size else None),
        }
    except Exception:
        return {}


def modified_files():
    cutoff = datetime.datetime(2026, 11, 12, 19, 50).timestamp()
    out = []
    for base, dirs, files in os.walk(PROJ):
        dirs[:] = [d for d in dirs if d not in ("output", "__pycache__", ".pytest_cache")]
        for fn in files:
            if not fn.endswith(".py"):
                continue
            p = os.path.join(base, fn)
            try:
                mt = os.path.getmtime(p)
            except OSError:
                continue
            if mt > cutoff:
                out.append((os.path.relpath(p, PROJ),
                            datetime.datetime.fromtimestamp(mt).strftime("%H:%M:%S")))
    return sorted(out, key=lambda x: x[1])


def build():
    s = load_json(os.path.join(ART, "summary.json"))
    tests = load_json(os.path.join(TST, "junit_summary.json"), {}) or {}
    ver = load_json(os.path.join(TST, "verification.json"), {}) or {}
    diag = load_json(os.path.join(ART, "diagnostics.json"), {}) or {}
    post = load_json(os.path.join(ROOT, "postfix.json"), None)
    nom = nominal()
    if not s:
        raise SystemExit("missing summary.json")

    n = s["valid"]
    ms = s["miss_stats_all"]; mt = s["miss_stats_terminal"]; mm = s["miss_stats_midcourse"]
    hit = {h["threshold_m"]: h for h in s["hit_table"]}
    nt = s["phases"].get("terminal", 0); nm = s["phases"].get("midcourse", 0)
    nb = s["phases"].get("boost", 0)

    kpi = [
        ("Unit / component tests", "%s / %s" % (sum(1 for x in tests.get("tests", []) if x["status"] == "passed"),
                                     tests.get("total", 0)), "pytest (19:42 snapshot)"),
        ("Numerical verification", "%s / 5" % ver.get("passed", 0), "built-in formal cases"),
        ("Monte Carlo samples", str(s["total_cases"]), "full-flow 6DOF"),
        ("Hit rate @10 m", pc(s["hit_rate_10m"]), "95%% CI %.1f–%.1f%%" % (
            100 * s["hit_rate_10m_ci"][0], 100 * s["hit_rate_10m_ci"][1])),
        ("CEP50 / CEP90", "%s / %s m" % (f(ms["cep50"]), f(ms["cep90"])), "all samples"),
        ("Handover completion rate", pc(s["phase_rate_terminal"]), "final phase is terminal"),
    ]
    kpi_html = "".join('<div class="kpi"><div class="l">%s</div><div class="v">%s</div><div class="s">%s</div></div>' % x
                       for x in kpi)

    comp = [
        ("Mathematics & state", "math_utils.py / state_schema.py", "state_schema (3)",
         "State packing/unpacking agrees with the compiled kernel layout hash; quaternion, LLH and DCM round trips", "Pass", "round-trip error ≤1e-9; hashes agree"),
        ("Atmosphere", "vehicle/atmosphere.py", "data_consistency (atmosphere)",
         "USSA1976 monotonicity, sea-level reference, Numba/Python consistency", "Pass", "rho and p monotonic; relative error ≤1e-12"),
        ("Aerodynamics", "vehicle/missile.py (aero)", "aero_anchors (9)",
         "DATCOM M=2/3/5 anchors, transonic bridging, high-angle-of-attack gain, static stability margin, lift-to-drag ratio", "Pass",
         "4° anchors within 2–3%; static margin 0.3–0.8 m; L/D(4°) 3.5–3.9"),
        ("Propulsion & mass", "vehicle/missile.py (propulsion)", "data_consistency (4)",
         "Boost curve, altitude thrust, ramjet envelope, throttle linearity, mass/inertia depletion, dry-mass protection", "Pass",
         "thrust increases with altitude; Ma 3 efficiency above Ma 9; mass strictly bounded"),
        ("Target", "vehicle/target.py", "fastcore (target derivatives)",
         "Cruise/defensive turn/dive/weave, lift limiting, Numba equivalence", "Pass",
         "3.62 g available load factor at 15.24 km/Ma1.6"),
        ("Navigation & sensors", "navigation / seeker / imu / tracker / wind", "sensors (4), fastcore (noise streams)",
         "GNSS/INS convergence, FOV ±20°, 200 m blind range, glint, reproducible noise streams, datalink", "Pass",
         "KF error <100 m; locks outside the blind range; larger angular noise at short range"),
        ("Guidance", "guidance/*.py", "guidance (11)",
         "Handover thresholds/dwell/blending, Bezier endpoints and tangents, lead point, coplanarity correction, terminal-guidance limiting", "Pass",
         "all bad geometries rejected; terminal guidance ≤40 g"),
        ("Control", "autopilot / fin_mixer / thrust_controller", "control (13), fastcore (AP)",
         "Second-order filtering, three-loop gain scheduling, anti-windup, low-dynamic-pressure protection, fin limits, ramjet throttle", "Pass",
         "overshoot <25%; fins ≤25°/150°/s; saturated integrator frozen"),
        ("Integrator & events", "integrator.py / verification.py", "verification (1) + 5 cases",
         "RK4 order, Kepler conservation, long-run quaternion normalization, RK4/RK45 cross-check, RK45 accuracy", "Pass",
         "observed order 3.88; Kepler error 8e-13"),
        ("Main loop & scheduling", "main.py", "main_integration (5)",
         "Multi-rate ZOH, short-time stability, event detection, seeker-error seeding, datalink convergence", "Pass",
         "0.1 s trigger count matches the period"),
        ("Telemetry / batch / analysis", "telemetry / batch / analysis", "batch (3), analysis (2)",
         "Preallocation and NaN rejection, reproducible dispersion, hit rate/CEP, parameter coverage, Sobol check", "Pass",
         "bit-identical for the same seed; Sobol reproduces analytic values"),
    ]
    comp_rows = "".join(tr(list(r)) for r in comp)

    vnames = {"rk4_convergence_order": "RK4 convergence order", "kepler_orbit_conservation": "Kepler circular-orbit conservation",
              "quaternion_norm_long_run": "Quaternion norm long-run stability", "cross_integrator_rk4_rk45": "RK4 vs RK45",
              "adaptive_rk45_accuracy": "RK45 analytic accuracy"}
    ver_rows = "".join(tr([vnames.get(c["name"], c["name"]), "%.3e" % c["observed"],
                           "%.1e" % c["limit"], "Pass" if c["passed"] else "FAIL"],
                          "ok" if c["passed"] else "bad") for c in ver.get("cases", []))

    aero_rows = "".join(tr(x) for x in [
        ("Slender-body CNα", "2.000", "2.000 (Allen & Perkins)", "0.0%"),
        ("10° wedge: Newtonian vs shock-expansion", "—", "exact relation", "27.9–48.1% (low-Mach approximation error)"),
        ("Turbulent skin friction Cf (Re=1e7)", "0.00295", "0.00300 (Prandtl-Schlichting)", "1.9%"),
        ("Turbulent skin friction Cf (Re=1e8)", "0.00186", "0.00213", "12.7%"),
        ("Turbulent skin friction Cf (Re=1e9)", "0.00117", "0.00157", "25.3%"),
        ("DATCOM reproduction: CN (M=2/3/5, α≤24°)", "—", "max deviation", "13.66% (M3, α=24°)"),
        ("DATCOM reproduction: CD", "—", "max deviation", "29.35% (M3, α=24°)"),
        ("DATCOM reproduction: CM @4°", "—", "max deviation", "0.28%"),
        ("Shock-expansion table reproduction, M>5", "—", "max error", "0.012%"),
    ])

    bands = [("≤10 m (hit)", hit[10]["hits"], hit[10]["rate"]),
             ("10–50 m", hit[50]["hits"] - hit[10]["hits"], (hit[50]["hits"] - hit[10]["hits"]) / n),
             ("50–100 m", hit[100]["hits"] - hit[50]["hits"], (hit[100]["hits"] - hit[50]["hits"]) / n),
             ("100 m–1 km", hit[1000]["hits"] - hit[100]["hits"], (hit[1000]["hits"] - hit[100]["hits"]) / n),
             (">1 km (miss)", n - hit[1000]["hits"], (n - hit[1000]["hits"]) / n)]
    band_rows = "".join(tr([a, b, pc(c)]) for a, b, c in bands)
    hit_rows = "".join(tr(["%d m" % h["threshold_m"], "%d / %d" % (h["hits"], n), pc(h["rate"]),
                           "%.1f–%.1f%%" % (100 * h["ci_lo"], 100 * h["ci_hi"])])
                      for h in s["hit_table"])
    stat_rows = tr(["All samples", n, f(ms["mean"]), f(ms["median"]), f(ms["cep90"]), f(ms["cep95"]),
                    f(ms["min"]), f(ms["max"]), pc(s["hit_rate_10m"])])
    stat_rows += tr(["Handover completed (terminal)", mt.get("n", 0), f(mt.get("mean")), f(mt.get("median")),
                     f(mt.get("cep90")), f(mt.get("cep95")), f(mt.get("min")), f(mt.get("max")),
                     pc(s.get("terminal_hit10", 0))])
    stat_rows += tr(["No handover (midcourse)", mm.get("n", 0), f(mm.get("mean")), f(mm.get("median")),
                     f(mm.get("cep90")), f(mm.get("cep95")), f(mm.get("min")), f(mm.get("max")),
                     pc(s.get("midcourse_hit10", 0))])
    corr_rows = "".join(tr([v["label"], "%.3f" % v["rho"], "%.3g" % v["p"],
                            "Significant" if v["p"] < 0.05 else "Not significant"]) for v in s["correlations"].values())
    ev_rows = "".join(tr([g["bin"], g["n"], pc(g.get("hit10", 0)), f(g["median"]), f(g["cep90"])])
                      for g in s["evade_groups"])
    ph_rows = "".join(tr([b["bin"] + "°", b["n"], pc(b["no_handover_rate"]), pc(b["hit10"]),
                          f(b["median"]), f(b["cep90"])]) for b in s["phase_bins"])
    large_rows = "".join(tr([r["case_id"], f(r["miss_m"]), r["phase"], f(r["evade_g"], 2),
                             f(r["target_alt"] / 1e3, 2), f(r["target_mach"], 3),
                             f(r["launch_offset_m"], 0), f(r["target_offset_m"], 0)])
                         for r in s["largest_misses"])

    def card(cid, title, note):
        d = diag.get(str(cid))
        if not d:
            return ""
        ht = d.get("handover_trigger")
        rows = [("Miss distance", f(d["miss_m"]) + " m"), ("Final phase", d["final_phase"]),
                ("Minimum range / time", "%s m @ %s s" % (f(d["min_range_m"]), f(d["min_range_t"], 2))),
                ("Target altitude / Mach / evasion", "%s km / %s / %s g" % (f(d["target_alt"] / 1e3, 2),
                                                       f(d["target_mach"], 3), f(d["evade_g"], 2))),
                ("Handover trigger", ("%s s, R=%s km, seeker range %s km" % (
                    f(ht["t"], 2), f(ht["range_m"] / 1e3, 2), f(ht["seeker_range_m"] / 1e3, 2)))
                    if ht else "No handover"),
                ("Locked-frame fraction", pc(d.get("seeker_lock_fraction", 0), 2))]
        return ('<div class="case"><h4>Case %d: %s</h4><table class="mini">%s</table>'
                '<p>%s</p></div>' % (cid, html.escape(title), "".join(tr(r) for r in rows), html.escape(note)))

    cases = "".join([
        card(0, "Hit sample (baseline reference)",
             "Miss distance 5.26 m; terminal guidance converges after handover and the 10 m criterion is met."),
        card(2, "No handover: insufficient dwell time causes a flyby",
             "At R≈25.7 km all thresholds were satisfied simultaneously (lead angle 7.4°, FOV 8.8°, genuine lock), "
             "but the 0.2 s dwell was not completed; 0.04 s later the lead angle grew to 13.1° and reset the counter. "
             "After that the lead angle went to 19°/24°/36° and the FOV to 27°, ending in a flyby at 5.76 km."),
        card(4, "Handover performed: single-frame false lock causes premature handover",
             "The first ok frame is at 36.9 km with force=True; the seeker reports a range of 35.7 km and lock=True, "
             "beyond the 25 km physical acquisition limit; on the next frame lock returns to False and the genuine lock "
             "only occurs at 24.86 km. The false lock advanced handover by about 11 km, deflected the LOS, and gave a 3.69 km miss distance."),
        card(28, "No handover: energy/attitude collapse leads to ground impact",
             "From about 350 s the angle of attack saturates at -35° and Mach drops from 8.97 to 6.58 within 10 s; "
             "after fuel exhaustion the missile hits the ground at Ma 0.5, about 785 km from the target."),
    ])

    charts = ""
    for fn, title, cap in [
        ("miss_hist_log.png", "Miss distance distribution (log scale)", "The red line marks the 10 m hit criterion."),
        ("miss_ecdf.png", "Empirical CDF of miss distance", "Cumulative hit fraction under different criteria."),
        ("hit_vs_threshold.png", "Hit rate vs criterion threshold", "Separates insufficient accuracy from total failure."),
        ("phase_bar.png", "Final phase distribution", "midcourse means handover was never completed."),
        ("scatter_evade.png", "Miss distance vs target evasion command", "The achievable load factor is limited by lift."),
        ("scatter_alt_mach.png", "Miss distance vs target altitude/speed", "Univariate effect of the dispersion parameters."),
        ("box_evade.png", "Miss distance grouped by evasion load factor", "Box plots of log10 miss distance."),
        ("correlations.png", "Rank correlation of miss distance with dispersion parameters", "Spearman ρ."),
        ("phase_dependence.png", "Outcome vs random weave phase", "Bars show the no-handover rate; the line shows median miss distance."),
        ("cpu_hist.png", "Per-case CPU time", "Runtime distribution over 1000 cases."),
    ]:
        b = b64img(fn)
        if b:
            charts += '<figure><img src="%s" alt="%s"><figcaption><b>%s</b> %s</figcaption></figure>' % (
                b, html.escape(title), html.escape(title), html.escape(cap))

    test_rows = "".join(tr([t["module"].replace("test_", ""), t["test"], f(t["time_s"], 3),
                            "Pass" if t["status"] == "passed" else t["status"]],
                           "ok" if t["status"] == "passed" else "bad")
                         for t in tests.get("tests", []))

    changed = modified_files()
    changed_rows = "".join(tr(x) for x in changed)
    postfix_html = ""
    if post:
        items = []
        if post.get("pytest"):
            v = post["pytest"]
            items.append("pytest on the current code: %s / %s passed, %s failed" % (
                v.get("passed"), v.get("total"), v.get("failed")))
        if post.get("noise_free"):
            v = post["noise_free"]
            items.append("Zero-noise single shot: %s, miss distance %s m" % ("succeeded" if v.get("ok") else "failed", f(v.get("miss"))))
        if post.get("mini_mc"):
            v = post["mini_mc"]
            items.append("Same-seed MC with %s cases: handover rate %s, ≤10 m %s, CEP50 %s m" % (
                v.get("n"), pc(v.get("phase_rate", 0)), pc(v.get("hit10", 0)), f(v.get("cep50"))))
        if items:
            postfix_html = ('<h3>6.5 Same-seed re-test after parallel modifications</h3>'
                            '<p class="warn">The items below are supplementary verification run after the code base was modified in parallel; they do not replace the 1000-case baseline.</p><ul>'
                            + "".join("<li>%s</li>" % html.escape(x) for x in items) + "</ul>")

    nom_rows = "".join(tr(x) for x in [
        ("Miss distance / intercept time", "6.17 m @ 672.478 s"),
        ("Maximum speed", "%s m/s @ %s s" % (f(nom.get("vmax")), f(nom.get("vmax_t")))),
        ("Maximum Mach", "%s @ %s s" % (f(nom.get("mmax"), 2), f(nom.get("mmax_t")))),
        ("Maximum dynamic pressure", "%s kPa @ %s s" % (f(nom.get("qmax")), f(nom.get("qmax_t")))),
        ("Maximum altitude", "%s km @ %s s" % (f(nom.get("hmax"), 2), f(nom.get("hmax_t")))),
        ("Handover time / target range", "%s s / %s km" % (f(nom.get("ho_t"), 2), f(nom.get("ho_r"), 2))),
        ("Propellant consumption", "%s kg (%s → %s kg)" % (f(nom.get("fuel")), f(nom.get("m0")), f(nom.get("mend")))),
        ("Telemetry frames", str(nom.get("frames", "—"))),
        ("CPU time (single process)", "28.62 s"),
    ])

    css = """
:root{--navy:#122a44;--blue:#2f6690;--cyan:#3f8fbf;--green:#2e8b57;--orange:#d9822b;--red:#c0392b;--ink:#1f2933;--muted:#5f6b7a;--line:#e3e8ef;--bg:#f4f7fb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;line-height:1.75;font-size:15px}
.hero{background:linear-gradient(135deg,#0f2138,#1b4568 55%,#2b6d96);color:#fff;padding:50px 24px 38px}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px}.hero h1{font-size:29px;margin:0 0 8px;line-height:1.35}
.hero .sub{opacity:.86;font-size:16px}.chips span{display:inline-block;background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.25);padding:4px 11px;border-radius:20px;margin:8px 8px 0 0;font-size:12.5px}
.verdict{display:inline-block;margin-top:16px;background:#e9f7ef;color:#1e6b43;border-left:4px solid #2e8b57;padding:10px 16px;border-radius:6px;font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:-26px auto 0;max-width:1180px;padding:0 22px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:10px;padding:15px 17px;box-shadow:0 8px 24px rgba(20,45,75,.07)}
.kpi .l{color:var(--muted);font-size:12.5px}.kpi .v{font-size:23px;font-weight:700;color:var(--navy)}.kpi .s{color:var(--muted);font-size:12px}
main{max-width:1180px;margin:0 auto;padding:26px 22px 60px}section{background:#fff;border:1px solid var(--line);border-radius:12px;padding:25px 28px;margin-bottom:22px;box-shadow:0 4px 16px rgba(20,45,75,.04)}
h2{font-size:21px;color:var(--navy);margin:0 0 14px;padding-bottom:10px;border-bottom:2px solid var(--line)}h2 .num{color:var(--cyan);font-size:14px;margin-right:8px}
h3{font-size:16.5px;color:#24506f;margin:22px 0 8px}h4{margin:0 0 8px;font-size:15px;color:var(--navy)}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.4px}th,td{border-bottom:1px solid var(--line);padding:8px 9px;text-align:left;vertical-align:top}
th{background:#f0f5fa;color:#274b67;font-size:12.8px}tbody tr:nth-child(even){background:#fbfcfe}
tr.ok td:last-child{color:var(--green);font-weight:600}tr.bad td:last-child{color:var(--red);font-weight:600}
.note{background:#f7f9fc;border-left:3px solid var(--cyan);padding:10px 14px;border-radius:0 6px 6px 0;font-size:13.6px}
.warn{background:#fff8f2;border-left:3px solid var(--orange);padding:10px 14px;border-radius:0 6px 6px 0}
.danger{background:#fdf1ef;border-left:3px solid var(--red);padding:10px 14px;border-radius:0 6px 6px 0}
.good{background:#f1f9f4;border-left:3px solid var(--green);padding:10px 14px;border-radius:0 6px 6px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.case{border:1px solid var(--line);border-radius:9px;padding:14px 16px;margin:12px 0;background:#fdfefe}
.case table.mini{font-size:12.8px;margin:6px 0}figure{margin:18px 0 26px;text-align:center}figure img{width:100%;max-width:980px;border:1px solid var(--line);border-radius:8px}
figcaption{font-size:12.8px;color:var(--muted);margin-top:7px;text-align:left}
details{border:1px solid var(--line);border-radius:8px;padding:10px 14px;background:#fcfdff}summary{cursor:pointer;font-weight:600;color:#24506f}
.kv{font-family:Consolas,monospace;background:#f4f6f9;padding:1px 5px;border-radius:4px;font-size:12.6px}.footer{color:var(--muted);font-size:12.4px;text-align:center;padding:10px 20px 30px}
@media(max-width:900px){.kpis,.grid{grid-template-columns:1fr}.hero h1{font-size:23px}section{padding:20px 18px}}
@media print{body{background:#fff}section{box-shadow:none;border:none;page-break-inside:avoid}.kpi{box-shadow:none}}
"""

    doc = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>2000 km-class lifting-body interceptor 6DOF full-flow test report</title>
<style>{css}</style></head><body>
<header class="hero"><div class="wrap"><h1>2000 km-class lifting-body interceptor 6DOF full-flow test report</h1>
<div class="sub">Component tests · numerical verification · aerodynamic cross-check · 1000-case Monte Carlo</div>
<div class="chips"><span>Python 3.14.10</span><span>NumPy 2.5.4</span><span>SciPy 1.18.1</span><span>Numba 0.68.1</span><span>Windows / 32 logical cores</span><span>Report date 2026-11-12</span></div>
<div class="verdict">Overall verdict: all basic functionality and numerical kernels pass; the 1000-case full-flow Monte Carlo completed, but one fatal defect on the zero-noise path and two end-to-end robustness bottlenecks were found.</div></div></header>
<div class="kpis">{kpi_html}</div><main>

<section><h2><span class="num">0</span>Summary and conclusions</h2>
<p>This report tests the missile_intercept simulation system at four levels: unit/component, numerical and model verification, aerodynamic cross-check, and a 1000-case full-flow Monte Carlo (6DOF, with navigation/seeker/wind/datalink noise all enabled). Every test can be reproduced with the repository commands.</p>
<div class="grid">
<div class="good"><b>What passed</b><br>All 69 pytest cases pass; 5 formal numerical verifications pass; the Numba and pure-Python hot paths agree; aerodynamic anchors, DATCOM reproduction and the M&gt;5 shock-expansion table are all within tolerance; the nominal single shot misses by 6.17 m; all 1000 cases complete without crashes.</div>
<div class="danger"><b>Issues requiring attention</b><br>
① <b>P0</b>: with <span class="kv">sensor_noise_scale=0</span> the target-tracking covariance collapses to zero and the second datalink update raises <span class="kv">LinAlgError('Singular matrix')</span>, which makes <span class="kv">main.py --converge</span> and the error-budget ablation unusable.<br>
② <b>P1</b>: a single-frame false lock can trigger a forced handover at 35.7 km, causing a kilometre-scale miss.<br>
③ <b>P1</b>: about {pc(nm / n)} of samples never complete handover. The main causes are the mismatch between the real acquisition window (IIR 25 km / radar 8 km) and the 45 km handover design, the 0.2 s hard dwell missing the window, and midcourse energy/attitude saturation.</div></div>
<h3>Recommended priority actions</h3><ol>
<li>For zero-noise filtering use a covariance floor or the Joseph form, or skip the update and keep the covariance positive definite when noise is zero.</li>
<li>For forced handover add a "lock range ≤ physical acquisition range" check and a consistency check over at least 3 consecutive frames.</li>
<li>Align the handover range with the seeker acquisition range; make the dwell time adaptive to t_go/closure rate so that the only window at 3 km/s is not missed.</li>
<li>Add angle-of-attack / load-factor rate and energy constraints to midcourse guidance so that 35° angle-of-attack saturation at Ma 9 does not cause energy collapse.</li></ol></section>

<section><h2><span class="num">1</span>Test scope, environment and method</h2>
<table><tbody>
<tr><td style="width:26%">Operating system / interpreter</td><td>Windows, Python 3.14.10</td></tr>
<tr><td>Numerical stack</td><td>NumPy 2.5.4; SciPy 1.18.1; Numba 0.68.1; Matplotlib 3.11.2; pytest 9.2.0 + xdist</td></tr>
<tr><td>Hardware</td><td>32 logical cores, 15.7 GB RAM</td></tr>
<tr><td>Simulation configuration</td><td>Outer step 5 ms (midcourse 10 ms); t_end=1200 s; telemetry 10 ms; GNSS 1 Hz; navigation delay 50 ms; wind, star field, datalink, Swerling, dropout/false lock all enabled</td></tr>
<tr><td>MC dispersion</td><td>Launch point CEP 500 m; target CEP 2000 m; target altitude σ=500 m; Mach σ=0.05; evasion σ=1.0 g; weave phase U(0,2π)</td></tr>
</tbody></table>
<h3>1.1 Test levels</h3>
<table><thead><tr><th>Level</th><th>Object</th><th>Method</th><th>Criterion / scale</th></tr></thead><tbody>
<tr><td>L1 unit/component</td><td>Mathematics, atmosphere, aerodynamics, propulsion, target, sensors, guidance, control, integrator, scheduling, telemetry, batch</td><td>pytest, including parametrization and Numba/Python comparison</td><td>69 cases, all passing</td></tr>
<tr><td>L2 numerical verification</td><td>Integrator and events</td><td>Analytic solutions/independent integrators</td><td>5 cases, explicit tolerances</td></tr>
<tr><td>L3 model verification</td><td>Aerodynamics and uncertainty</td><td>Classical theory, exact shock/expansion, DATCOM, 5000 perturbations</td><td>anchors within 2–3%</td></tr>
<tr><td>L4 full flow</td><td>6DOF closed loop + multi-rate + noise</td><td>1000 parallel MC cases + replay diagnostics on 4 samples</td><td>hit rate, CEP, phases, mechanisms</td></tr>
</tbody></table>
<h3>1.2 Reproduction commands</h3>
<p class="note"><span class="kv">python -m pytest -n 4</span> · <span class="kv">python verification.py --json output/tests/verification.json</span> · <span class="kv">python tools/aero_crosscheck.py</span> · <span class="kv">python tools/aero_uq.py 5000</span> · <span class="kv">python batch.py --cases 1000 --workers 12 --seed 2026 --checkpoint output/mc1000/checkpoint.jsonl --out output/mc1000 --no-plot</span> (BLAS threads pinned to 1)</p>
<h3>1.3 Code snapshot and parallel modifications</h3>
<p class="warn">The 1000-case MC was started by 12 workers at <b>19:42:02</b> and loaded the code snapshot of that moment; worker processes cache modules in memory, so later file changes do not affect these statistics. During testing the workspace contained parallel modifications (table below), including the target-tracking covariance, false-lock confirmation, handover consistency and midcourse/terminal guidance core modules. Chapters 2–5 therefore correspond to the 19:42 snapshot; the supplementary re-test after those modifications is in 6.5.</p>
<table><thead><tr><th>Files modified after 19:50</th><th>Time</th></tr></thead><tbody>{changed_rows}</tbody></table></section>

<section><h2><span class="num">2</span>Detailed component-level tests</h2>
<p>The table below summarises coverage and measured evidence by subsystem; the individual tests are listed in Appendix A.</p>
<table><thead><tr><th>Subsystem</th><th>Code module</th><th>Covering tests</th><th>Verification content</th><th>Result</th><th>Key measurement</th></tr></thead><tbody>{comp_rows}</tbody></table>
<h3>2.1 Key numerical findings</h3><ul>
<li><b>State and coordinates</b>: the packing layout shares a hash with the Numba kernel; the quaternion norm error after 2000 s / 40k steps is 0; the LLH/quaternion round-trip error is of order 1e-9.</li>
<li><b>Hot-path equivalence</b>: atmosphere, the 14-dimensional missile derivative, the 6-dimensional target derivative, the autopilot and the fin mixer agree to a relative error ≤1e-10 between Numba and Python on random states.</li>
<li><b>Sensors</b>: KF error &lt;100 m within 20 s; locks are rejected outside the FOV and lost inside the 200 m blind range; angular glint grows as range decreases; noise streams are bit-reproducible for the same seed.</li>
<li><b>Control</b>: second-order filter overshoot &lt;25%; fin deflection ≤25° with rate ≤150°/s; saturated integrators freeze; q&lt;100 Pa protection; gain scheduling bounded at both ends.</li>
<li><b>Guidance/handover</b>: all bad geometries rejected; 0.2 s dwell + 0.5 s blending; Bezier endpoints/tangents correct; terminal guidance ≤40 g.</li></ul>
<p class="warn">All component tests pass, but L4 exposed problems that only appear with closed loop + noise + random dispersion: singular zero-noise filtering (P0) and false locks triggering forced handover (P1).</p></section>

<section><h2><span class="num">3</span>Numerical verification and model cross-checks</h2>
<h3>3.1 Built-in formal numerical verification</h3>
<table><thead><tr><th>Case</th><th>Observed</th><th>Tolerance</th><th>Result</th></tr></thead><tbody>{ver_rows}</tbody></table>
<p>The observed RK4 order is 3.88; the radius/specific-energy relative drift over one full Kepler circular orbit is about 8e-13; the long-run quaternion error is 0; the RK4 vs RK45 position difference is 1.46e-9 and the RK45 analytic error is 4.56e-9. The integrator meets the closed-loop requirements.</p>
<h3>3.2 Aerodynamic cross-check</h3>
<table><thead><tr><th>Check item</th><th>Model value</th><th>Reference</th><th>Deviation</th></tr></thead><tbody>{aero_rows}</tbody></table>
<p>For M≤5 the DATCOM 4° anchors for CN/CM/CD are within 2–3%; the largest deviations occur in the strongly nonlinear region at M=3, α=24° (CN 13.66%, CD 29.35%), consistent with the published DATCOM/AP98 conclusion that normal-force error is small while axial-force error is large. CM@4° is only 0.28%. The internal reproduction error of the M&gt;5 branch is 0.012%. The 28–48% deviation of the 10° wedge Newtonian model is a known low-Mach approximation error, and the code only fully uses that branch near M≥7. The turbulent skin-friction power law is 25% low at high Re; a logarithmic law or a shape correction is recommended.</p>
<h3>3.3 Aerodynamic uncertainty (5000 draws)</h3>
<table><thead><tr><th>Quantity</th><th>P5</th><th>P50</th><th>P95</th></tr></thead><tbody>
<tr><td>Static stability margin (m)</td><td>0.490</td><td>0.654</td><td>0.847</td></tr>
<tr><td>Fin effectiveness (1/rad)</td><td>0.824</td><td>1.043</td><td>1.253</td></tr>
<tr><td>5 g trim fin deflection (°)</td><td>12.26</td><td>17.83</td><td>28.18</td></tr>
<tr><td>Lift-to-drag ratio at 4°</td><td>2.53</td><td>2.94</td><td>3.34</td></tr></tbody></table>
<p>The static stability margin is always positive; the P95 of the 5 g trim fin deflection, 28.2°, already exceeds the single equivalent demand of the 25° physical fin limit, so there is a risk of insufficient trim capability. The L/D in this UQ includes only CD0 + induced drag and omits wave/bottom drag, so its median of 2.94 is below the full-model 4° anchor of 3.73; it is used only for relative sensitivity comparison.</p></section>

<section><h2><span class="num">4</span>Nominal single-shot full flow</h2>
<table><tbody>{nom_rows}</tbody></table>
<p>Nominal trajectory: vertical cold launch → boost → constant-dynamic-pressure cruise → terminal guidance. Handover occurs at %s s at a target range of %s km (forced-handover path), and impact follows 8 s later with a miss distance of 6.17 m. The difference between the 25.7 m minimum range sampled at 10 ms telemetry and the 6.17 m figure from event interpolation is normal.</p>
<p class="note">The repository README records 11.38 m from an earlier snapshot; all conclusions in this report are based on the reproducible experiments presented here.</p></section>

<section><h2><span class="num">5</span>1000-case full-flow Monte Carlo</h2>
<h3>5.1 Samples and completion</h3>
<table><tbody>
<tr><td style="width:30%">Planned / completed / valid</td><td>{s['total_cases']} / {s['total_cases']} / {n}</td></tr>
<tr><td>Runtime exceptions</td><td>{s['errors']}</td></tr>
<tr><td>Integration success flag</td><td>{s['success_flag']} / {n}</td></tr>
<tr><td>Final phase</td><td>terminal {nt} ({pc(nt / n)}); midcourse {nm} ({pc(nm / n)}); boost {nb}</td></tr>
<tr><td>Mean per-case CPU / telemetry frames</td><td>{f(s['cpu_time_mean_s'])} s / {f(s['telemetry_frames_mean'], 0)} frames</td></tr>
</tbody></table>
<p>All 1000 cases completed with no NaN/Inf crashes and no integration step-limit overruns. 12 workers were stable (total working set about 1.7 GB); with 24 workers LLVM/OpenBLAS memory exhaustion occurred on the 15.7 GB machine (see 6.4).</p>
<h3>5.2 Miss distance statistics</h3>
<table><thead><tr><th>Sample</th><th>n</th><th>Mean</th><th>Median</th><th>CEP90</th><th>CEP95</th><th>Min</th><th>Max</th><th>≤10 m</th></tr></thead><tbody>{stat_rows}</tbody></table>
<p>The distribution is strongly heavy-tailed: the median is {f(ms['median'])} m while the mean is pulled up to {f(ms['mean'])} m by kilometre-scale failures; CEP90 is {f(ms['cep90'])} m. The median of the handover-completed subsample is only {f(mt.get('median'))} m, showing that the accuracy loss comes mainly from missing handover rather than from terminal guidance itself.</p>
<table><thead><tr><th>Miss distance band</th><th>Count</th><th>Share</th></tr></thead><tbody>{band_rows}</tbody></table>
<h3>5.3 Hit rate vs criterion</h3>
<table><thead><tr><th>Criterion</th><th>Hits / valid</th><th>Hit rate</th><th>Wilson 95% CI</th></tr></thead><tbody>{hit_rows}</tbody></table>
<p>The hit rate at the 10 m criterion is {pc(s['hit_rate_10m'])} and {pc(s['hit_rate_50m'])} at 50 m. If the warhead lethal radius is greater than 50 m the mission success rate would differ markedly, so both CEP and multi-criterion hit rates are reported.</p>
<h3>5.4 Distribution and correlation charts</h3>{charts}
<h3>5.5 Parameter sensitivity and grouping</h3>
<table><thead><tr><th>Parameter</th><th>Spearman ρ</th><th>p</th><th>Conclusion</th></tr></thead><tbody>{corr_rows}</tbody></table>
<p>All univariate rank correlations are weak (|ρ|≤{f(max(abs(v['rho']) for v in s['correlations'].values()), 2)}), indicating that the outcome is dominated by closed-loop nonlinearity and the random realisation rather than linearly driven by any single dispersion parameter. The weave-phase cos/sin correlations are also not significant.</p>
<table><thead><tr><th>Evasion command group</th><th>n</th><th>≤10 m</th><th>Median</th><th>CEP90</th></tr></thead><tbody>{ev_rows}</tbody></table>
<p class="note">The evasion load factor is the commanded value; the achievable load factor is limited by lift. At the 15.24 km/Ma1.6 nominal point it is only about 3.62 g, so 9–10 g commands are not achievable at cruise altitude and are only progressively released at low altitude.</p>
<table><thead><tr><th>Weave phase</th><th>n</th><th>No-handover rate</th><th>≤10 m</th><th>Median</th><th>CEP90</th></tr></thead><tbody>{ph_rows}</tbody></table>
<h3>5.6 Largest-miss samples</h3>
<table><thead><tr><th>case</th><th>miss (m)</th><th>phase</th><th>evasion (g)</th><th>target altitude (km)</th><th>Mach</th><th>launch offset (m)</th><th>target offset (m)</th></tr></thead><tbody>{large_rows}</tbody></table></section>

<section><h2><span class="num">6</span>Typical sample replays and failure mechanisms</h2>
<p>Four samples were replayed with the same seed, with diagnostic records injected into the handover manager.</p>{cases}
<h3>6.1 Evidence chain for a false lock triggering forced handover</h3><ol>
<li>Seeker physical acquisition: radar 45000×(0.005/5)^0.25≈8.0 km; IIR 25 km; the dual-mode takes the longer of the two, so the real upper limit is 25 km.</li>
<li>Case 4 reports <span class="kv">is_locked=True</span> at 35.7 km, which cannot come from a real echo; the false-detection rate is 0.01/s and a single frame is enough to set it.</li>
<li>Forced handover only requires dist≤38 km, speed, lead angle, FOV and seeker_lock, and does not check the lock range or the number of consecutive frames; a single-frame false lock is sufficient.</li>
<li>The false detection deflects the LOS by about 0.35×FOV (≈7°), which corresponds to about 4.4 km of lateral error at 35.7 km; terminal guidance then flies along the wrong line of sight and misses by 3.69 km.</li></ol>
<p class="danger">This is the end-to-end logic defect most worth fixing first: a sensor false detection is treated as a genuine acquisition by the handover state machine. Forced handover should require at least 3 consecutive frames, a lock range ≤110% of the physical acquisition range, and a consistency check using the tracker innovation covariance.</p>
<h3>6.2 Two mechanisms for missing handover</h3><ul>
<li><b>State machine misses the window (case 2)</b>: at R≈25.7 km all thresholds were satisfied simultaneously, but the 0.2 s dwell was not completed and the lead angle rose to 13.1° 0.04 s later, resetting the counter; the geometry then deteriorated and the missile flew past at 5.76 km. The underlying issue is that the hard dwell does not match the short window at a 3 km/s closure rate, and the force branch is not effective when all_ok holds only instantaneously.</li>
<li><b>Energy/attitude collapse (case 28)</b>: from about 350 s the angle of attack saturates at -35°, Mach drops from 8.97 to 6.58 within 10 s and speed from 3009 to 737 m/s within 40 s; after fuel exhaustion the missile hits the ground 785 km from the target. This shows that midcourse guidance can issue extreme commands under strong dispersion, and that the high dynamic pressure at Ma 9 turns a small angle-of-attack error into enormous drag.</li></ul>
<h3>6.3 P0 defect: singular matrix on the zero-noise path</h3>
<p>The error-budget ablations no_sensor_noise / truth_nav all fail; the single-shot reproduction stack is:</p>
<p class="note"><span class="kv">sensors/target_tracker.py:118 → K = np.linalg.solve(S, self.P).T</span><br><span class="kv">numpy.linalg.LinAlgError: Singular matrix</span> (t≈2 s, second datalink update)</p>
<p>Root cause: in update_position_velocity, R=diag([σp²,σv²]); when noise_scale=0, σ=0, so the first update projects P exactly to the zero matrix and the second update has S=0 → singular. The seeker zero-noise update (Rm=0) has the same problem.</p>
<p>Impact: the noise-free ablations of <span class="kv">main.py --converge</span> and <span class="kv">tools/miss_budget.py</span> are unusable; the default 1000 cases with noise enabled and the nominal simulation are unaffected.</p>
<h3>6.4 Engineering runtime issues</h3><ul>
<li><b>24-process OOM</b>: when 24 workers trigger Numba/LLVM and OpenBLAS simultaneously, LLVM/OpenBLAS memory exhaustion occurs on the 15.7 GB machine; 12 processes are stable. Recommended: workers ≤ min(12, cpu/2) with BLAS threads preset to 1.</li>
<li><b>Checkpoint-resume semantics</b>: failed records are also written to the JSONL file, and --resume skips them by case_id without retrying; filtering out records with a non-empty error is recommended.</li>
<li><b>basic telemetry</b>: all extended observables are still computed and then truncated, so CPU time does not drop; branching on profile inside _log is recommended.</li></ul>
{postfix_html}
</section>

<section><h2><span class="num">7</span>Conclusions and recommendations</h2><ol>
<li>Basic software quality is good: 69 unit/component tests, 5 numerical verifications, Numba/Python equivalence, aerodynamic anchors and DATCOM reproduction all pass; the nominal miss distance is 6.17 m.</li>
<li>All 1000 MC cases completed; the 10 m hit rate is {pc(s['hit_rate_10m'])} and the 50 m hit rate is {pc(s['hit_rate_50m'])}, with CEP50/CEP90 = {f(ms['cep50'])}/{f(ms['cep90'])} m.</li>
<li>The accuracy bottleneck is not terminal guidance itself: the median miss distance of completed handovers is {f(mt.get('median'))} m, while {pc(nm / n)} of samples never hand over and account for the vast majority of kilometre-scale failures.</li>
<li>One P0 (zero-noise singularity) and two P1 issues (false-lock handover; handover/acquisition mismatch plus midcourse energy saturation) were located, together with suggested fixes.</li></ol>
<h3>7.1 Suggested follow-up testing</h3><ul>
<li>After fixing P0, rerun the full --converge and miss_budget matrix to quantify numerical error and the contribution of each noise source.</li>
<li>After fixing P1, run an A/B regression on the same seed set, comparing hit rate, no-handover rate and CEP90.</li>
<li>Add fault injection for false lock / dropped frames / datalink interruption, and add a sensitivity sweep over the 25–45 km handover window.</li>
<li>If mission success is defined by lethal radius, re-evaluate at 50 m or the actual warhead radius and report CEP alongside it.</li></ul></section>

<section><h2><span class="num">8</span>Appendix</h2>
<h3>A. All 69 tests</h3><details><summary>Expand individual results</summary>
<table><thead><tr><th>Module</th><th>Case</th><th>Duration (s)</th><th>Result</th></tr></thead><tbody>{test_rows}</tbody></table></details>
<h3>B. Evidence files</h3><table><tbody>
<tr><td>MC raw records</td><td><span class="kv">missile_intercept/output/mc1000/checkpoint.jsonl</span>, batch_results.csv</td></tr>
<tr><td>MC statistics/charts</td><td><span class="kv">output/mc1000/analysis/summary.json</span>, *.png, diagnostics.json</td></tr>
<tr><td>Unit tests</td><td><span class="kv">output/tests/junit.xml</span>, junit_summary.json</td></tr>
<tr><td>Numerical verification</td><td><span class="kv">output/tests/verification.json</span></td></tr>
<tr><td>Aerodynamic cross-check</td><td><span class="kv">output/tests/aero_crosscheck.txt</span></td></tr>
</tbody></table>
<h3>C. Disclaimer</h3><p>The simulation parameters are drawn from public sources plus engineering extrapolation and are intended only for algorithm, software and system-of-systems verification; they do not represent measured data or performance figures of any operational system. The statistical results depend on the dispersion assumptions and random seeds listed in this report.</p></section>
</main><div class="footer">missile_intercept full-flow test report · 2026-11-12 · data from reproducible experiments on this machine</div></body></html>"""

    # Fill in the nominal handover values
    ho_t = f(nom.get("ho_t"), 2) if nom else "—"
    ho_r = f(nom.get("ho_r"), 2) if nom else "—"
    doc = doc.replace("Handover occurs at %s s at a target range of %s km", "Handover occurs at %s s at a target range of %s km" % (ho_t, ho_r))

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(doc)
    print("written:", OUT, len(doc), "chars")


if __name__ == "__main__":
    build()
