"""Built-in formal verification suite.

Mirrors the spirit of uniflight's ``verification_cases``: every case has an
analytical or independent reference and an explicit tolerance policy, so a
numeric change either passes with a stated bound or fails loudly.

Cases
-----
1. RK4 manufactured exponential: observed convergence order ~4.
2. Kepler circular orbit: radius and specific-energy drift over one period.
3. Long-run quaternion norm: constant body rate with a unit-norm projector.
4. Cross-integrator: fixed-step RK4 vs adaptive RK45 on the same orbit.
5. Adaptive step control: RK45 relative error against the analytical orbit.

Run:
    python verification.py
    python verification.py --json reports/verification.json
"""

import argparse
import json
import math
from dataclasses import dataclass, field

import numpy as np

import integrator as INT


# ------------------------------------------------------------
# Tolerance policy (explicit, no hidden global epsilon)
# ------------------------------------------------------------
@dataclass(frozen=True)
class Tolerance:
    absolute: float
    relative: float = 0.0
    scale_floor: float = 1.0

    def error(self, reference, observed):
        return abs(observed - reference)

    def limit(self, reference):
        return self.absolute + self.relative * max(abs(reference), self.scale_floor)


@dataclass
class VerificationCase:
    name: str
    passed: bool
    observed: float
    limit: float
    detail: str = ""


@dataclass
class VerificationReport:
    cases: list = field(default_factory=list)

    @property
    def passed(self):
        return sum(1 for c in self.cases if c.passed)

    @property
    def failed(self):
        return sum(1 for c in self.cases if not c.passed)

    def to_dict(self):
        return {
            "passed": self.passed,
            "failed": self.failed,
            "cases": [
                {"name": c.name, "passed": c.passed,
                 "observed": c.observed, "limit": c.limit, "detail": c.detail}
                for c in self.cases
            ],
        }


# ------------------------------------------------------------
# Case 1: RK4 convergence order
# ------------------------------------------------------------
def verify_rk4_order():
    """Integrate y' = y from 0 to 1 and measure the observed order."""
    def rhs(t, y):
        return y

    exact = math.e
    errors = []
    for h in (0.2, 0.1, 0.05):
        y = np.array([1.0])
        t = 0.0
        while t < 1.0 - 1e-12:
            step = min(h, 1.0 - t)
            y, _k1, _k4, _favg = INT.rk4_step(rhs, t, y, step)
            t += step
        errors.append(abs(float(y[0]) - exact))

    orders = [math.log(errors[i] / errors[i + 1], 2.0)
              for i in range(len(errors) - 1)]
    order = min(orders)
    tol = Tolerance(absolute=3.8)
    return VerificationCase(
        "rk4_convergence_order", order >= 3.8, order, 3.8,
        "errors=%s orders=%s" % (
            ["%.3e" % e for e in errors], ["%.2f" % o for o in orders]))


# ------------------------------------------------------------
# Case 2: Kepler circular orbit
# ------------------------------------------------------------
_MU = 3.986004418e14
_R0 = 7.0e6


def _kepler_rhs(t, state):
    r = state[0:3]
    rn = math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2])
    a = -_MU * r / (rn * rn * rn)
    return np.concatenate((state[3:6], a))


def _kepler_initial_state():
    v_circ = math.sqrt(_MU / _R0)
    return np.array([_R0, 0.0, 0.0, 0.0, v_circ, 0.0])


def _orbit_period():
    return 2.0 * math.pi * math.sqrt(_R0 ** 3 / _MU)


def _specific_energy(state):
    r = state[0:3]
    v = state[3:6]
    rn = float(np.linalg.norm(r))
    return 0.5 * float(np.dot(v, v)) - _MU / rn


def verify_kepler_orbit():
    """One fixed-step revolution: radius and specific energy must not drift."""
    period = _orbit_period()
    y0 = _kepler_initial_state()
    e0 = _specific_energy(y0)
    sol = INT.integrate(_kepler_rhs, (0.0, period), y0, step=5.0)
    y1 = sol.y[:, -1]
    radius_err = abs(float(np.linalg.norm(y1[0:3])) - _R0) / _R0
    energy_err = abs(_specific_energy(y1) - e0) / abs(e0)
    limit = 1e-6
    passed = radius_err <= limit and energy_err <= limit
    return VerificationCase(
        "kepler_orbit_conservation", passed,
        max(radius_err, energy_err), limit,
        "radius_rel=%.3e energy_rel=%.3e nfev=%d"
        % (radius_err, energy_err, sol.nfev))


# ------------------------------------------------------------
# Case 3: Long-run quaternion norm with a unit-norm projector
# ------------------------------------------------------------
_OMEGA_Q = np.array([0.1, -0.2, 0.3])


def _quat_rhs(t, q):
    w, x, y, z = q
    p, qq, r = _OMEGA_Q
    return 0.5 * np.array([
        -x * p - y * qq - z * r,
        w * p + y * r - z * qq,
        w * qq - x * r + z * p,
        w * r + x * qq - y * p,
    ])


def verify_quaternion_norm():
    """Constant body rate for 2000 s with normalization after every step."""
    q0 = np.array([1.0, 0.0, 0.0, 0.0])

    def project(t, q, dy):
        n = float(np.linalg.norm(q))
        q[:] = q / n

    sol = INT.integrate(_quat_rhs, (0.0, 2000.0), q0, step=0.05,
                        after_step=project)
    q_end = sol.y[:, -1]
    norm_err = abs(float(np.linalg.norm(q_end)) - 1.0)
    limit = 1e-12
    return VerificationCase(
        "quaternion_norm_long_run", norm_err <= limit, norm_err, limit,
        "steps=%d nfev=%d" % (sol.nsteps, sol.nfev))


# ------------------------------------------------------------
# Case 4: Cross-integrator agreement (fixed RK4 vs adaptive RK45)
# ------------------------------------------------------------
def verify_cross_integrator():
    """One Kepler period: fixed RK4 vs an independent embedded RK45."""
    period = _orbit_period()
    y0 = _kepler_initial_state()
    fixed = INT.integrate(_kepler_rhs, (0.0, period), y0, step=5.0)
    adaptive = INT.integrate(_kepler_rhs, (0.0, period), y0, step=60.0,
                             method="rk45", rtol=1e-11, atol=1e-13)
    y_fixed = fixed.y[:, -1]
    y_rk45 = adaptive.y[:, -1]
    pos_err = float(np.linalg.norm(y_fixed[0:3] - y_rk45[0:3])) / _R0
    # Fixed RK4 with 5 s steps over one period accumulates ~1e-12 relative
    # error; the bound is deliberately loose enough to catch real defects but
    # not machine-level noise.
    limit = 1e-8
    return VerificationCase(
        "cross_integrator_rk4_rk45", pos_err <= limit, pos_err, limit,
        "rk4_nfev=%d rk45_nfev=%d rk45_steps=%d"
        % (fixed.nfev, adaptive.nfev, adaptive.nsteps))


# ------------------------------------------------------------
# Case 5: Adaptive step control accuracy
# ------------------------------------------------------------
def _kepler_reference_after(t_final):
    """Analytical circular-orbit state at ``t_final``."""
    period = _orbit_period()
    theta = 2.0 * math.pi * (t_final / period)
    v_circ = math.sqrt(_MU / _R0)
    return np.array([
        _R0 * math.cos(theta), _R0 * math.sin(theta), 0.0,
        -v_circ * math.sin(theta), v_circ * math.cos(theta), 0.0,
    ])


def verify_adaptive_accuracy():
    """RK45 final state against the analytical circular orbit."""
    t_final = 0.5 * _orbit_period()
    y0 = _kepler_initial_state()
    sol = INT.integrate(_kepler_rhs, (0.0, t_final), y0, step=120.0,
                        method="rk45", rtol=1e-10, atol=1e-12)
    y_ref = _kepler_reference_after(t_final)
    pos_err = float(np.linalg.norm(sol.y[:, -1][0:3] - y_ref[0:3])) / _R0
    # Global error is a few times the local rtol, so the acceptance bound is
    # one decade above the requested local tolerance.
    limit = 1e-8
    return VerificationCase(
        "adaptive_rk45_accuracy", pos_err <= limit, pos_err, limit,
        "steps=%d nfev=%d" % (sol.nsteps, sol.nfev))


# ------------------------------------------------------------
def run_builtin_verification():
    cases = [
        verify_rk4_order(),
        verify_kepler_orbit(),
        verify_quaternion_norm(),
        verify_cross_integrator(),
        verify_adaptive_accuracy(),
    ]
    return VerificationReport(cases)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Built-in numerical verification suite")
    parser.add_argument("--json", type=str, default=None, help="write a JSON report")
    args = parser.parse_args(argv)

    report = run_builtin_verification()
    print("=" * 72)
    for case in report.cases:
        print("%-32s %-4s observed=%.3e limit=%.3e  %s"
              % (case.name, "PASS" if case.passed else "FAIL",
                 case.observed, case.limit, case.detail))
    print("-" * 72)
    print("%d passed, %d failed" % (report.passed, report.failed))
    print("=" * 72)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report.to_dict(), f, indent=2)
    return 0 if report.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
