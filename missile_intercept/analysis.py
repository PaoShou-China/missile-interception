"""Campaign analysis backend: parameter sweeps, Monte Carlo and Sobol indices.

One unified entry point for the three campaign styles used with this simulator:

    python analysis.py sweep spec.json --workers 8
    python analysis.py sobol spec.json --cases 64 --workers 8
    python analysis.py mc --cases 50 --workers 8 --checkpoint output/mc.jsonl --resume

``spec.json`` maps flat dotted parameter paths to either a list of values
(``sweep``: Cartesian product) or a ``[low, high]`` range (``sobol``)::

    {
      "scenario.target_alt": [5000, 10000, 15000],
      "config.midcourse_max_step": [0.005, 0.010]
    }

Each case is a full independent simulation executed in a worker process; the
aggregated miss distances are written to CSV/JSON.  ``mc`` delegates to
``batch.run_batch`` so the Monte-Carlo implementation and its checkpointing
stay in one place.
"""

import argparse
import csv
import itertools
import json
import math
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import replace

import numpy as np

import config as C
from batch import run_case, run_batch


# ------------------------------------------------------------
# Parameter plumbing
# ------------------------------------------------------------
def apply_overrides(cfg, scenario, mapping):
    """Return (cfg, scenario) copies with dotted-path overrides applied."""
    cfg_changes = {}
    scenario_changes = {}
    for path, value in mapping.items():
        if path.startswith("config."):
            cfg_changes[path[len("config."):]] = value
        elif path.startswith("scenario."):
            scenario_changes[path[len("scenario."):]] = value
        else:
            raise ValueError("override path must start with config. or scenario.")
    if cfg_changes:
        cfg = replace(cfg, **cfg_changes)
    if scenario_changes:
        scenario = replace(scenario, **scenario_changes)
    return cfg, scenario


def _eval_case(payload):
    return run_case(payload)


# ============================================================
# Robust objective
# ============================================================
OBJECTIVES = ("miss", "log", "hits")
_MISS_PENALTY = 1.0e5


def objective_value(result, objective="miss"):
    """Map one case result to the scalar used by the campaign analysis.

    The raw miss distribution is extremely heavy-tailed (a handful of
    un-handovered runs dominate the mean), so ``log`` is the default for
    optimisation and ``hits`` turns the metric into the actual hit criterion.
    Failed/invalid runs receive a worst-case penalty in every mode.
    """
    miss = float(result.get("miss_distance", np.nan))
    ok = (not result.get("error")) and np.isfinite(miss)
    if not ok:
        return math.log1p(_MISS_PENALTY) if objective == "log" else _MISS_PENALTY
    if objective == "log":
        return math.log1p(max(miss, 0.0))
    if objective == "hits":
        return 0.0 if miss <= C.WARHEAD_LETHAL_RADIUS else 1.0
    return miss


def _run_cases(case_specs, workers, verbose=True):
    """Run ``(case_id, cfg, scenario)`` specs; return results sorted by id."""
    results = []
    if workers <= 1:
        for k, payload in enumerate(case_specs, 1):
            results.append(_eval_case(payload))
            if verbose:
                _print_case(k, len(case_specs), results[-1])
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_eval_case, p): p[0] for p in case_specs}
            for k, fut in enumerate(as_completed(futures), 1):
                results.append(fut.result())
                if verbose:
                    _print_case(k, len(case_specs), results[-1])
    results.sort(key=lambda r: r["case_id"])
    return results


def _print_case(k, total, res):
    miss = res.get("miss_distance", float("nan"))
    err = res.get("error", "")
    print("  [%d/%d] case=%-5d miss=%10.2f m%s"
          % (k, total, res.get("case_id", -1), miss,
             (" error=" + err) if err else ""))


def _save_csv(path, rows):
    if not rows:
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    keys = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)


# ------------------------------------------------------------
# Sweep
# ------------------------------------------------------------
def _base_config(t_end=None):
    cfg = C.SimConfig(verbose=False, enable_plot=False)
    if t_end is not None:
        cfg.t_end = float(t_end)
    # Match batch.py: size the telemetry buffer from the log period instead of
    # the 200k-frame default (avoids ~75 MB per worker).
    cfg.max_steps = max(int(round(cfg.t_end / max(cfg.dt_log, 1e-6))) + 1000, 1000)
    return cfg


def run_sweep(spec, workers=None, base_seed=2026, out_dir=None,
              t_end=None):
    base_cfg = _base_config(t_end)
    base_scenario = C.Scenario()
    names = list(spec.keys())
    value_lists = [list(spec[n]) for n in names]
    combos = list(itertools.product(*value_lists))

    case_specs = []
    for i, combo in enumerate(combos):
        mapping = dict(zip(names, combo))
        cfg, scenario = apply_overrides(base_cfg, base_scenario, mapping)
        scenario = replace(scenario, nav_seed=int(base_seed) + i,
                           seeker_seed=int(base_seed) + i + 1)
        case_specs.append((i, cfg, scenario))

    results = _run_cases(case_specs, workers or (os.cpu_count() or 1))
    for res, combo in zip(results, combos):
        res["sweep"] = json.dumps(dict(zip(names, combo)), ensure_ascii=False)

    out_dir = out_dir or os.path.join(base_cfg.output_dir, "analysis", "sweep")
    _save_csv(os.path.join(out_dir, "sweep.csv"), results)
    with open(os.path.join(out_dir, "sweep.json"), "w", encoding="utf-8") as f:
        json.dump({"spec": spec, "results": results}, f, indent=2)
    return results


# ------------------------------------------------------------
# Sobol sensitivity (Saltelli sampling, Jansen estimators)
# ------------------------------------------------------------
def sobol_indices(f_a, f_b, f_ab):
    """First-order and total Sobol indices from Saltelli A/B/AB samples.

    ``f_a``/``f_b`` have shape (N,), ``f_ab`` has shape (d, N) where row i is
    the model evaluated on A with column i taken from B.
    """
    f_a = np.asarray(f_a, dtype=float).reshape(-1)
    f_b = np.asarray(f_b, dtype=float).reshape(-1)
    f_ab = np.asarray(f_ab, dtype=float)
    if f_a.shape != f_b.shape or f_ab.shape[1] != f_a.size:
        raise ValueError("inconsistent Saltelli sample shapes")
    var = float(np.var(np.concatenate([f_a, f_b])))
    if var <= 0.0:
        return np.zeros(f_ab.shape[0]), np.zeros(f_ab.shape[0])
    n = f_a.size
    s_first = np.array([
        np.dot(f_b, f_ab[i] - f_a) / n / var for i in range(f_ab.shape[0])
    ])
    s_total = np.array([
        0.5 * np.mean((f_a - f_ab[i]) ** 2) / var
        for i in range(f_ab.shape[0])
    ])
    return s_first, s_total


def _sobol_unit_samples(n, d, seed):
    try:
        from scipy.stats import qmc
        sampler = qmc.Sobol(d=d, scramble=True, seed=seed)
        return sampler.random(n)
    except Exception:  # noqa: BLE001 - fall back to plain random sampling
        return np.random.RandomState(seed).random_sample((n, d))


def run_sobol(spec, n_base=32, workers=None, base_seed=2026, out_dir=None,
              t_end=None, objective="miss"):
    """Estimate first-order/total indices of the miss distance.

    ``objective`` selects the scalar model output: raw miss, log-miss (robust
    to the heavy tail) or the hit indicator at the warhead lethal radius.
    """
    names = list(spec.keys())
    d = len(names)
    if d == 0:
        raise ValueError("sobol spec must contain at least one parameter")
    bounds = [tuple(spec[n]) for n in names]
    for lo, hi in bounds:
        if hi <= lo:
            raise ValueError("sobol ranges must be [low, high] with high > low")

    unit = _sobol_unit_samples(int(n_base), 2 * d, base_seed)
    a_unit = unit[:, :d]
    b_unit = unit[:, d:]
    matrix_a = np.array([[lo + u * (hi - lo) for u, (lo, hi) in zip(row, bounds)]
                         for row in a_unit])
    matrix_b = np.array([[lo + u * (hi - lo) for u, (lo, hi) in zip(row, bounds)]
                         for row in b_unit])

    base_cfg = _base_config(t_end)
    base_scenario = C.Scenario()

    def build(run_id, values):
        mapping = dict(zip(names, values))
        cfg, scenario = apply_overrides(base_cfg, base_scenario, mapping)
        scenario = replace(scenario, nav_seed=int(base_seed) + run_id,
                           seeker_seed=int(base_seed) + run_id + 1)
        return (run_id, cfg, scenario)

    case_specs = []
    case_map = []          # (kind, index)
    run_id = 0
    for i in range(a_unit.shape[0]):
        case_specs.append(build(run_id, matrix_a[i]))
        case_map.append(("A", i))
        run_id += 1
    for i in range(b_unit.shape[0]):
        case_specs.append(build(run_id, matrix_b[i]))
        case_map.append(("B", i))
        run_id += 1
    ab_specs = []
    for j in range(d):
        mixed = matrix_a.copy()
        mixed[:, j] = matrix_b[:, j]
        for i in range(mixed.shape[0]):
            ab_specs.append(build(run_id, mixed[i]))
            case_map.append(("AB", j, i))
            run_id += 1
    case_specs.extend(ab_specs)

    results = _run_cases(case_specs, workers or (os.cpu_count() or 1))
    n = a_unit.shape[0]
    f_a = np.zeros(n)
    f_b = np.zeros(n)
    f_ab = np.zeros((d, n))
    for res, tag in zip(results, case_map):
        value = objective_value(res, objective)
        if tag[0] == "A":
            f_a[tag[1]] = value
        elif tag[0] == "B":
            f_b[tag[1]] = value
        else:
            f_ab[tag[1], tag[2]] = value

    s_first, s_total = sobol_indices(f_a, f_b, f_ab)
    summary = {
        "parameters": names,
        "bounds": bounds,
        "n_base": int(n),
        "first_order": {k: float(v) for k, v in zip(names, s_first)},
        "total": {k: float(v) for k, v in zip(names, s_total)},
        "objective": objective,
        "cases": len(results),
    }
    out_dir = out_dir or os.path.join(base_cfg.output_dir, "analysis", "sobol")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "sobol.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    return summary


# ------------------------------------------------------------
# Robust optimisation (cross-entropy method over the same dotted spec)
# ------------------------------------------------------------
def run_optimize(spec, n_samples=16, iterations=4, elite_frac=0.25,
                 workers=None, base_seed=2026, out_dir=None, t_end=None,
                 objective="log"):
    """Minimise a robust objective over the bounds in ``spec``.

    A small cross-entropy search is used instead of a gradient method
    because the closed-loop miss response is strongly non-linear and
    discontinuous (handover is a state machine).  Optimising log-miss or the
    hit indicator avoids the heavy tail dominating the update.
    """
    names = list(spec.keys())
    d = len(names)
    if d == 0:
        raise ValueError("optimize spec must contain at least one parameter")
    bounds = [tuple(spec[n]) for n in names]
    for lo, hi in bounds:
        if hi <= lo:
            raise ValueError("optimize ranges must be [low, high] with high > low")
    lo = np.array([b[0] for b in bounds], dtype=float)
    hi = np.array([b[1] for b in bounds], dtype=float)
    mean = 0.5 * (lo + hi)
    std = 0.25 * (hi - lo)

    base_cfg = _base_config(t_end)
    base_scenario = C.Scenario()
    rng = np.random.RandomState(int(base_seed))
    workers = workers or (os.cpu_count() or 1)
    run_id = 0
    best = None
    history = []

    for it in range(int(iterations)):
        spread = np.maximum(std, (hi - lo) * 1e-3)
        samples = np.clip(
            mean + rng.normal(size=(int(n_samples), d)) * spread, lo, hi)
        if best is not None:
            samples[0] = np.array([best["values"][n] for n in names])

        specs = []
        for row in samples:
            mapping = dict(zip(names, row.tolist()))
            cfg, scenario = apply_overrides(base_cfg, base_scenario, mapping)
            scenario = replace(scenario, nav_seed=int(base_seed) + run_id,
                               seeker_seed=int(base_seed) + run_id + 1)
            specs.append((run_id, cfg, scenario))
            run_id += 1

        results = _run_cases(specs, workers, verbose=False)
        scores = np.array([objective_value(r, objective) for r in results])
        order = np.argsort(scores)
        k = max(2, int(round(float(elite_frac) * len(samples))))
        elite = samples[order[:k]]
        mean = elite.mean(axis=0)
        std = np.maximum(elite.std(axis=0), (hi - lo) * 0.02)

        idx = int(order[0])
        if best is None or scores[idx] < best["score"]:
            best = {
                "score": float(scores[idx]),
                "values": {n: float(v) for n, v in zip(names, samples[idx])},
                "result": results[idx],
            }
        history.append({
            "iteration": it,
            "best_score": float(scores[idx]),
            "best_miss": float(results[idx].get("miss_distance", np.nan)),
            "elite_mean": {n: float(v) for n, v in zip(names, mean)},
        })
        print("  iter %d: best objective %.4f | miss %.2f m | elite mean %s"
              % (it, scores[idx],
                 float(results[idx].get("miss_distance", np.nan)),
                 {n: round(float(v), 3) for n, v in zip(names, mean)}))

    summary = {
        "parameters": names,
        "bounds": bounds,
        "objective": objective,
        "samples_per_iteration": int(n_samples),
        "iterations": int(iterations),
        "cases": run_id,
        "best_objective": best["score"],
        "best_miss_distance": float(best["result"].get("miss_distance", np.nan)),
        "best_values": best["values"],
        "history": history,
    }
    out_dir = out_dir or os.path.join(base_cfg.output_dir, "analysis", "optimize")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "optimize.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    return summary


# ------------------------------------------------------------
def load_spec(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Campaign analysis backend")
    sub = parser.add_subparsers(dest="command", required=True)

    p_sweep = sub.add_parser("sweep", help="Cartesian parameter sweep")
    p_sweep.add_argument("spec", help="JSON spec of parameter value lists")
    p_sweep.add_argument("--workers", type=int, default=None)
    p_sweep.add_argument("--seed", type=int, default=2026)
    p_sweep.add_argument("--duration", type=float, default=None)
    p_sweep.add_argument("--out", type=str, default=None)

    p_sobol = sub.add_parser("sobol", help="Sobol sensitivity analysis")
    p_sobol.add_argument("spec", help="JSON spec of [low, high] ranges")
    p_sobol.add_argument("--cases", type=int, default=32, help="base sample size N")
    p_sobol.add_argument("--workers", type=int, default=None)
    p_sobol.add_argument("--seed", type=int, default=2026)
    p_sobol.add_argument("--duration", type=float, default=None)
    p_sobol.add_argument("--out", type=str, default=None)
    p_sobol.add_argument("--objective", choices=OBJECTIVES, default="miss")

    p_opt = sub.add_parser("optimize", help="Robust cross-entropy optimisation")
    p_opt.add_argument("spec", help="JSON spec of [low, high] ranges")
    p_opt.add_argument("--samples", type=int, default=16, help="samples per iteration")
    p_opt.add_argument("--iterations", type=int, default=4)
    p_opt.add_argument("--elite-frac", type=float, default=0.25)
    p_opt.add_argument("--workers", type=int, default=None)
    p_opt.add_argument("--seed", type=int, default=2026)
    p_opt.add_argument("--duration", type=float, default=None)
    p_opt.add_argument("--out", type=str, default=None)
    p_opt.add_argument("--objective", choices=OBJECTIVES, default="log")

    p_mc = sub.add_parser("mc", help="Monte Carlo with checkpoint/resume")
    p_mc.add_argument("--cases", type=int, default=10)
    p_mc.add_argument("--workers", type=int, default=None)
    p_mc.add_argument("--seed", type=int, default=2026)
    p_mc.add_argument("--duration", type=float, default=None)
    p_mc.add_argument("--checkpoint", type=str, default=None)
    p_mc.add_argument("--resume", action="store_true")
    p_mc.add_argument("--lethal-radius", type=float,
                      default=C.WARHEAD_LETHAL_RADIUS)
    p_mc.add_argument("--out", type=str, default=None)

    args = parser.parse_args(argv)

    if args.command == "sweep":
        spec = load_spec(args.spec)
        run_sweep(spec, workers=args.workers, base_seed=args.seed,
                  out_dir=args.out, t_end=args.duration)
        return 0
    if args.command == "sobol":
        spec = load_spec(args.spec)
        summary = run_sobol(spec, n_base=args.cases, workers=args.workers,
                            base_seed=args.seed, out_dir=args.out,
                            t_end=args.duration, objective=args.objective)
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0
    if args.command == "optimize":
        spec = load_spec(args.spec)
        summary = run_optimize(spec, n_samples=args.samples,
                               iterations=args.iterations,
                               elite_frac=args.elite_frac,
                               workers=args.workers, base_seed=args.seed,
                               out_dir=args.out, t_end=args.duration,
                               objective=args.objective)
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0

    cfg = C.SimConfig(verbose=True, enable_plot=False)
    if args.duration is not None:
        cfg.t_end = args.duration
    run_batch(args.cases, workers=args.workers, base_seed=args.seed, cfg=cfg,
              lethal_radius=args.lethal_radius,
              output_dir=args.out, plot=False,
              checkpoint=args.checkpoint, resume=args.resume)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
