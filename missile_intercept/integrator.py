"""Native fixed-step RK4 integrator with event detection.

The structure follows uniflight's ``FixedStepRK4Integrator``: a deterministic
fixed-step RK4 loop with a state projector applied after every accepted step,
direction-aware guards, guard/timing tolerances, and bisection root refinement
that reconstructs the state by integrating RK4 from the bracket's left edge.

Sampled-data controllers are frozen by the caller in ``before_step``.  Every
RHS evaluation is therefore deterministic and side-effect free, so re-integrating
inside a bracket cannot disturb the multi-rate logic.

``integrate`` is intentionally close to ``scipy.integrate.solve_ivp``:
the returned object exposes ``t``, ``y``, ``t_events``, ``y_events``,
``success``, ``message`` and ``nfev`` so the rest of the project is backend
agnostic.
"""

import math
import numpy as np

__all__ = [
    "IntegrationResult",
    "rk4_step",
    "rk45_step",
    "_crosses",
    "integrate",
]


class IntegrationResult(object):
    """Minimal ``solve_ivp``-like result container."""

    __slots__ = ("t", "y", "t_events", "y_events",
                 "success", "message", "nfev", "nsteps")

    def __init__(self, t, y, t_events=None, y_events=None,
                 success=True, message="", nfev=0, nsteps=0):
        self.t = np.asarray(t, dtype=float)
        self.y = np.asarray(y, dtype=float)
        self.t_events = t_events
        self.y_events = y_events
        self.success = bool(success)
        self.message = str(message)
        self.nfev = int(nfev)
        self.nsteps = int(nsteps)


def rk4_step(f, t, y, h):
    """Classical fourth-order Runge-Kutta step.

    Returns ``(y_next, k1, k4, f_avg)``.  ``f_avg`` is the RK4-weighted mean
    derivative over the step, i.e. the exact average rate used to advance the
    state; sampled-data models (INS mechanisation) must use it instead of the
    endpoint value, which is wrong across discontinuous thrust/actuator
    transients.
    """
    k1 = f(t, y)
    k2 = f(t + 0.5 * h, y + (0.5 * h) * k1)
    k3 = f(t + 0.5 * h, y + (0.5 * h) * k2)
    k4 = f(t + h, y + h * k3)
    y_next = y + (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)
    f_avg = (k1 + 2.0 * k2 + 2.0 * k3 + k4) / 6.0
    return y_next, k1, k4, f_avg


def _rk4_state(f, t, y, h):
    """Advance the state only (no endpoint derivatives kept)."""
    k1 = f(t, y)
    k2 = f(t + 0.5 * h, y + (0.5 * h) * k1)
    k3 = f(t + 0.5 * h, y + (0.5 * h) * k2)
    k4 = f(t + h, y + h * k3)
    return y + (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)


def rk45_step(f, t, y, h):
    """Cash-Karp embedded RK4(5) step with a local error estimate.

    Returns ``(y5, error)``: the fifth-order solution and the difference to
    the embedded fourth-order solution, both matching the state shape.  The
    pair is used by the adaptive reference integrator (uniflight uses SciPy's
    DOP853; this keeps the project dependency-free).
    """
    k1 = f(t, y)
    k2 = f(t + h / 5.0, y + h * (k1 / 5.0))
    k3 = f(t + 3.0 * h / 10.0,
           y + h * (3.0 * k1 / 40.0 + 9.0 * k2 / 40.0))
    k4 = f(t + 3.0 * h / 5.0,
           y + h * (3.0 * k1 / 10.0 - 9.0 * k2 / 10.0 + 6.0 * k3 / 5.0))
    k5 = f(t + h,
           y + h * (-11.0 * k1 / 54.0 + 5.0 * k2 / 2.0
                    - 70.0 * k3 / 27.0 + 35.0 * k4 / 27.0))
    k6 = f(t + 7.0 * h / 8.0,
           y + h * (1631.0 * k1 / 55296.0 + 175.0 * k2 / 512.0
                    + 575.0 * k3 / 13824.0 + 44275.0 * k4 / 110592.0
                    + 253.0 * k5 / 4096.0))
    y5 = y + h * (2825.0 * k1 / 27648.0 + 18575.0 * k3 / 48384.0
                  + 13525.0 * k4 / 55296.0 + 277.0 * k5 / 14336.0
                  + k6 / 4.0)
    y4 = y + h * (37.0 * k1 / 378.0 + 250.0 * k3 / 621.0
                  + 125.0 * k4 / 594.0 + 512.0 * k6 / 1771.0)
    return y5, y5 - y4


def _integrate_adaptive(rhs, t_span, y0, max_step, rtol, atol, max_steps,
                        save_trajectory):
    """Embedded RK45 integration with local-error step control.

    Intended as the high-accuracy reference for verification and for
    continuous-only dynamics: sampled-data callbacks and events are rejected
    by the caller because their ZOH semantics require a fixed sample grid.
    """
    t0 = float(t_span[0])
    t1 = float(t_span[1])
    if t1 < t0:
        raise ValueError("t_span must be increasing")
    if max_step <= 0.0 or rtol <= 0.0 or atol <= 0.0:
        raise ValueError("max_step, rtol and atol must be positive")

    y = np.asarray(y0, dtype=float).reshape(-1).copy()
    t = t0
    h = min(max_step, max((t1 - t0) / 100.0, 1e-12))
    times = [t]
    states = [y.copy()]
    nfev = 0
    nsteps = 0
    success = True
    message = "completed"

    while t < t1 - 1e-12:
        h = min(h, t1 - t)
        y_new, err = rk45_step(rhs, t, y, h)
        nfev += 6
        scale = atol + rtol * np.maximum(np.abs(y), np.abs(y_new))
        err_norm = float(np.max(np.abs(err) / scale)) if err.size else 0.0

        if err_norm <= 1.0:
            t += h
            y = y_new
            nsteps += 1
            if save_trajectory:
                times.append(t)
                states.append(y.copy())
            if nsteps >= max_steps:
                success = False
                message = "max_steps reached"
                break

        factor = 5.0 if err_norm <= 0.0 else 0.9 * err_norm ** (-0.2)
        factor = min(max(factor, 0.2), 5.0)
        h *= factor
        if h < 1e-12:
            success = False
            message = "step size underflow"
            break

    if save_trajectory:
        return IntegrationResult(
            np.asarray(times), np.asarray(states).T, [], [],
            success=success, message=message, nfev=nfev, nsteps=nsteps)
    return IntegrationResult(
        [t], y.reshape(-1, 1), [], [],
        success=success, message=message, nfev=nfev, nsteps=nsteps)


def _crosses(g0, g1, direction):
    """Direction-aware sign-change test (uniflight convention).

    A zero at the left endpoint is deliberately not a fresh root: the caller
    advances past non-terminal events, exactly like uniflight's
    ``_direction_crossed``.
    """
    if direction > 0:
        return g0 < 0.0 and g1 >= 0.0
    if direction < 0:
        return g0 > 0.0 and g1 <= 0.0
    return (g0 < 0.0 <= g1) or (g0 > 0.0 >= g1)


def _guard(event, t, y, tol):
    """Evaluate an event guard and snap values inside ``tol`` to zero."""
    g = float(event(t, y))
    if not math.isfinite(g):
        raise FloatingPointError("Event guard returned a non-finite value")
    return 0.0 if abs(g) <= tol else g


def _refine_root(f, event, ta, ya, tb, yb, ga, gb, direction,
                 time_tol, guard_tol, max_iter):
    """Locate an event inside one step by bisection with RK4 reconstruction.

    The interpolated state comes from integrating the (frozen, side-effect
    free) RHS from the bracket's left edge, matching uniflight's
    ``_refine_root`` and avoiding the O(h^4) error of an endpoint Hermite
    interpolant across a thrust/actuator discontinuity.
    """
    lt, ly, lg = ta, ya.copy(), ga
    rt, ry, rg = tb, yb.copy(), gb
    nfev = 0
    for _ in range(max_iter):
        if rt - lt <= time_tol:
            break
        mt = 0.5 * (lt + rt)
        my = _rk4_state(f, lt, ly, mt - lt)
        nfev += 4
        mg = _guard(event, mt, my, guard_tol)
        if abs(mg) <= guard_tol:
            return mt, my, nfev
        if _crosses(lg, mg, direction):
            rt, ry, rg = mt, my, mg
        else:
            lt, ly, lg = mt, my, mg
    denom = abs(lg) + abs(rg)
    frac = 0.5 if denom == 0.0 else abs(lg) / denom
    root_t = lt + frac * (rt - lt)
    return root_t, _rk4_state(f, lt, ly, root_t - lt), nfev + 4


def integrate(rhs, t_span, y0, step, events=None, before_step=None,
              after_step=None, max_steps=2000000,
              event_time_tolerance=1e-10, event_guard_tolerance=1e-10,
              max_event_iterations=40, method="rk4", rtol=1e-8, atol=1e-10,
              save_trajectory=False):
    """Integrate ``dy/dt = rhs(t, y)`` with a fixed outer step.

    Parameters
    ----------
    rhs : callable(t, y) -> dy
        Continuous dynamics only.  Sampled-data modules must be held constant
        by ``before_step``.
    step : float or callable(t, y) -> float
        Outer step size, or a phase-dependent provider evaluated after
        ``before_step``.  The RK4 stages are internal and do not re-sample.
    events : list of callables with ``terminal`` / ``direction`` attributes
    before_step : callable(t, y)
        Called once at the beginning of every outer step; this is where
        sensors, guidance and actuators are updated (ZOH).
    after_step : callable(t, y, dy)
        Called once after every accepted step; used to refresh cached state.
        ``dy`` is the RK4 average derivative over the step, not the endpoint
        derivative, so an INS can integrate it exactly.
    """
    t0 = float(t_span[0])
    t1 = float(t_span[1])
    if t1 < t0:
        raise ValueError("t_span must be increasing")
    if method not in ("rk4", "rk45"):
        raise ValueError("method must be 'rk4' or 'rk45'")
    if method == "rk45":
        if before_step is not None or after_step is not None or events:
            raise ValueError(
                "rk45 is a continuous-only reference integrator "
                "(no sampled-data callbacks or events)")
        if callable(step):
            raise ValueError("rk45 requires a scalar maximum step")
        return _integrate_adaptive(rhs, (t0, t1), y0, float(step),
                                   float(rtol), float(atol), max_steps,
                                   save_trajectory)
    fixed_step = None if callable(step) else float(step)
    if fixed_step is not None and fixed_step <= 0.0:
        raise ValueError("step must be positive")

    y = np.asarray(y0, dtype=float).reshape(-1).copy()
    ev_list = []
    if events is not None:
        ev_list = list(events) if isinstance(events, (list, tuple)) else [events]
    directions = [getattr(ev, "direction", 0) for ev in ev_list]
    terminals = [getattr(ev, "terminal", False) for ev in ev_list]
    priorities = [getattr(ev, "priority", 0) for ev in ev_list]
    t_events = [[] for _ in ev_list]
    y_events = [[] for _ in ev_list]

    t = t0
    nsteps = 0
    nfev = 0
    success = True
    message = "completed"
    guards = [_guard(ev, t, y, event_guard_tolerance) for ev in ev_list]

    while t < t1 - 1e-12:
        if before_step is not None:
            before_step(t, y)

        h = min(fixed_step if fixed_step is not None else float(step(t, y)),
                t1 - t)
        if h <= 0.0:
            raise ValueError("step provider returned a non-positive step")
        y_next, _f_start, _f_end, f_avg = rk4_step(rhs, t, y, h)
        nfev += 4
        nsteps += 1

        next_guards = [_guard(ev, t + h, y_next, event_guard_tolerance)
                       for ev in ev_list]
        candidates = []
        for i, ev in enumerate(ev_list):
            if _crosses(guards[i], next_guards[i], directions[i]):
                root_t, root_y, used = _refine_root(
                    rhs, ev, t, y, t + h, y_next, guards[i], next_guards[i],
                    directions[i], event_time_tolerance,
                    event_guard_tolerance, max_event_iterations)
                nfev += used
                candidates.append((root_t, i, root_y))

        if candidates:
            root_time = min(c[0] for c in candidates)
            tie_tol = max(event_time_tolerance,
                          16.0 * np.finfo(float).eps * max(1.0, abs(root_time)))
            tied = [c for c in candidates if abs(c[0] - root_time) <= tie_tol]
            tied.sort(key=lambda c: (-priorities[c[1]], c[1]))
            for rt, i, ry in tied:
                t_events[i].append(rt)
                y_events[i].append(ry)

            index = tied[0][1]
            root_t, root_y = tied[0][0], np.array(tied[0][2], dtype=float)
            # Re-evaluate the RHS once at the accepted root: it restores any
            # cached diagnostics a stage-writing RHS may keep and supplies the
            # endpoint derivative for the sampled-data consumers.
            f_root = np.asarray(rhs(root_t, root_y), dtype=float)
            nfev += 1

            if terminals[index]:
                t = root_t
                y = root_y
                message = "terminal event"
                if after_step is not None:
                    after_step(t, y, f_root)
                break

            # Non-terminal event: restart from the root and keep the same ZOH
            # controls for the remainder of the interval.
            t = root_t
            y = root_y
            guards = [_guard(ev, t, y, event_guard_tolerance) for ev in ev_list]
            if after_step is not None:
                after_step(t, y, f_root)
            continue

        t += h
        y = y_next
        guards = next_guards
        if after_step is not None:
            after_step(t, y, f_avg)

        if nsteps >= max_steps:
            success = False
            message = "max_steps reached"
            break

    return IntegrationResult(
        [t], y.reshape(-1, 1), t_events, y_events,
        success=success, message=message, nfev=nfev, nsteps=nsteps)
