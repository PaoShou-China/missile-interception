"""Standalone ITAE tuning of the autopilot gain-schedule table.

Scope
-----
Only the dynamic-pressure gain schedule (the factor multiplying ``KP_RATE``,
``KI_RATE`` and ``KP_ROLL``) is tuned.  The base gains, the 5 Hz command
pre-filter, the anti-windup logic and the feed-forward trim are frozen, so the
result can be applied without re-tuning the rest of the three-loop autopilot.

Plant
-----
A frozen-flight-condition short-period pitch model (alpha, q) derived from the
same aerodynamic coefficients as ``vehicle.missile``:

    alpha_dot = q - Z_alpha*alpha - Z_delta*delta
    q_dot     = M_alpha*alpha + M_q*q + M_delta*delta

with a first-order fin actuator, 100 deg/s rate limit and 25 deg position
limit.  The autopilot itself is the production ``control.autopilot.Autopilot``
class, so the pre-filter, integral clamp and trim feed-forward are identical
to the flight code.

Metric
------
Normalised ITAE of the angle-of-attack step response:

    ITAE = integral_0^T t*|alpha_cmd - alpha(t)| dt  /  (|d_alpha|*T^2/2)

Each case is weighted by its nominal (current 1/q law) ITAE so that low-q and
high-q conditions contribute equally; the cost also contains a worst-case term
and a small smoothness penalty on the table.

Fin rate/position saturation time (union, rate-only, position-only) is
reported per case for both the nominal and the tuned schedule.

Usage
-----
    cd missile_intercept
    python tools/tune_gain_schedule.py
    python tools/tune_gain_schedule.py --maxiter 30 --workers -1

Ref: ITAE step-response tuning, gain scheduling over dynamic pressure.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import differential_evolution

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import config as C                                    # noqa: E402
from control.autopilot import Autopilot               # noqa: E402
from vehicle.atmosphere import get_atmosphere         # noqa: E402
from vehicle.missile import cn_alpha, static_margin, fin_slope_ratio  # noqa: E402

# ------------------------------------------------------------
# Experiment definition
# ------------------------------------------------------------
DT_CTRL = C.DT_AUTOPILOT          # autopilot + fin mixer period
PLANT_SUBSTEPS = max(1, int(round(DT_CTRL / C.DEFAULT_MAX_STEP)))  # plant sub-step = integrator step
T_END = 3.0                       # step-response horizon s
STEP_DEG = (4.0, 10.0)            # small / large angle-of-attack steps
MASS_STATES = (C.MASS0, C.DRY_MASS)

# (altitude m, Mach) pairs chosen to span the flight envelope from the
# stratospheric ceiling (q ~ 10 kPa) to the sea-level supersonic dash
# (q ~ 160 kPa).
FLIGHT_POINTS = (
    (28000.0, 2.0),
    (28000.0, 3.0),
    (22000.0, 3.0),
    (12000.0, 2.0),
    (8000.0, 2.0),
    (0.0, 1.5),
)

Q_IDENTITY = np.array([1.0, 0.0, 0.0, 0.0])
ALPHA_MAX = 25.0 * C.DEG


class AnalyticAutopilot(Autopilot):
    """Reference controller with the original analytic 1/q schedule."""

    def _gain_scale(self, q_dyn, cn_alpha=None, mass=None):
        return float(min(max(self.REF_Q / max(q_dyn, 1.0), 0.3), 3.0))


@dataclass(frozen=True)
class FlightCase:
    alt: float
    mach: float
    mass: float
    q_dyn: float
    speed: float
    cn_a: float
    z_alpha: float
    z_delta: float
    m_alpha: float
    m_delta: float
    m_q: float


def build_case(alt, mach, mass):
    """Derive the reduced short-period coefficients at a frozen condition."""
    atm = get_atmosphere(alt)
    speed = mach * atm.sound_speed
    q_dyn = 0.5 * atm.density * speed * speed

    fuel_fraction = (mass - C.DRY_MASS) / (C.MASS0 - C.DRY_MASS)
    fuel_fraction = min(max(fuel_fraction, 0.0), 1.0)
    cg = C.CG_DRY + fuel_fraction * (C.CG_FULL - C.CG_DRY)
    iyy = C.IYY_DRY + fuel_fraction * (C.IYY_FULL - C.IYY_DRY)

    cn = cn_alpha(mach)
    margin = static_margin(mach, cg)
    cm_a = -cn * margin / C.LENGTH
    cm_de = C.CM_DE * fin_slope_ratio(mach)

    q_s = q_dyn * C.S_REF
    q_s_l = q_s * C.LENGTH
    return FlightCase(
        alt=alt, mach=mach, mass=mass, q_dyn=q_dyn, speed=speed, cn_a=cn,
        z_alpha=q_s * cn / (mass * speed),
        z_delta=q_s * 0.25 / (mass * speed),
        m_alpha=q_s_l * cm_a / iyy,
        m_delta=q_s_l * cm_de / iyy,
        m_q=q_s_l * C.CM_Q * (C.LENGTH / (2.0 * speed)) / iyy,
    )


CASES = tuple(build_case(alt, mach, mass)
              for alt, mach in FLIGHT_POINTS
              for mass in MASS_STATES)

# Table breakpoints: the dynamic pressures of the simulated conditions, so
# every case sits on a tuned node and the table stays identifiable.
_Q_CONDITIONS = sorted({round(case.q_dyn, 3) for case in CASES
                        if case.mass == C.MASS0})
BREAKPOINTS = np.array(sorted(_Q_CONDITIONS), dtype=float)


def nominal_scales(q_points):
    """Current analytic 1/q law sampled at the table breakpoints."""
    return np.array([min(max(Autopilot.REF_Q / max(q, 1.0), 0.3), 3.0)
                     for q in q_points], dtype=float)


def _plant_derivative(alpha, rate, fin, case):
    return (rate - case.z_alpha * alpha - case.z_delta * fin,
            case.m_alpha * alpha + case.m_q * rate + case.m_delta * fin)


def _rk4_step(alpha, rate, fin, case, h):
    k1a, k1q = _plant_derivative(alpha, rate, fin, case)
    k2a, k2q = _plant_derivative(alpha + 0.5 * h * k1a,
                                 rate + 0.5 * h * k1q, fin, case)
    k3a, k3q = _plant_derivative(alpha + 0.5 * h * k2a,
                                 rate + 0.5 * h * k2q, fin, case)
    k4a, k4q = _plant_derivative(alpha + h * k3a, rate + h * k3q, fin, case)
    return (alpha + h / 6.0 * (k1a + 2.0 * k2a + 2.0 * k3a + k4a),
            rate + h / 6.0 * (k1q + 2.0 * k2q + 2.0 * k3q + k4q))


def _actuate(fin, command, dt):
    """Fin mixer pitch channel: rate limit -> first-order lag -> position limit."""
    max_step = C.FIN_RATE_MAX * dt
    delta = float(np.clip(command - fin, -max_step, max_step))
    rate_limited = abs(command - fin) > max_step + 1e-12
    fin = fin + dt / (C.FIN_TAU + dt) * delta
    position_limited = abs(fin) > C.FIN_MAX + 1e-12
    fin = float(np.clip(fin, -C.FIN_MAX, C.FIN_MAX))
    return fin, bool(rate_limited), bool(position_limited)


def simulate(case, step_deg, schedule, autopilot=None):
    """Run one alpha step response and return the normalised ITAE and stats."""
    ap = Autopilot(dt=DT_CTRL) if autopilot is None else autopilot
    ap.reset()
    ap.gain_schedule = schedule

    alpha_step = float(np.clip(step_deg * C.DEG, -ALPHA_MAX, ALPHA_MAX))
    # Back-compute the acceleration command that requests this alpha step.
    a_mag = case.q_dyn * C.S_REF * case.cn_a * alpha_step / case.mass
    a_cmd = np.array([0.0, 0.0, -a_mag])

    alpha = 0.0
    rate = 0.0
    fin = 0.0
    saturated = False
    h = DT_CTRL / PLANT_SUBSTEPS
    n_steps = int(round(T_END / DT_CTRL))

    itae = 0.0
    peak = 0.0
    fin_peak = 0.0
    rate_sat_steps = 0
    pos_sat_steps = 0
    sat_steps = 0

    for k in range(n_steps):
        t = k * DT_CTRL
        virtual = ap.update(
            t, Q_IDENTITY, np.array([0.0, rate, 0.0]), a_cmd, case.mass,
            case.q_dyn, case.cn_a,
            alpha_trim=alpha, beta_trim=0.0,
            is_saturated=saturated, dt=DT_CTRL)
        fin, rate_limited, position_limited = _actuate(
            fin, float(virtual[0]), DT_CTRL)
        rate_sat_steps += int(rate_limited)
        pos_sat_steps += int(position_limited)
        saturated = bool(rate_limited or position_limited)
        sat_steps += int(saturated)
        fin_peak = max(fin_peak, abs(fin))

        for _ in range(PLANT_SUBSTEPS):
            alpha, rate = _rk4_step(alpha, rate, fin, case, h)

        peak = max(peak, abs(alpha))
        itae += t * abs(alpha_step - alpha) * DT_CTRL

    norm = abs(alpha_step) * T_END * T_END * 0.5
    rate_sat_time = rate_sat_steps * DT_CTRL
    pos_sat_time = pos_sat_steps * DT_CTRL
    return {
        "itae": itae / max(norm, 1e-12),
        "peak_deg": float(peak / C.DEG),
        "fin_peak_deg": float(fin_peak / C.DEG),
        "sat_ratio": sat_steps / n_steps,
        "sat_time_s": sat_steps * DT_CTRL,
        "rate_sat_time_s": rate_sat_time,
        "pos_sat_time_s": pos_sat_time,
        "sim_time_s": n_steps * DT_CTRL,
    }


# ------------------------------------------------------------
# Baseline and cost
# ------------------------------------------------------------
def evaluate_table(scales):
    schedule = (BREAKPOINTS, np.asarray(scales, dtype=float))
    results = []
    ap = Autopilot(dt=DT_CTRL)
    for case in CASES:
        for step in STEP_DEG:
            results.append(simulate(case, step, schedule, autopilot=ap))
    return results


def evaluate_baseline():
    results = []
    ap = AnalyticAutopilot(dt=DT_CTRL)
    for case in CASES:
        for step in STEP_DEG:
            results.append(simulate(case, step, None, autopilot=ap))
    return results


BASELINE = evaluate_baseline()
_BASE_ITAE = np.array([r["itae"] for r in BASELINE])


def cost(scales):
    values = np.array([r["itae"] for r in evaluate_table(scales)])
    ratio = values / np.maximum(_BASE_ITAE, 1e-9)
    log_s = np.log(np.maximum(np.asarray(scales, dtype=float), 1e-3))
    log_q = np.log(BREAKPOINTS)
    curvature = np.diff(log_s, 2) / np.diff(log_q)[:-1] ** 2
    return float(ratio.mean() + 0.3 * ratio.max()
                 + 0.002 * np.sum(curvature ** 2))


# ------------------------------------------------------------
# Main
# ------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--maxiter", type=int, default=25)
    parser.add_argument("--popsize", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20261111)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--out", type=Path,
                        default=ROOT / "output" / "gain_schedule_tuning.json")
    args = parser.parse_args(argv)

    x0 = nominal_scales(BREAKPOINTS)
    # Same hard bounds as the analytic scheduler: [0.3, 3.0].
    bounds = [(0.3, 3.0)] * len(BREAKPOINTS)
    base_cost = cost(x0)

    print("Flight conditions (q_dyn in kPa):")
    for alt, mach in FLIGHT_POINTS:
        q = 0.5 * get_atmosphere(alt).density * (mach * get_atmosphere(alt).sound_speed) ** 2
        print("  alt=%6.0f m  M=%.1f  q=%7.1f kPa" % (alt, mach, q / 1000.0))
    print("\nBreakpoints (Pa):", np.round(BREAKPOINTS, 0).tolist())
    print("Nominal scales  :", np.round(x0, 3).tolist())
    print("Nominal cost    : %.5f" % base_cost)
    print("\nRunning differential evolution (%d params, maxiter=%d)..."
          % (len(BREAKPOINTS), args.maxiter))

    result = differential_evolution(
        cost, bounds, x0=x0, seed=args.seed, maxiter=args.maxiter,
        popsize=args.popsize, tol=1e-4, polish=False,
        workers=args.workers, updating="deferred", disp=False)

    tuned = np.asarray(result.x, dtype=float)
    tuned_results = evaluate_table(tuned)
    tuned_cost = cost(tuned)

    print("\nTuned scales    :", np.round(tuned, 3).tolist())
    print("Tuned cost      : %.5f  (nominal %.5f, %+.1f%%)"
          % (tuned_cost, base_cost, 100.0 * (tuned_cost / base_cost - 1.0)))

    # Per-case comparison.
    header = ("  alt[m]  M    mass[kg]  dAlpha[deg] "
              "ITAE base   ITAE tuned   ratio   peak[deg]  fin[deg]  "
              "sat[s]  rate[s]  pos[s]")
    print("\n" + header)
    print("  " + "-" * (len(header) - 2))
    per_case = []
    index = 0
    for case in CASES:
        for step in STEP_DEG:
            base = BASELINE[index]
            new = tuned_results[index]
            index += 1
            print("  %6.0f  %.1f  %7.0f  %9.1f   %9.5f  %10.5f  %6.3f  "
                  "%9.2f  %7.2f  %6.3f  %7.3f  %6.3f"
                  % (case.alt, case.mach, case.mass, step,
                     base["itae"], new["itae"],
                     new["itae"] / max(base["itae"], 1e-12),
                     new["peak_deg"], new["fin_peak_deg"],
                     new["sat_time_s"], new["rate_sat_time_s"],
                     new["pos_sat_time_s"]))
            per_case.append({
                "alt_m": case.alt, "mach": case.mach, "mass_kg": case.mass,
                "q_dyn_pa": round(case.q_dyn, 1), "step_deg": step,
                "itae_baseline": round(base["itae"], 6),
                "itae_tuned": round(new["itae"], 6),
                "ratio": round(new["itae"] / max(base["itae"], 1e-12), 4),
                "peak_deg": round(new["peak_deg"], 3),
                "fin_peak_deg": round(new["fin_peak_deg"], 3),
                "sat_ratio": round(new["sat_ratio"], 4),
                "sat_time_s": round(new["sat_time_s"], 3),
                "sat_time_baseline_s": round(base["sat_time_s"], 3),
                "rate_sat_time_s": round(new["rate_sat_time_s"], 3),
                "pos_sat_time_s": round(new["pos_sat_time_s"], 3),
            })

    payload = {
        "metric": "normalised ITAE, alpha step response, T=%.1f s" % T_END,
        "step_commands_deg": list(STEP_DEG),
        "flight_points": [{"alt_m": a, "mach": m} for a, m in FLIGHT_POINTS],
        "mass_states_kg": list(MASS_STATES),
        "interval": "linear in ln(q_dyn), flat outside the table",
        "q_breakpoints_pa": [round(float(q), 1) for q in BREAKPOINTS],
        "nominal_scale": [round(float(s), 4) for s in x0],
        "tuned_scale": [round(float(s), 4) for s in tuned],
        "cost_nominal": round(base_cost, 6),
        "cost_tuned": round(tuned_cost, 6),
        "mean_itae_ratio": round(float(np.mean(
            [c["ratio"] for c in per_case])), 4),
        "mean_sat_time_s": round(float(np.mean(
            [c["sat_time_s"] for c in per_case])), 4),
        "mean_sat_time_baseline_s": round(float(np.mean(
            [c["sat_time_baseline_s"] for c in per_case])), 4),
        "cases": per_case,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False),
                        encoding="utf-8")
    print("\nWrote %s" % args.out)
    return payload


if __name__ == "__main__":
    main()
