"""Four controlled guidance/control comparison experiments.

Experiment 1 - boost guidance
    Midcourse/terminal/control fixed at the reference laws; the boost law is
    the classical constant-rate pitch programme (``fixed_rate``) or the
    feasibility-aware gravity-turn programme (``feasible``).  Sweep: target
    altitude (the atmosphere the ascent flies through).

Experiment 2 - midcourse guidance
    Terminal/control fixed; midcourse is classical q-hold + PN-to-PIP
    (``pip_pn``) or Bezier shaping (``bezier``).  Sweep: target evasion load.

Experiment 3 - terminal guidance
    Midcourse/control fixed; terminal is classical true PN (``pn``) or
    ZEM/APN (``zem_apn``).  Sweep: target evasion load.

Experiment 4 - attitude control
    All guidance stages fixed; the autopilot is a fixed-gain three-loop PID
    without gain scheduling or the n_z loop (``classic_pid``) or the
    q-scheduled reference autopilot (``scheduled``).  Sweep: target evasion
    load.

All experiments are paired Monte-Carlo: the same ``case_id`` gives identical
launch/target dispersion, sensor seeds and target manoeuvre phase for every
law, so the only difference is the law under test.  Every case reports the
whole chain: boost exit, midcourse energy, handover geometry, terminal
command effort, fin saturation and final miss distance.

Usage (from ``missile_intercept/``):
    python tools/guidance_comparison.py --quick
    python tools/guidance_comparison.py --cases 24 --workers 24
    python tools/guidance_comparison.py --exp terminal --levels 0,4,8

Outputs (default ``<repo>/docs/experiments/guidance_comparison``):
    all_runs.csv, summary.json, fig_*.png, guidance-comparison-report.md
"""

import argparse
import csv
import json
import os
import sys
import time

for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import numpy as np  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
sys.path.insert(0, ROOT)

import config as C  # noqa: E402
from batch import Dispersion, run_batch  # noqa: E402

LAW_LABEL = {
    "fixed_rate": "常值俯仰速率程序",
    "feasible": "升力可行域自适应程序",
    "pip_pn": "预测拦截点直接中制导",
    "bezier": "Bezier 整形中制导",
    "pn": "经典真比例导引 (PN)",
    "zem_apn": "ZEM/APN 参考律",
    "classic_pid": "固定增益三回路",
    "scheduled": "增益调度三回路",
}
# English labels for figures: matplotlib's default font has no CJK glyphs.
LAW_LABEL_EN = {
    "fixed_rate": "Fixed pitch programme",
    "feasible": "Feasibility-aware programme",
    "pip_pn": "PIP direct midcourse",
    "bezier": "Bezier shaping",
    "pn": "Classical PN",
    "zem_apn": "ZEM/APN",
    "classic_pid": "Fixed-gain PID",
    "scheduled": "Gain-scheduled",
}
# Baseline first within each experiment.
LAW_ORDER = ["fixed_rate", "feasible", "pip_pn", "bezier",
             "pn", "zem_apn", "classic_pid", "scheduled"]
EXP_ORDER = ["boost", "midcourse", "terminal", "control"]
EXP_TITLE = {
    "boost": "Boost guidance",
    "midcourse": "Midcourse guidance",
    "terminal": "Terminal guidance",
    "control": "Attitude control",
}
EXP_TITLE_CN = {
    "boost": "助推段制导",
    "midcourse": "中制导",
    "terminal": "末制导",
    "control": "姿态控制",
}
SWEEP_AXIS_EN = {
    "evade_g": "Target evasion load factor (g)",
    "target_alt_km": "Target altitude (km)",
}
SWEEP_LABEL_CN = {
    "evade_g": "目标机动过载 (g)",
    "target_alt_km": "目标高度 (km)",
}
FIXED_DESC = {
    "boost": "固定：Bezier 中制导 + ZEM/APN 末制导 + 调度三回路",
    "midcourse": "固定：自适应助推 + ZEM/APN 末制导 + 调度三回路",
    "terminal": "固定：自适应助推 + Bezier 中制导 + 调度三回路",
    "control": "固定：自适应助推 + Bezier 中制导 + ZEM/APN 末制导",
}
EXP_SPEC = {
    "boost": {
        "laws": ["fixed_rate", "feasible"],
        "fixed": {"midcourse": "bezier", "terminal": "zem_apn",
                  "control": "scheduled"},
        "sweep": "target_alt_km",
        "levels": [10.0, 15.0, 20.0],
    },
    "midcourse": {
        "laws": ["pip_pn", "bezier"],
        "fixed": {"boost": "feasible", "terminal": "zem_apn",
                  "control": "scheduled"},
        "sweep": "evade_g",
        "levels": [0.0, 3.0, 6.0],
    },
    "terminal": {
        "laws": ["pn", "zem_apn"],
        "fixed": {"boost": "feasible", "midcourse": "bezier",
                  "control": "scheduled"},
        "sweep": "evade_g",
        "levels": [0.0, 2.0, 4.0, 6.0, 8.0],
    },
    "control": {
        "laws": ["classic_pid", "scheduled"],
        "fixed": {"boost": "feasible", "midcourse": "bezier",
                  "terminal": "zem_apn"},
        "sweep": "evade_g",
        "levels": [0.0, 4.0, 8.0],
    },
}


def _ordered_laws(blocks):
    return sorted({law for law, _ in blocks},
                  key=lambda law: LAW_ORDER.index(law)
                  if law in LAW_ORDER else len(LAW_ORDER))


def _sample_counts(blocks):
    """Actual per-block sample counts (checkpoints may hold more than requested)."""
    return sorted({len(v) for v in blocks.values()})


def _count_text(blocks):
    counts = _sample_counts(blocks)
    if not counts:
        return "0"
    if len(counts) == 1:
        return "%d" % counts[0]
    return "%d–%d" % (counts[0], counts[-1])


# ============================================================
# Statistics
# ============================================================
def _finite(results, key):
    return np.array([r[key] for r in results
                     if not r.get("error") and np.isfinite(r.get(key, np.nan))],
                    dtype=float)


def _aggregate(results, lethal_radius):
    miss = _finite(results, "miss_distance")
    ok = [r for r in results if not r.get("error")]
    hand = [r for r in ok if np.isfinite(r.get("handover_range", np.nan))]
    n = miss.size
    return {
        "n_total": len(results),
        "n_valid": int(n),
        "n_failed": len(results) - len(ok),
        "hits": int(np.sum(miss <= lethal_radius)) if n else 0,
        "hit_rate": float(np.mean(miss <= lethal_radius)) if n else float("nan"),
        "miss_mean": float(np.mean(miss)) if n else float("nan"),
        "miss_std": float(np.std(miss)) if n else float("nan"),
        "miss_median": float(np.median(miss)) if n else float("nan"),
        "miss_p90": float(np.percentile(miss, 90)) if n else float("nan"),
        "miss_max": float(np.max(miss)) if n else float("nan"),
        "handover_rate": (len(hand) / len(ok)) if ok else float("nan"),
        "handover_range_km": (float(np.nanmean([r["handover_range"]
                                                for r in hand])) / 1000.0
                              if hand else float("nan")),
        "handover_lead_deg": (float(np.nanmean([r["handover_lead_deg"]
                                                for r in hand]))
                              if hand else float("nan")),
        "boost_end_mach": float(np.nanmean(
            [r.get("boost_end_mach", np.nan) for r in ok])),
        "boost_end_alt_km": float(np.nanmean(
            [r.get("boost_end_alt_km", np.nan) for r in ok])),
        "boost_end_gamma_deg": float(np.nanmean(
            [r.get("boost_end_gamma_deg", np.nan) for r in ok])),
        "boost_peak_alpha_deg": float(np.nanmean(
            [r.get("boost_peak_alpha_deg", np.nan) for r in ok])),
        "boost_fin_sat_pct": float(np.nanmean(
            [r.get("boost_fin_sat_pct", np.nan) for r in ok])),
        "midcourse_peak_mach": float(np.nanmean(
            [r.get("midcourse_peak_mach", np.nan) for r in ok])),
        "midcourse_peak_alt_km": float(np.nanmean(
            [r.get("midcourse_peak_alt_km", np.nan) for r in ok])),
        "handover_energy_mjkg": float(np.nanmean(
            [r.get("handover_specific_energy_mjkg", np.nan) for r in ok])),
        "terminal_peak_cmd_g": float(np.nanmean(
            [r.get("terminal_peak_cmd_g", np.nan) for r in ok])),
        "terminal_peak_act_g": float(np.nanmean(
            [r.get("terminal_peak_act_g", np.nan) for r in ok])),
        "terminal_fin_sat_pct": float(np.nanmean(
            [r.get("terminal_fin_sat_pct", np.nan) for r in ok])),
        "midcourse_fin_sat_pct": float(np.nanmean(
            [r.get("midcourse_fin_sat_pct", np.nan) for r in ok])),
    }


def _paired_test(res_a, res_b, key="miss_distance", n_boot=2000, seed=7):
    """Paired comparison on shared case ids: Wilcoxon + bootstrap median CI."""
    da = {r["case_id"]: r.get(key, np.nan) for r in res_a if not r.get("error")}
    db = {r["case_id"]: r.get(key, np.nan) for r in res_b if not r.get("error")}
    ids = sorted(set(da) & set(db))
    a = np.array([da[i] for i in ids], dtype=float)
    b = np.array([db[i] for i in ids], dtype=float)
    ok = np.isfinite(a) & np.isfinite(b)
    a, b = a[ok], b[ok]
    if a.size < 5:
        return {"n_pairs": int(a.size), "median_diff": float("nan"),
                "ci_low": float("nan"), "ci_high": float("nan"),
                "wilcoxon_p": float("nan")}
    diff = a - b
    rng = np.random.RandomState(seed)
    boots = np.array([np.median(diff[rng.randint(0, diff.size, diff.size)])
                      for _ in range(n_boot)])
    p = float("nan")
    if np.any(np.abs(diff) > 1e-9):
        try:
            from scipy.stats import wilcoxon
            p = float(wilcoxon(a, b).pvalue)
        except Exception:  # noqa: BLE001 - stats are optional
            p = float("nan")
    return {
        "n_pairs": int(a.size),
        "median_diff": float(np.median(diff)),
        "ci_low": float(np.percentile(boots, 2.5)),
        "ci_high": float(np.percentile(boots, 97.5)),
        "wilcoxon_p": p,
    }


# ============================================================
# Experiment execution
# ============================================================
def _run_block(cfg, level, sweep, cases, workers, base_seed, out_dir,
               lethal_radius, exp_name=""):
    if sweep == "target_alt_km":
        # Target manoeuvre is held fixed at its nominal value so the boost
        # comparison isolates the ascent programme rather than adding extra
        # terminal-phase variance.
        dispersion = Dispersion(
            launch_cep_m=500.0, target_cep_m=2000.0,
            target_alt_sigma_m=500.0, target_mach_sigma=0.05,
            evade_g_sigma=0.0, target_alt_nominal=float(level) * 1000.0)
    else:
        dispersion = Dispersion(
            launch_cep_m=500.0, target_cep_m=2000.0,
            target_alt_sigma_m=500.0, target_mach_sigma=0.05,
            evade_g_sigma=0.0, evade_g_nominal=float(level))

    raw = os.path.join(out_dir, "raw")
    os.makedirs(raw, exist_ok=True)
    # Keep the historical tag for the reference configuration so earlier
    # checkpoints remain valid; add a stage prefix only when that stage is
    # switched away from its default.
    parts = []
    if exp_name.startswith("boost"):
        # The boost sweep varies target altitude, whose numeric level can
        # collide with an evasion-g level; namespace by experiment and law.
        parts.append(exp_name)
    elif cfg.boost_law != "feasible":
        parts.append("boost_" + cfg.boost_law)
    parts.extend([cfg.midcourse_law, cfg.terminal_law])
    if cfg.control_law != "scheduled":
        parts.append("ctrl_" + cfg.control_law)
    tag = "_".join(parts) + ("_g%g" % level)
    t0 = time.time()
    results = run_batch(
        cases, workers=workers, base_seed=base_seed, cfg=cfg,
        dispersion=dispersion, lethal_radius=lethal_radius,
        output_dir=os.path.join(raw, tag), plot=False,
        checkpoint=os.path.join(raw, tag, "cases.jsonl"), resume=True)
    print("  %-52s %5.1f s" % (tag, time.time() - t0))
    if len(results) != cases:
        print("      (checkpoint holds %d cases for this block)" % len(results))
    # Checkpoints written before a new law field existed would leave the CSV
    # column empty.  The block config is the source of truth, so backfill it.
    for r in results:
        for field in ("boost_law", "midcourse_law", "terminal_law",
                      "control_law"):
            if not r.get(field):
                r[field] = getattr(cfg, field)
    return results


def _run_experiment(name, cases, levels, workers, base_seed, out_dir,
                    lethal_radius, verbose=True):
    """Run one experiment: every law x every sweep level, paired by case id."""
    spec = EXP_SPEC[name]
    blocks = {}
    for law in spec["laws"]:
        for level in levels:
            cfg = C.SimConfig()
            for stage, fixed_law in spec["fixed"].items():
                setattr(cfg, stage + "_law", fixed_law)
            setattr(cfg, name + "_law", law)
            if verbose:
                print("[%s] law=%s level=%g" % (name, law, level))
            exp_tag = ("%s_%s" % (name, law)) if name == "boost" else name
            blocks[(law, level)] = _run_block(
                cfg, level, spec["sweep"], cases, workers, base_seed,
                out_dir, lethal_radius, exp_name=exp_tag)
    return blocks


# ============================================================
# Outputs
# ============================================================
def _save_all_runs(experiments, out_dir):
    rows = []
    for name in EXP_ORDER:
        if name not in experiments:
            continue
        for (law, level), results in experiments[name].items():
            for r in results:
                row = dict(r)
                row["experiment"] = name
                row["sweep_level"] = level
                rows.append(row)
    path = os.path.join(out_dir, "all_runs.csv")
    if not rows:
        return path
    fields = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return path


def _plot(experiments, levels_by_exp, lethal_radius, out_dir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:  # noqa: BLE001
        return []

    paths = []
    colors = ["#d1495b", "#00798c"]

    # One figure per experiment: miss distribution + hit rate.
    for name in EXP_ORDER:
        if name not in experiments:
            continue
        blocks = experiments[name]
        levels = levels_by_exp[name]
        laws = _ordered_laws(blocks)
        xlabel = SWEEP_AXIS_EN[EXP_SPEC[name]["sweep"]]
        fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))
        for k, law in enumerate(laws):
            data = []
            for level in levels:
                m = _finite(blocks[(law, level)], "miss_distance")
                data.append(m[m > 0] if m.size else np.array([1e-3]))
            bp = axes[0].boxplot(
                data, positions=np.arange(len(levels)) + (k - 0.5) * 0.32,
                widths=0.28, patch_artist=True, showfliers=False)
            for patch in bp["boxes"]:
                patch.set_facecolor(colors[k % len(colors)])
                patch.set_alpha(0.75)
            rates = []
            for lv in levels:
                m = _finite(blocks[(law, lv)], "miss_distance")
                rates.append(np.mean(m <= lethal_radius) if m.size else np.nan)
            axes[1].plot(levels, rates, "o-", color=colors[k % len(colors)],
                         label=LAW_LABEL_EN.get(law, law), lw=2)
        axes[0].set_yscale("log")
        axes[0].set_xlabel(xlabel)
        axes[0].set_ylabel("Miss distance (m, log scale)")
        axes[0].set_title("%s: miss distribution" % EXP_TITLE[name])
        axes[0].set_xticks(np.arange(len(levels)))
        axes[0].set_xticklabels(["%g" % lv for lv in levels])
        axes[0].grid(True, alpha=0.3)
        axes[1].set_xlabel(xlabel)
        axes[1].set_ylabel("Hit rate (miss <= %.0f m)" % lethal_radius)
        axes[1].set_ylim(-0.03, 1.03)
        axes[1].set_title("%s: hit rate" % EXP_TITLE[name])
        axes[1].grid(True, alpha=0.3)
        axes[1].legend(fontsize=8)
        fig.tight_layout()
        path = os.path.join(out_dir, "fig_%s.png" % name)
        fig.savefig(path, dpi=140)
        plt.close(fig)
        paths.append(path)

    # Stage figure: boost exit for the boost experiment, handover for midcourse,
    # control effort for the autopilot experiment.
    stage_panels = [
        ("boost", "boost_end_alt_km", "boost_fin_sat_pct",
         "Boost exit altitude (km)", "Boost fin saturation (%)",
         "fig_boost_stages.png"),
        ("midcourse", "handover_lead_deg", "handover_specific_energy_mjkg",
         "Handover lead angle (deg)", "Energy at handover (MJ/kg)",
         "fig_midcourse_stages.png"),
        ("control", "terminal_peak_act_g", "terminal_fin_sat_pct",
         "Terminal peak achieved load (g)", "Terminal fin saturation (%)",
         "fig_control_stages.png"),
    ]
    for name, key_a, key_b, lab_a, lab_b, fname in stage_panels:
        if name not in experiments:
            continue
        blocks = experiments[name]
        levels = levels_by_exp[name]
        laws = _ordered_laws(blocks)
        xlabel = SWEEP_AXIS_EN[EXP_SPEC[name]["sweep"]]
        fig, axes = plt.subplots(1, 2, figsize=(11, 4.0))
        for k, law in enumerate(laws):
            va = [np.nanmean([r.get(key_a, np.nan) for r in blocks[(law, lv)]])
                  for lv in levels]
            vb = [np.nanmean([r.get(key_b, np.nan) for r in blocks[(law, lv)]])
                  for lv in levels]
            axes[0].plot(levels, va, "o-", color=colors[k % len(colors)],
                         label=LAW_LABEL_EN.get(law, law), lw=2)
            axes[1].plot(levels, vb, "o-", color=colors[k % len(colors)],
                         label=LAW_LABEL_EN.get(law, law), lw=2)
        axes[0].set_xlabel(xlabel)
        axes[0].set_ylabel(lab_a)
        axes[0].set_title(lab_a)
        axes[1].set_xlabel(xlabel)
        axes[1].set_ylabel(lab_b)
        axes[1].set_title(lab_b)
        for ax in axes:
            ax.grid(True, alpha=0.3)
            ax.legend(fontsize=8)
        fig.tight_layout()
        path = os.path.join(out_dir, fname)
        fig.savefig(path, dpi=140)
        plt.close(fig)
        paths.append(path)

    # Pooled miss CDF per experiment (all sweep levels).
    names = [n for n in EXP_ORDER if n in experiments]
    fig, axes = plt.subplots(2, 2, figsize=(11, 8), squeeze=False)
    for ax, name in zip(axes.ravel(), names):
        blocks = experiments[name]
        laws = _ordered_laws(blocks)
        for k, law in enumerate(laws):
            pooled = np.concatenate([
                _finite(blocks[(law, lv)], "miss_distance")
                for lv in levels_by_exp[name]
                if (law, lv) in blocks
                and _finite(blocks[(law, lv)], "miss_distance").size])
            if pooled.size == 0:
                continue
            x = np.sort(pooled)
            y = np.arange(1, x.size + 1) / float(x.size)
            ax.plot(x, y, lw=2, color=colors[k % len(colors)],
                    label=LAW_LABEL_EN.get(law, law))
        ax.axvline(lethal_radius, color="k", ls="--", lw=1,
                   label="Hit threshold %.0f m" % lethal_radius)
        ax.set_xscale("log")
        ax.set_xlabel("Miss distance (m, log scale)")
        ax.set_ylabel("Cumulative probability")
        ax.set_title("%s: pooled miss CDF" % EXP_TITLE[name])
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
    for ax in axes.ravel()[len(names):]:
        ax.axis("off")
    fig.tight_layout()
    path = os.path.join(out_dir, "fig_cdf.png")
    fig.savefig(path, dpi=140)
    plt.close(fig)
    paths.append(path)
    return paths


def _fmt(v, nd=2):
    if v is None or not np.isfinite(v):
        return "—"
    return ("%%.%df" % nd) % v


def _write_report(experiments, levels_by_exp, stats, out_dir, args,
                  lethal_radius, figure_paths):
    lines = []
    add = lines.append
    add("# 制导与控制算法对比实验报告")
    add("")
    add("本报告由 `tools/guidance_comparison.py` 自动生成，全部数据来自 6DOF "
        "端到端仿真，未经手工修改。")
    add("")
    add("## 1. 实验设计")
    add("")
    add("四个实验均采用**配对蒙特卡洛**：同一 `case_id` 在两种算法下使用完全相同的"
        "发射点/目标点散布、高度/马赫散布、导航与导引头随机种子以及目标机动相位，"
        "因此同一 case 的差异只来自被测环节的算法。每次只替换一个环节，其余三个"
        "环节固定为参考算法。")
    add("")
    add("| 实验 | 被测环节 | 对比算法 | 固定配置 | 扫描参数 | 每档样本 |")
    add("| --- | --- | --- | --- | --- | --- |")
    for name in EXP_ORDER:
        if name not in experiments:
            continue
        spec = EXP_SPEC[name]
        laws = spec["laws"]
        add("| %s | %s | %s vs %s | %s | %s %s | %s |"
            % (EXP_TITLE_CN[name], EXP_TITLE_CN[name],
               LAW_LABEL.get(laws[0], laws[0]), LAW_LABEL.get(laws[1], laws[1]),
               FIXED_DESC[name], SWEEP_LABEL_CN[spec["sweep"]],
               ", ".join("%g" % lv for lv in levels_by_exp[name]),
               _count_text(experiments[name])))
    add("")
    add("公共设置：基础随机种子 %d，命中判据为脱靶量 ≤ %.1f m；发射点水平 CEP "
        "500 m、目标水平 CEP 2000 m、目标高度 σ 500 m、目标马赫 σ 0.05；"
        "弹体、导航/导引头、交接逻辑与未被测环节全部相同。"
        % (args.seed, lethal_radius))
    add("换算说明：助推段实验扫描的是**目标高度**（km），目标机动档固定为额定值；"
        "其余三个实验扫描**目标机动过载**（g），目标高度按额定值加散布。")
    add("")
    # The target manoeuvre is lift-limited, so high command levels saturate at
    # the wing's available load factor and become physically identical.
    for name in EXP_ORDER:
        if name not in experiments:
            continue
        levels = levels_by_exp[name]
        for law in _ordered_laws(experiments[name]):
            dup = []
            for i, lv_a in enumerate(levels):
                for lv_b in levels[i + 1:]:
                    a = _finite(experiments[name][(law, lv_a)], "miss_distance")
                    b = _finite(experiments[name][(law, lv_b)], "miss_distance")
                    if (a.size and a.size == b.size
                            and np.allclose(np.sort(a), np.sort(b))):
                        dup.append((lv_a, lv_b))
            if dup:
                add("> 注意：%s 的 " % LAW_LABEL.get(law, law)
                    + "、".join("%g 与 %g" % d for d in dup)
                    + " 结果完全一致，原因是目标在 15 km / 跨声速段的可用升力"
                      "只有约 3–4 g，更高的指令过载被升力限幅截断，属于模型"
                      "物理约束而非数值退化。")
                add("")

    for idx, name in enumerate([n for n in EXP_ORDER if n in experiments], 2):
        blocks = experiments[name]
        levels = levels_by_exp[name]
        laws = _ordered_laws(blocks)
        spec = EXP_SPEC[name]
        add("## %d. %s对比结果" % (idx, EXP_TITLE_CN[name]))
        add("")
        add("### 统计汇总")
        add("")
        add("| %s | 算法 | 有效样本 | 命中率 | 中位脱靶 (m) | P90 脱靶 (m) | "
            "最大脱靶 (m) | 交接率 | 交接距离 (km) |" % SWEEP_LABEL_CN[spec["sweep"]])
        add("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for level in levels:
            for law in laws:
                s = stats[name][(law, level)]
                add("| %g | %s | %d | %.1f%% | %s | %s | %s | %s | %s |"
                    % (level, LAW_LABEL.get(law, law), s["n_valid"],
                       100.0 * s["hit_rate"], _fmt(s["miss_median"], 1),
                       _fmt(s["miss_p90"], 1), _fmt(s["miss_max"], 0),
                       _fmt(100.0 * s["handover_rate"], 0),
                       _fmt(s["handover_range_km"], 1)))
        add("")
        add("### 全阶段指标（各扫描档平均）")
        add("")
        add(("| %s | 算法 | 助推退出马赫 | 助推退出高度 (km) | 中制导峰值马赫 | "
             "交接比能量 (MJ/kg) | 末制导峰值指令 (g) | 末制导峰值过载 (g) | "
             "末制导舵面饱和 (%%) | 交接方位角 (°) |"
             % SWEEP_LABEL_CN[spec["sweep"]]))
        add("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for level in levels:
            for law in laws:
                s = stats[name][(law, level)]
                add("| %g | %s | %s | %s | %s | %s | %s | %s | %s | %s |"
                    % (level, LAW_LABEL.get(law, law),
                       _fmt(s["boost_end_mach"], 2),
                       _fmt(s["boost_end_alt_km"], 1),
                       _fmt(s["midcourse_peak_mach"], 2),
                       _fmt(s["handover_energy_mjkg"], 2),
                       _fmt(s["terminal_peak_cmd_g"], 1),
                       _fmt(s["terminal_peak_act_g"], 1),
                       _fmt(s["terminal_fin_sat_pct"], 1),
                       _fmt(s["handover_lead_deg"], 2)))
        add("")
        add("### 配对显著性检验（Wilcoxon 符号秩 + Bootstrap 中位数差 95% CI）")
        add("")
        add("| %s | 对比 | 配对数 | 中位差 (m) | 95%% CI | p 值 | 结论 |"
            % SWEEP_LABEL_CN[spec["sweep"]])
        add("| --- | --- | --- | --- | --- | --- | --- |")
        law_a, law_b = laws[0], laws[1]
        for level in levels:
            p = _paired_test(blocks[(law_a, level)], blocks[(law_b, level)])
            verdict = ("差异显著" if np.isfinite(p["wilcoxon_p"])
                       and p["wilcoxon_p"] < 0.05 else "未见显著差异")
            add("| %g | %s - %s | %d | %s | [%s, %s] | %s | %s |"
                % (level, LAW_LABEL.get(law_a, law_a),
                   LAW_LABEL.get(law_b, law_b), p["n_pairs"],
                   _fmt(p["median_diff"], 1), _fmt(p["ci_low"], 1),
                   _fmt(p["ci_high"], 1), _fmt(p["wilcoxon_p"], 3), verdict))
        add("")

    section = 2 + len([n for n in EXP_ORDER if n in experiments])
    add("## %d. 结论" % section)
    add("")
    add(_conclusions(experiments, levels_by_exp, stats))
    add("")
    add("## %d. 方法与可复现性" % (section + 1))
    add("")
    add("- 仿真：6DOF 刚体 + 四元数姿态，RK4 变步长积分，制导 5 ms / 控制 5 ms / "
        "导引头与导航按各自周期零阶保持。")
    add("- 对比公平性：未被测环节完全固定；同一实验内两种算法共享同一时间对齐、"
        "导引头几何、重力补偿、FOV 保护、指令平滑与过载限幅管线。")
    add("- 控制对比说明：两种自动驾驶仪共用同一参考调节器、时延预测、内外环增益"
        "基准值、抗积分饱和与舵面限幅；差异仅为增益调度与法向过载环。姿态控制"
        "实验的参考组与末制导实验的参考组是同一配置，故两组参考数据逐 case 相同。")
    add(("- 统计：命中率为脱靶量 ≤ %.1f m 的比例；配对检验对同一 case 的脱靶量做 "
         "Wilcoxon 符号秩检验，Bootstrap（2000 次）给出中位数差 95%% 置信区间。"
         % lethal_radius))
    add("- 复现命令：`python tools/guidance_comparison.py --cases %d --seed %d`"
        % (args.cases, args.seed))
    add("")
    add("## %d. 适用边界" % (section + 2))
    add("")
    add("弹体几何、质量/惯量与气动/推进参数为公开资料的工程外推（见仓库 README 免责声明），"
        "实验结论只对该模型成立，不代表任何实装系统性能。")
    add("")
    if figure_paths:
        add("## 图表")
        add("")
        for path in figure_paths:
            add("![%s](%s)" % (os.path.basename(path), os.path.basename(path)))
            add("")

    path = os.path.join(out_dir, "guidance-comparison-report.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def _conclusions(experiments, levels_by_exp, stats):
    """Generate data-driven conclusion bullets (no hard-coded outcome)."""
    out = []
    for name in EXP_ORDER:
        if name not in experiments:
            continue
        blocks = experiments[name]
        levels = levels_by_exp[name]
        laws = _ordered_laws(blocks)
        a, b = laws[0], laws[1]
        sig = 0
        diffs = []
        for level in levels:
            p = _paired_test(blocks[(a, level)], blocks[(b, level)])
            if np.isfinite(p["wilcoxon_p"]) and p["wilcoxon_p"] < 0.05:
                sig += 1
            if np.isfinite(p["median_diff"]):
                diffs.append(p["median_diff"])
        ha = np.nanmean([stats[name][(a, lv)]["hit_rate"] for lv in levels])
        hb = np.nanmean([stats[name][(b, lv)]["hit_rate"] for lv in levels])
        ma = np.nanmean([stats[name][(a, lv)]["miss_median"] for lv in levels])
        mb = np.nanmean([stats[name][(b, lv)]["miss_median"] for lv in levels])
        diff_txt = ("配对中位差（%s − %s）范围 %s ~ %s m，正值为前者脱靶量更大；"
                    % (LAW_LABEL.get(a, a), LAW_LABEL.get(b, b),
                       _fmt(min(diffs), 1) if diffs else "—",
                       _fmt(max(diffs), 1) if diffs else "—"))
        text = ("- **%s**：%s 平均命中率 %.1f%%，%s 为 %.1f%%；平均中位脱靶量 "
                "%s m 与 %s m。%s在 %d/%d 个扫描档上配对差异达到 p < 0.05。"
                % (EXP_TITLE_CN[name], LAW_LABEL.get(a, a), 100.0 * ha,
                   LAW_LABEL.get(b, b), 100.0 * hb, _fmt(ma, 1), _fmt(mb, 1),
                   diff_txt, sig, len(levels)))
        if name == "boost":
            ea = np.nanmean([stats[name][(a, lv)]["boost_end_alt_km"]
                             for lv in levels])
            eb = np.nanmean([stats[name][(b, lv)]["boost_end_alt_km"]
                             for lv in levels])
            sa = np.nanmean([stats[name][(a, lv)]["boost_fin_sat_pct"]
                             for lv in levels])
            sb = np.nanmean([stats[name][(b, lv)]["boost_fin_sat_pct"]
                             for lv in levels])
            text += ("助推退出高度 %s / %s km，助推段舵面饱和率 %s%% / %s%%。"
                     % (_fmt(ea, 2), _fmt(eb, 2), _fmt(sa, 1), _fmt(sb, 1)))
        elif name == "midcourse":
            ea = np.nanmean([stats[name][(a, lv)]["handover_energy_mjkg"]
                             for lv in levels])
            eb = np.nanmean([stats[name][(b, lv)]["handover_energy_mjkg"]
                             for lv in levels])
            la = np.nanmean([stats[name][(a, lv)]["handover_lead_deg"]
                             for lv in levels])
            lb = np.nanmean([stats[name][(b, lv)]["handover_lead_deg"]
                             for lv in levels])
            text += ("交接比能量 %s / %s MJ/kg，交接方位角 %s / %s°。"
                     % (_fmt(ea, 2), _fmt(eb, 2), _fmt(la, 2), _fmt(lb, 2)))
        elif name == "terminal":
            ca = np.nanmean([stats[name][(a, lv)]["terminal_peak_cmd_g"]
                             for lv in levels])
            cb = np.nanmean([stats[name][(b, lv)]["terminal_peak_cmd_g"]
                             for lv in levels])
            text += ("末制导平均峰值指令 %s / %s g。"
                     % (_fmt(ca, 1), _fmt(cb, 1)))
        elif name == "control":
            sa = np.nanmean([stats[name][(a, lv)]["terminal_fin_sat_pct"]
                             for lv in levels])
            sb = np.nanmean([stats[name][(b, lv)]["terminal_fin_sat_pct"]
                             for lv in levels])
            ga = np.nanmean([stats[name][(a, lv)]["terminal_peak_act_g"]
                             for lv in levels])
            gb = np.nanmean([stats[name][(b, lv)]["terminal_peak_act_g"]
                             for lv in levels])
            text += ("末制导平均舵面饱和率 %s%% / %s%%，峰值实际过载 %s / %s g。"
                     % (_fmt(sa, 1), _fmt(sb, 1), _fmt(ga, 1), _fmt(gb, 1)))
        out.append(text)
    out.append("- 四个实验中的“差异显著”仅表示在该模型、该样本量与配对设计下统计"
               "可分辨，不构成对其他弹体/传感器配置的外推结论。")
    return "\n".join(out)


# ============================================================
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Four paired guidance/control comparison experiments")
    parser.add_argument("--exp", default="all",
                        choices=["all"] + EXP_ORDER)
    parser.add_argument("--cases", type=int, default=24,
                        help="cases per law per sweep level")
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--levels", default=None,
                        help="override sweep levels for every experiment")
    parser.add_argument("--lethal-radius", type=float,
                        default=C.WARHEAD_LETHAL_RADIUS)
    parser.add_argument("--out", default=os.path.join(
        REPO, "docs", "experiments", "guidance_comparison"))
    parser.add_argument("--quick", action="store_true",
                        help="small smoke campaign")
    args = parser.parse_args(argv)
    if args.cases < 1:
        parser.error("--cases must be >= 1")

    levels_override = ([float(x) for x in args.levels.split(",")]
                       if args.levels else None)
    levels_by_exp = {}
    for name in EXP_ORDER:
        if name not in EXP_SPEC:
            continue
        spec = EXP_SPEC[name]
        if levels_override:
            levels_by_exp[name] = levels_override
        elif args.quick:
            levels_by_exp[name] = spec["levels"][:2]
        else:
            levels_by_exp[name] = spec["levels"]
    if args.quick:
        args.cases = 4
    os.makedirs(args.out, exist_ok=True)
    workers = args.workers or max(1, min(24, os.cpu_count() or 1))

    selected = EXP_ORDER if args.exp == "all" else [args.exp]
    for name in selected:
        if EXP_SPEC[name]["sweep"] == "target_alt_km":
            bad = [lv for lv in levels_by_exp[name] if not (1.0 <= lv <= 30.0)]
            if bad:
                print("WARNING: boost experiment levels are target altitudes in "
                      "km; %s is outside [1, 30] km." % bad)
    print("=" * 72)
    print("Guidance/control comparison | cases=%d | workers=%d | seed=%d"
          % (args.cases, workers, args.seed))
    print("Experiments: %s" % ", ".join(selected))
    print("Output: %s" % os.path.abspath(args.out))
    print("=" * 72)

    experiments = {}
    for name in selected:
        experiments[name] = _run_experiment(
            name, args.cases, levels_by_exp[name], workers, args.seed,
            args.out, args.lethal_radius)

    stats = {name: {key: _aggregate(res, args.lethal_radius)
                    for key, res in blocks.items()}
             for name, blocks in experiments.items()}

    summary = {
        "meta": {
            "cases_per_law_per_level": args.cases,
            "cases_actual": {k: _sample_counts(blocks)
                             for k, blocks in experiments.items()},
            "seed": args.seed,
            "levels": {k: v for k, v in levels_by_exp.items()
                       if k in experiments},
            "sweep": {k: EXP_SPEC[k]["sweep"] for k in experiments},
            "lethal_radius_m": args.lethal_radius,
            "laws": {k: _ordered_laws(blocks)
                     for k, blocks in experiments.items()},
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
        "stats": {"%s|%s|%g" % (exp, law, lv): s
                  for exp, d in stats.items()
                  for (law, lv), s in d.items()},
        "paired": {},
    }
    for name, blocks in experiments.items():
        laws = _ordered_laws(blocks)
        for level in levels_by_exp[name]:
            if len(laws) >= 2:
                summary["paired"]["%s|%g" % (name, level)] = _paired_test(
                    blocks[(laws[0], level)], blocks[(laws[1], level)])

    with open(os.path.join(args.out, "summary.json"), "w",
              encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    _save_all_runs(experiments, args.out)
    figures = _plot(experiments, levels_by_exp, args.lethal_radius, args.out)
    report = _write_report(experiments, levels_by_exp, stats, args.out, args,
                           args.lethal_radius, figures)

    print("=" * 72)
    print("Report: %s" % report)
    for name in selected:
        print("\n[%s]" % name)
        for level in levels_by_exp[name]:
            for (law, lv), s in stats[name].items():
                if lv != level:
                    continue
                print("  lvl=%-4g %-22s hit=%5.1f%%  median=%8.1f m  CEP90=%8.1f m"
                      % (level, law, 100.0 * s["hit_rate"],
                         s["miss_median"], s["miss_p90"]))
    return summary


if __name__ == "__main__":
    main()
