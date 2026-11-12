"""Parallel batch test-firing: Monte-Carlo dispersion + multiprocess simulation + statistical report.

Design
------
- Each case is fully described by (SimConfig, Scenario); artifacts are independent and share no mutable state;
- Dispatched to multiple cores via ProcessPoolExecutor (CPU bound, bypasses the GIL);
- Each case's random seed is derived from base_seed + case_id, so runs are reproducible;
- Each case only returns scalar metrics; large telemetry arrays stay inside the child process to avoid IPC overhead;
- Aggregated CSV + miss-distance distribution plot, reporting hit rate / CEP and other firing statistics.

Run:
    python batch.py --cases 50 --workers 8
    python batch.py --cases 20 --workers 4 --duration 600 --no-plot
    python main.py --batch 20 --workers 8

# Ref: Monte-Carlo batch simulation; multiprocessing spawn safe (top-level function serialization)
"""

import argparse
import csv
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, replace

import numpy as np

import config as C
import math_utils as MU
from main import Simulation

# Conversion between 2D circular error probable and per-axis standard deviation (Gaussian CEP = sigma*sqrt(2*ln2))
_CEP_TO_SIGMA = 1.0 / np.sqrt(2.0 * np.log(2.0))


@dataclass
class Dispersion:
    """Firing dispersion parameters (all 1 sigma or 2D CEP, units m / dimensionless)."""
    launch_cep_m: float = 500.0          # launch point horizontal CEP
    target_cep_m: float = 2000.0         # target horizontal CEP
    target_alt_sigma_m: float = 500.0    # target altitude deviation 1sigma
    target_mach_sigma: float = 0.05      # target Mach number deviation 1sigma
    evade_g_sigma: float = 1.0           # target evasive load deviation 1sigma


# ============================================================
# Case construction
# ============================================================
def _offset_llh(lat, lon, east_m, north_m):
    """Convert local east/north offsets in metres into geodetic lat/lon.

    The offset is applied in the local ENU frame and converted back through
    the same LLH<->ECI model as the simulation, so a 200 km offset lands
    where it is meant to on the WGS84 ellipsoid instead of inheriting the
    ~0.3-0.5 % error of a fixed metres-per-degree constant.
    """
    if east_m == 0.0 and north_m == 0.0:
        return lat, lon
    r = MU.llh_to_eci(lat, lon, 0.0, 0.0)
    enu = MU.local_enu_dcm(lat, lon, 0.0)
    r2 = r + enu.dot(np.array([float(east_m), float(north_m), 0.0]))
    la, lo, _ = MU.eci_to_llh(r2, 0.0)
    return la, lo


def build_case(case_id, base_seed, cfg, dispersion):
    """Sample one independent case from the dispersion parameters -> (case_id, cfg, scenario)."""
    rng = np.random.RandomState(int(base_seed) + int(case_id) * 7919)
    base = C.Scenario()

    # Launch point horizontal dispersion
    s_launch = dispersion.launch_cep_m * _CEP_TO_SIGMA
    e_l, n_l = rng.normal(0.0, s_launch, 2) if s_launch > 0 else (0.0, 0.0)
    launch_lat, launch_lon = _offset_llh(base.launch_lat, base.launch_lon, e_l, n_l)

    # Target horizontal/altitude/speed/maneuver dispersion
    s_target = dispersion.target_cep_m * _CEP_TO_SIGMA
    e_t, n_t = rng.normal(0.0, s_target, 2) if s_target > 0 else (0.0, 0.0)
    target_lat, target_lon = _offset_llh(base.target_lat, base.target_lon, e_t, n_t)
    target_alt = base.target_alt + (
        rng.normal(0.0, dispersion.target_alt_sigma_m)
        if dispersion.target_alt_sigma_m > 0 else 0.0)
    target_mach = base.target_mach + (
        rng.normal(0.0, dispersion.target_mach_sigma)
        if dispersion.target_mach_sigma > 0 else 0.0)
    evade_g = base.target_evade_g + (
        rng.normal(0.0, dispersion.evade_g_sigma)
        if dispersion.evade_g_sigma > 0 else 0.0)

    scenario = C.Scenario(
        launch_lat=float(launch_lat), launch_lon=float(launch_lon),
        launch_alt=base.launch_alt,
        target_lat=float(target_lat), target_lon=float(target_lon),
        target_alt=float(max(target_alt, 100.0)),
        target_mach=float(np.clip(target_mach, 0.5, C.TARGET_MACH_MAX)),
        target_evade_g=float(max(evade_g, 0.0)),
        # The target no longer reveals its weave phase: draw it uniformly.
        target_evade_phase=float(rng.uniform(0.0, 2.0 * np.pi)),
        nav_seed=int(rng.randint(0, 100000)),
        seeker_seed=int(rng.randint(0, 100000)),
    )
    return int(case_id), cfg, scenario


# ============================================================
# Child process entry point (must be a module-level function so Windows spawn can serialize it)
# ============================================================
def _handover_fields(sim):
    """Compact handover diagnostics for the batch result / diagnostics tool."""
    ho = sim.handover_trigger or sim.handover_info or {}
    gates = ho.get("gates", {}) or {}
    fov = float(ho.get("fov_angle", float("nan")))
    return {
        "first_lock_time": (float(sim.first_lock_time)
                            if sim.first_lock_time is not None else float("nan")),
        "first_lock_range": (float(sim.first_lock_range)
                             if sim.first_lock_range is not None else float("nan")),
        "first_lock_fov_deg": (float(np.degrees(sim.first_lock_fov))
                               if sim.first_lock_fov is not None else float("nan")),
        "handover_time": float(ho.get("t", float("nan"))),
        "handover_range": float(ho.get("range", float("nan"))),
        "handover_forced": bool(ho.get("forced", False)),
        "handover_fov_deg": float(np.degrees(fov)),
        "handover_fov_margin_deg": float(np.degrees(C.SEEKER_FOV - fov)),
        "handover_tgo": float(ho.get("t_go", float("nan"))),
        "handover_lead_deg": float(np.degrees(ho.get("lead_angle", float("nan")))),
        "handover_n_avail_g": float(ho.get("n_avail", float("nan"))),
        "handover_n_req_g": float(ho.get("n_req", float("nan"))),
        "handover_gates": ",".join(k for k, v in gates.items() if not v),
    }


def _terminal_fields(sim):
    """Endgame command/response summary from the basic telemetry columns."""
    nan = float("nan")
    try:
        d = sim.telemetry.as_dict()
        t = d["time"]
        ho = d["handover"]
        mask = ho > 0.5
        if not np.any(mask):
            return {
                "terminal_duration_s": nan,
                "terminal_peak_cmd_g": nan,
                "terminal_peak_act_g": nan,
                "terminal_fov_max_deg": nan,
                "terminal_lock_loss_pct": nan,
                "terminal_min_range_km": nan,
                "terminal_peak_alpha_deg": nan,
                "terminal_peak_beta_deg": nan,
                "terminal_fin_sat_pct": nan,
            }
        idx = np.where(mask)[0]
        cmd = np.sqrt(d["a_cmd_x"] ** 2 + d["a_cmd_y"] ** 2
                      + d["a_cmd_z"] ** 2) / C.G0
        act = np.sqrt(d["a_act_x"] ** 2 + d["a_act_y"] ** 2
                      + d["a_act_z"] ** 2) / C.G0
        return {
            "terminal_duration_s": float(t[-1] - t[idx[0]]),
            "terminal_peak_cmd_g": float(np.max(cmd[idx])),
            "terminal_peak_act_g": float(np.max(act[idx])),
            "terminal_fov_max_deg": float(np.degrees(np.max(d["fov_angle"][idx]))),
            "terminal_lock_loss_pct": float(100.0 * (1.0 - np.mean(d["seeker_lock"][idx]))),
            "terminal_min_range_km": float(np.min(d["range"][idx]) / 1000.0),
            "terminal_peak_alpha_deg": float(np.degrees(np.max(np.abs(d["alpha"][idx])))),
            "terminal_peak_beta_deg": float(np.degrees(np.max(np.abs(d["beta"][idx])))),
            "terminal_fin_sat_pct": float(100.0 * np.mean(d["fin_sat"][idx])),
        }
    except Exception:  # noqa: BLE001 - diagnostics must never abort a case
        return {
            "terminal_duration_s": nan,
            "terminal_peak_cmd_g": nan,
            "terminal_peak_act_g": nan,
            "terminal_fov_max_deg": nan,
            "terminal_lock_loss_pct": nan,
            "terminal_min_range_km": nan,
        }


def run_case(payload):
    """Execute a single case, returning only scalar metrics."""
    case_id, cfg, scenario = payload
    t0 = time.time()
    try:
        sim = Simulation(cfg, scenario)
        sol = sim.run()
        result = {
            "case_id": case_id,
            "miss_distance": float(sim.miss_distance),
            "miss_time": float(sim.miss_time),
            "final_phase": sim.phase,
            "success": bool(sol.success),
            "log_frames": int(sim.telemetry.n),
            "cpu_time": time.time() - t0,
            "target_lat": scenario.target_lat,
            "target_lon": scenario.target_lon,
            "target_alt": scenario.target_alt,
            "target_mach": scenario.target_mach,
            "evade_g": scenario.target_evade_g,
            "launch_lat": scenario.launch_lat,
            "launch_lon": scenario.launch_lon,
            "error": "",
        }
        result.update(_handover_fields(sim))
        result.update(_terminal_fields(sim))
        return result
    except Exception as exc:  # noqa: BLE001 - a single case failure must not abort the whole batch
        return {
            "case_id": case_id,
            "miss_distance": float("nan"),
            "miss_time": float("nan"),
            "final_phase": "",
            "success": False,
            "log_frames": 0,
            "cpu_time": time.time() - t0,
            "target_lat": scenario.target_lat,
            "target_lon": scenario.target_lon,
            "target_alt": scenario.target_alt,
            "target_mach": scenario.target_mach,
            "evade_g": scenario.target_evade_g,
            "launch_lat": scenario.launch_lat,
            "launch_lon": scenario.launch_lon,
            "error": repr(exc),
            "first_lock_time": float("nan"),
            "first_lock_range": float("nan"),
            "first_lock_fov_deg": float("nan"),
            "handover_time": float("nan"),
            "handover_range": float("nan"),
            "handover_forced": False,
            "handover_fov_deg": float("nan"),
            "handover_fov_margin_deg": float("nan"),
            "handover_tgo": float("nan"),
            "handover_lead_deg": float("nan"),
            "handover_n_avail_g": float("nan"),
            "handover_n_req_g": float("nan"),
            "handover_gates": "",
            "terminal_duration_s": float("nan"),
            "terminal_peak_cmd_g": float("nan"),
            "terminal_peak_act_g": float("nan"),
            "terminal_fov_max_deg": float("nan"),
            "terminal_lock_loss_pct": float("nan"),
            "terminal_min_range_km": float("nan"),
            "terminal_peak_alpha_deg": float("nan"),
            "terminal_peak_beta_deg": float("nan"),
            "terminal_fin_sat_pct": float("nan"),
        }


# ============================================================
# Batch scheduling
# ============================================================
def _load_checkpoint(path):
    """Read completed case records from a JSONL checkpoint."""
    records = []
    if not path or not os.path.isfile(path):
        return records
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except ValueError:
                    continue
    return records


def _append_checkpoint(path, record):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
        f.flush()


def run_batch(n_cases, workers=None, base_seed=2026, cfg=None,
              dispersion=None, lethal_radius=C.WARHEAD_LETHAL_RADIUS,
              output_dir=None, plot=True, checkpoint=None, resume=False):
    """Run n_cases test firings in parallel and aggregate the statistics.

    ``checkpoint`` is a JSONL file appended after every completed case;
    ``resume`` skips case IDs already present there.
    """
    if n_cases <= 0:
        raise ValueError("The number of cases must be positive")
    cfg = cfg if cfg is not None else C.SimConfig()
    dispersion = dispersion if dispersion is not None else Dispersion()
    output_dir = output_dir or os.path.join(cfg.output_dir, "batch")
    workers = int(workers) if workers is not None else (os.cpu_count() or 1)
    workers = max(1, min(workers, n_cases))

    # Per-case config: quiet, pre-allocate telemetry capacity from the log period (avoid 75MB preallocation per core)
    case_cfg = replace(
        cfg,
        verbose=False,
        enable_plot=False,
        telemetry_profile="basic",
        max_steps=max(int(round(cfg.t_end / max(cfg.dt_log, 1e-6))) + 1000, 1000),
    )
    payloads = [build_case(i, base_seed, case_cfg, dispersion)
                for i in range(n_cases)]

    results = []
    if resume and checkpoint:
        done = _load_checkpoint(checkpoint)
        results.extend(done)
        done_ids = {int(r["case_id"]) for r in done}
        payloads = [p for p in payloads if int(p[0]) not in done_ids]
        if cfg.verbose and done:
            print("Resuming from checkpoint: %d cases done, %d remaining"
                  % (len(done), len(payloads)))

    if cfg.verbose:
        print("Batch test firing: %d cases | workers: %d | seed: %s | t_end=%.1fs"
              % (n_cases, workers, base_seed, cfg.t_end))

    t_wall = time.time()

    def _record(res):
        results.append(res)
        if checkpoint:
            os.makedirs(os.path.dirname(os.path.abspath(checkpoint)), exist_ok=True)
            _append_checkpoint(checkpoint, res)

    if workers == 1:
        for k, payload in enumerate(payloads, 1):
            res = run_case(payload)
            _record(res)
            if cfg.verbose:
                _print_progress(k, len(payloads), res)
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(run_case, p): p[0] for p in payloads}
            done = 0
            for fut in as_completed(futures):
                res = fut.result()
                _record(res)
                done += 1
                if cfg.verbose:
                    _print_progress(done, len(payloads), res)
    wall = time.time() - t_wall
    results.sort(key=lambda r: r["case_id"])

    os.makedirs(output_dir, exist_ok=True)
    csv_path = _save_csv(results, output_dir)
    stats = summarize(results, lethal_radius)
    if cfg.verbose:
        _print_summary(stats, wall, workers, csv_path)
    if plot:
        _plot_miss(results, lethal_radius, output_dir)
    return results


def _print_progress(k, total, res):
    miss = ("%.2f m" % res["miss_distance"]) if np.isfinite(res["miss_distance"]) else "NaN"
    err = (" | failed: " + res["error"]) if res["error"] else ""
    print("  [%d/%d] case=%-4d miss=%-10s time=%.1fs%s"
          % (k, total, res["case_id"], miss, res["cpu_time"], err))


# ============================================================
# Statistics and output
# ============================================================
def summarize(results, lethal_radius=C.WARHEAD_LETHAL_RADIUS):
    """Summarize the miss-distance distribution: hit rate / mean / CEP."""
    ok = [r for r in results if not r["error"]]
    misses = np.array([r["miss_distance"] for r in ok], dtype=float)
    misses = misses[np.isfinite(misses)]
    hits = int(np.sum(misses <= float(lethal_radius)))
    return {
        "total": len(results),
        "failed": len(results) - len(ok),
        "valid": int(misses.size),
        "hits": hits,
        "hit_rate": (hits / misses.size) if misses.size else float("nan"),
        "mean": float(np.mean(misses)) if misses.size else float("nan"),
        "std": float(np.std(misses)) if misses.size else float("nan"),
        "min": float(np.min(misses)) if misses.size else float("nan"),
        "max": float(np.max(misses)) if misses.size else float("nan"),
        "cep50": float(np.percentile(misses, 50)) if misses.size else float("nan"),
        "cep90": float(np.percentile(misses, 90)) if misses.size else float("nan"),
        "lethal_radius": float(lethal_radius),
    }


def _save_csv(results, output_dir):
    path = os.path.join(output_dir, "batch_results.csv")
    if not results:
        return path
    fields = list(results[0].keys())
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in results:
            writer.writerow(row)
    return path


def _print_summary(stats, wall, workers, csv_path):
    print("=" * 64)
    print("Batch test firing complete: %d/%d succeeded"
          % (stats["total"] - stats["failed"], stats["total"]))
    print("Hit rate (miss distance <= %.1f m): %.1f%% (%d/%d)"
          % (stats["lethal_radius"], 100.0 * stats["hit_rate"],
             stats["hits"], stats["valid"]))
    print("Miss distance: mean %.2f m | std %.2f m | min %.2f m | max %.2f m"
          % (stats["mean"], stats["std"], stats["min"], stats["max"]))
    print("CEP50: %.2f m | CEP90: %.2f m" % (stats["cep50"], stats["cep90"]))
    print("Total wall clock: %.2f s (workers %d)" % (wall, workers))
    print("Results saved to: %s" % os.path.abspath(csv_path))
    print("=" * 64)


def _plot_miss(results, lethal_radius, output_dir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:  # noqa: BLE001 - silently skip when no plotting environment is available
        return None
    misses = np.array([r["miss_distance"] for r in results if not r["error"]],
                      dtype=float)
    misses = misses[np.isfinite(misses)]
    if misses.size == 0:
        return None

    fig, ax = plt.subplots(figsize=(9, 4.5))
    ax.hist(misses, bins=min(30, max(5, misses.size // 2)),
            color="#4a7ebb", alpha=0.85, edgecolor="white")
    ax.axvline(lethal_radius, color="r", ls="--",
               label="Lethal radius %.1f m" % lethal_radius)
    ax.axvline(np.percentile(misses, 50), color="k", ls=":", label="CEP50")
    ax.set_xlabel("Miss distance (m)")
    ax.set_ylabel("Count")
    ax.set_title("Batch Monte-Carlo Miss Distance Distribution")
    ax.grid(True, alpha=0.3)
    ax.legend()
    fig.tight_layout()
    path = os.path.join(output_dir, "batch_miss_hist.png")
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return os.path.abspath(path)


# ============================================================
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Parallel batch test firing (Monte Carlo)")
    parser.add_argument("--cases", type=int, default=10,
                        help="Number of shots")
    parser.add_argument("--workers", type=int, default=None,
                        help="Number of worker processes; defaults to CPU count")
    parser.add_argument("--seed", type=int, default=2026,
                        help="Base random seed")
    parser.add_argument("--duration", type=float, default=None,
                        help="Total duration of a single simulation, s")
    parser.add_argument("--max-step", type=float, default=None,
                        help="Maximum integration step, s (boost/terminal guidance)")
    parser.add_argument("--midcourse-step", type=float, default=None,
                        help="Midcourse integration step, s")
    parser.add_argument("--lethal-radius", type=float, default=10.0,
                        help="Hit-detection radius, m")
    parser.add_argument("--launch-cep", type=float, default=500.0,
                        help="Launch point horizontal CEP, m")
    parser.add_argument("--target-cep", type=float, default=2000.0,
                        help="Target horizontal CEP, m")
    parser.add_argument("--target-alt-sigma", type=float, default=500.0,
                        help="Target altitude deviation, m")
    parser.add_argument("--target-mach-sigma", type=float, default=0.05,
                        help="Target Mach deviation")
    parser.add_argument("--evade-g-sigma", type=float, default=1.0,
                        help="Target evasive load factor deviation, g")
    parser.add_argument("--out", type=str, default=None,
                        help="Output directory for results")
    parser.add_argument("--checkpoint", type=str, default=None,
                        help="JSONL checkpoint file")
    parser.add_argument("--resume", action="store_true",
                        help="Resume from the checkpoint file")
    parser.add_argument("--no-plot", action="store_true",
                        help="Do not plot the distribution")
    args = parser.parse_args(argv)

    cfg = C.SimConfig()
    if args.max_step is not None:
        cfg.max_step = args.max_step
    if args.midcourse_step is not None:
        cfg.midcourse_max_step = args.midcourse_step
    if args.duration is not None:
        cfg.t_end = args.duration
    cfg.enable_plot = not args.no_plot

    dispersion = Dispersion(
        launch_cep_m=args.launch_cep,
        target_cep_m=args.target_cep,
        target_alt_sigma_m=args.target_alt_sigma,
        target_mach_sigma=args.target_mach_sigma,
        evade_g_sigma=args.evade_g_sigma,
    )
    return run_batch(
        args.cases, workers=args.workers, base_seed=args.seed, cfg=cfg,
        dispersion=dispersion, lethal_radius=args.lethal_radius,
        output_dir=args.out or os.path.join(cfg.output_dir, "batch"),
        plot=cfg.enable_plot, checkpoint=args.checkpoint, resume=args.resume)


if __name__ == "__main__":
    main()
