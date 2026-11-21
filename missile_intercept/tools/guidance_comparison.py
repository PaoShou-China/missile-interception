"""Guidance-law comparison experiments (two controlled Monte-Carlo studies).

Experiment A - terminal law
    Midcourse fixed at the reference Bezier law; terminal law is either the
    classical true-PN baseline (``pn``) or the reference ZEM/APN law
    (``zem_apn``).  Parameter sweep: target evasion load factor.

Experiment B - midcourse law
    Terminal fixed at the reference ZEM/APN law; midcourse law is either the
    classical q-hold + PN-to-PIP baseline (``pip_pn``) or the reference Bezier
    shaping law (``bezier``).  Parameter sweep: target evasion load factor.

Both experiments use the same case ids and seeds for every law, so the
comparison is paired (identical dispersions, sensors and target manoeuvre
phase).  Every case reports the full flight chain: boost exit state,
midcourse energy/altitude/Mach, handover geometry, terminal command effort
and final miss distance.

Usage (from ``missile_intercept/``):
    python tools/guidance_comparison.py --quick
    python tools/guidance_comparison.py --cases 30 --workers 24
    python tools/guidance_comparison.py --exp terminal --levels 0,4,8

Outputs (default ``<repo>/docs/experiments/guidance_comparison``):
    all_runs.csv                  every case, every law
    summary.json                  aggregated statistics
    fig_*.png                     report figures
    guidance-comparison-report.md report with methods, tables, conclusions
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
    "pn": "经典真比例导引 (PN)",
    "zem_apn": "ZEM/APN 参考律",
    "pip_pn": "预测拦截点直接中制导",
    "bezier": "Bezier 整形中制导",
}
# Baseline first, reference second: the paired difference is then reported as
# "baseline - reference", which is the natural sign for the conclusions.
LAW_ORDER = ["pn", "zem_apn", "pip_pn", "bezier"]


def _ordered_laws(blocks):
    return sorted({law for law, _ in blocks},
                  key=lambda law: LAW_ORDER.index(law)
                  if law in LAW_ORDER else len(LAW_ORDER))


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
        "midcourse_peak_mach": float(np.nanmean(
            [r.get("midcourse_peak_mach", np.nan) for r in ok])),
        "midcourse_peak_alt_km": float(np.nanmean(
            [r.get("midcourse_peak_alt_km", np.nan) for r in ok])),
        "handover_energy_mjkg": float(np.nanmean(
            [r.get("handover_specific_energy_mjkg", np.nan) for r in ok])),
        "terminal_peak_cmd_g": float(np.nanmean(
            [r.get("terminal_peak_cmd_g", np.nan) for r in ok])),
        "terminal_fin_sat_pct": float(np.nanmean(
            [r.get("terminal_fin_sat_pct", np.nan) for r in ok])),
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
def _run_block(cfg, level, cases, workers, base_seed, out_dir, lethal_radius):
    dispersion = Dispersion(
        launch_cep_m=500.0, target_cep_m=2000.0,
        target_alt_sigma_m=500.0, target_mach_sigma=0.05,
        evade_g_sigma=0.0, evade_g_nominal=float(level))
    raw = os.path.join(out_dir, "raw")
    os.makedirs(raw, exist_ok=True)
    tag = "%s_%s_g%g" % (cfg.midcourse_law, cfg.terminal_law, level)
    t0 = time.time()
    results = run_batch(
        cases, workers=workers, base_seed=base_seed, cfg=cfg,
        dispersion=dispersion, lethal_radius=lethal_radius,
        output_dir=os.path.join(raw, tag), plot=False,
        checkpoint=os.path.join(raw, tag, "cases.jsonl"), resume=True)
    print("  %-46s %5.1f s" % (tag, time.time() - t0))
    return results


def _run_experiment(name, laws, fixed, cases, levels, workers, base_seed,
                    out_dir, lethal_radius, verbose=True):
    """Run one experiment: every law x every sweep level, paired by case id.

    ``fixed`` pins the stage that is not under test, e.g.
    ``{"midcourse": "bezier"}`` for the terminal-law experiment.
    """
    blocks = {}
    for law in laws:
        for level in levels:
            cfg = C.SimConfig()
            if "midcourse" in fixed:
                cfg.midcourse_law = fixed["midcourse"]
                cfg.terminal_law = law
            else:
                cfg.midcourse_law = law
                cfg.terminal_law = fixed["terminal"]
            if verbose:
                print("[%s] law=%s level=%g g" % (name, law, level))
            blocks[(law, level)] = _run_block(
                cfg, level, cases, workers, base_seed, out_dir, lethal_radius)
    return blocks


# ============================================================
# Outputs
# ============================================================
def _save_all_runs(experiments, out_dir):
    rows = []
    for name, blocks in experiments.items():
        for (law, level), results in blocks.items():
            for r in results:
                row = dict(r)
                row["experiment"] = name
                row["sweep_level_g"] = level
                rows.append(row)
    path = os.path.join(out_dir, "all_runs.csv")
    if not rows:
        return path
    fields = list(rows[0].keys())
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

    # Figure 1/2: miss-distance distribution and hit rate per sweep level.
    for name, blocks in experiments.items():
        levels = levels_by_exp[name]
        laws = _ordered_laws(blocks)
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
            rates = [np.mean(_finite(blocks[(law, lv)], "miss_distance")
                             <= lethal_radius)
                     if _finite(blocks[(law, lv)], "miss_distance").size else np.nan
                     for lv in levels]
            axes[1].plot(levels, rates, "o-", color=colors[k % len(colors)],
                         label=LAW_LABEL.get(law, law), lw=2)
        axes[0].set_yscale("log")
        axes[0].set_xlabel("Target evasion load factor (g)")
        axes[0].set_ylabel("Miss distance (m, log scale)")
        axes[0].set_title("%s: miss distribution" % name)
        axes[0].set_xticks(np.arange(len(levels)))
        axes[0].set_xticklabels(["%g" % lv for lv in levels])
        axes[0].grid(True, alpha=0.3)
        axes[1].set_xlabel("Target evasion load factor (g)")
        axes[1].set_ylabel("Hit rate (miss <= %.0f m)" % lethal_radius)
        axes[1].set_ylim(-0.03, 1.03)
        axes[1].set_title("%s: hit rate" % name)
        axes[1].grid(True, alpha=0.3)
        axes[1].legend(fontsize=8)
        fig.tight_layout()
        path = os.path.join(out_dir, "fig_%s.png" % name)
        fig.savefig(path, dpi=140)
        plt.close(fig)
        paths.append(path)

    # Figure 3: midcourse/handover stage metrics for the midcourse experiment.
    if "midcourse" in experiments:
        blocks = experiments["midcourse"]
        levels = levels_by_exp["midcourse"]
        laws = _ordered_laws(blocks)
        fig, axes = plt.subplots(1, 2, figsize=(11, 4.0))
        for k, law in enumerate(laws):
            hr = [np.nanmean([r.get("handover_range", np.nan) for r in
                              blocks[(law, lv)]]) / 1000.0 for lv in levels]
            en = [np.nanmean([r.get("handover_specific_energy_mjkg", np.nan)
                              for r in blocks[(law, lv)]]) for lv in levels]
            axes[0].plot(levels, hr, "o-", color=colors[k % len(colors)],
                         label=LAW_LABEL.get(law, law), lw=2)
            axes[1].plot(levels, en, "o-", color=colors[k % len(colors)],
                         label=LAW_LABEL.get(law, law), lw=2)
        axes[0].set_xlabel("Target evasion load factor (g)")
        axes[0].set_ylabel("Mean handover range (km)")
        axes[0].set_title("Handover range")
        axes[1].set_xlabel("Target evasion load factor (g)")
        axes[1].set_ylabel("Specific energy at handover (MJ/kg)")
        axes[1].set_title("Energy handed to the terminal loop")
        for ax in axes:
            ax.grid(True, alpha=0.3)
            ax.legend(fontsize=8)
        fig.tight_layout()
        path = os.path.join(out_dir, "fig_midcourse_stages.png")
        fig.savefig(path, dpi=140)
        plt.close(fig)
        paths.append(path)

    # Figure 4: pooled miss-distance CDF per experiment (all sweep levels).
    fig, axes = plt.subplots(1, len(experiments), figsize=(5.6 * len(experiments), 4.0),
                             squeeze=False)
    for ax, (name, blocks) in zip(axes[0], experiments.items()):
        laws = _ordered_laws(blocks)
        for k, law in enumerate(laws):
            pooled = np.concatenate([
                _finite(blocks[(law, lv)], "miss_distance")
                for lv in levels_by_exp[name]
                if (law, lv) in blocks and _finite(
                    blocks[(law, lv)], "miss_distance").size])
            if pooled.size == 0:
                continue
            x = np.sort(pooled)
            y = np.arange(1, x.size + 1) / float(x.size)
            ax.plot(x, y, lw=2, color=colors[k % len(colors)],
                    label=LAW_LABEL.get(law, law))
        ax.axvline(lethal_radius, color="k", ls="--", lw=1,
                   label="Hit threshold %.0f m" % lethal_radius)
        ax.set_xscale("log")
        ax.set_xlabel("Miss distance (m, log scale)")
        ax.set_ylabel("Cumulative probability")
        ax.set_title("%s: pooled miss CDF" % name)
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
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
    add("# 制导算法对比实验报告")
    add("")
    add("本报告由 `tools/guidance_comparison.py` 自动生成，全部数据来自 6DOF "
        "端到端仿真，未经手工修改。")
    add("")
    add("## 1. 实验设计")
    add("")
    add("两套实验均采用**配对蒙特卡洛**：同一 `case_id` 在两种算法下使用完全相同的"
        "发射点/目标点散布、高度/马赫散布、导航与导引头随机种子以及目标机动相位，"
        "因此同一 case 的差异只来自制导律本身。")
    add("")
    add("| 实验 | 固定环节 | 对比算法 | 扫描参数 | 每档样本 |")
    add("| --- | --- | --- | --- | --- |")
    add("| 末制导对比 | 中制导 = Bezier 整形 | 经典真比例导引 (PN) vs ZEM/APN | "
        "目标机动过载 %s g | %d |"
        % (", ".join("%g" % lv for lv in levels_by_exp["terminal"]), args.cases))
    add("| 中制导对比 | 末制导 = ZEM/APN | 预测拦截点直接中制导 vs Bezier 整形 | "
        "目标机动过载 %s g | %d |"
        % (", ".join("%g" % lv for lv in levels_by_exp["midcourse"]), args.cases))
    add("")
    add("公共设置：基础随机种子 %d，命中判据为脱靶量 ≤ %.1f m；发射点水平 CEP "
        "500 m、目标水平 CEP 2000 m、目标高度 σ 500 m、目标马赫 σ 0.05；"
        "所有算法共用同一套 6DOF 弹体、三回路自动驾驶仪、导航/导引头模型与交接逻辑。"
        % (args.seed, lethal_radius))
    add("")
    # The target manoeuvre is lift-limited, so high command levels saturate at
    # the wing's available load factor and become physically identical.  Flag
    # it instead of silently presenting duplicate rows as independent data.
    for exp_name, blocks in experiments.items():
        levels = levels_by_exp[exp_name]
        for law in _ordered_laws(blocks):
            dup = []
            for i, lv_a in enumerate(levels):
                for lv_b in levels[i + 1:]:
                    a = _finite(blocks[(law, lv_a)], "miss_distance")
                    b = _finite(blocks[(law, lv_b)], "miss_distance")
                    if (a.size and a.size == b.size
                            and np.allclose(np.sort(a), np.sort(b))):
                        dup.append((lv_a, lv_b))
            if dup:
                add("> 注意：%s 的 " % LAW_LABEL.get(law, law)
                    + "、".join("%g g 与 %g g" % d for d in dup)
                    + " 结果完全一致，原因是目标在 15 km / 跨声速段的可用升力"
                      "只有约 3–4 g，更高的指令过载被升力限幅截断，属于模型"
                      "物理约束而非数值退化。")
                add("")

    for exp_name in ("terminal", "midcourse"):
        if exp_name not in experiments:
            continue
        blocks = experiments[exp_name]
        levels = levels_by_exp[exp_name]
        laws = _ordered_laws(blocks)
        title = "末制导" if exp_name == "terminal" else "中制导"
        add("## %s. %s对比结果" % ("2" if exp_name == "terminal" else "3", title))
        add("")
        add("### 统计汇总")
        add("")
        header = ("| 机动 (g) | 算法 | 有效样本 | 命中率 | 中位脱靶 (m) | "
                  "P90 脱靶 (m) | 最大脱靶 (m) | 交接率 | 交接距离 (km) |")
        add(header)
        add("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for level in levels:
            for law in laws:
                s = stats[exp_name][(law, level)]
                add("| %g | %s | %d | %.1f%% | %s | %s | %s | %s | %s |"
                    % (level, LAW_LABEL.get(law, law), s["n_valid"],
                       100.0 * s["hit_rate"], _fmt(s["miss_median"], 1),
                       _fmt(s["miss_p90"], 1), _fmt(s["miss_max"], 0),
                       _fmt(100.0 * s["handover_rate"], 0),
                       _fmt(s["handover_range_km"], 1)))
        add("")
        add("### 全阶段指标（各机动档平均）")
        add("")
        add("| 机动 (g) | 算法 | 中制导峰值马赫 | 中制导峰值高度 (km) | "
            "交接比能量 (MJ/kg) | 末制导峰值指令 (g) | 交接方位角 (°) |")
        add("| --- | --- | --- | --- | --- | --- | --- |")
        for level in levels:
            for law in laws:
                s = stats[exp_name][(law, level)]
                add("| %g | %s | %s | %s | %s | %s | %s |"
                    % (level, LAW_LABEL.get(law, law),
                       _fmt(s["midcourse_peak_mach"], 2),
                       _fmt(s["midcourse_peak_alt_km"], 1),
                       _fmt(s["handover_energy_mjkg"], 2),
                       _fmt(s["terminal_peak_cmd_g"], 1),
                       _fmt(s["handover_lead_deg"], 2)))
        add("")
        add("### 配对显著性检验（Wilcoxon 符号秩 + Bootstrap 中位数差 95% CI）")
        add("")
        add("| 机动 (g) | 对比 | 配对数 | 中位差 (m) | 95% CI | p 值 | 结论 |")
        add("| --- | --- | --- | --- | --- | --- | --- |")
        law_a, law_b = laws[0], laws[1]
        for level in levels:
            p = _paired_test(blocks[(law_a, level)], blocks[(law_b, level)])
            verdict = ("差异显著" if np.isfinite(p["wilcoxon_p"])
                       and p["wilcoxon_p"] < 0.05 else "未见显著差异")
            add("| %g | %s - %s | %d | %s | [%s, %s] | %s | %s |"
                % (level, LAW_LABEL.get(law_a, law_a), LAW_LABEL.get(law_b, law_b),
                   p["n_pairs"], _fmt(p["median_diff"], 1),
                   _fmt(p["ci_low"], 1), _fmt(p["ci_high"], 1),
                   _fmt(p["wilcoxon_p"], 3), verdict))
        add("")

    add("## 4. 结论")
    add("")
    add(_conclusions(experiments, levels_by_exp, stats, lethal_radius))
    add("")
    add("## 5. 方法与可复现性")
    add("")
    add("- 仿真：6DOF 刚体 + 四元数姿态，RK4 变步长积分，制导 5 ms / 控制 5 ms / "
        "导引头与导航按各自周期零阶保持。")
    add("- 对比公平性：两种算法共享同一时间对齐、导引头几何、重力补偿、FOV 保护、"
        "指令平滑与过载限幅管线；中制导对比共享同一巡航动量压/俯仰阻尼参数。")
    add(("- 统计：命中率为脱靶量 ≤ %.1f m 的比例；配对检验对同一 case 的脱靶量做 "
         "Wilcoxon 符号秩检验，Bootstrap（2000 次）给出中位数差 95%% 置信区间。"
         % lethal_radius))
    add("- 复现命令：`python tools/guidance_comparison.py --cases %d --seed %d`"
        % (args.cases, args.seed))
    add("")
    add("## 6. 适用边界")
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


def _conclusions(experiments, levels_by_exp, stats, lethal_radius):
    """Generate data-driven conclusion bullets (no hard-coded outcome)."""
    out = []
    for exp, label in (("terminal", "末制导"), ("midcourse", "中制导")):
        if exp not in experiments:
            continue
        blocks = experiments[exp]
        levels = levels_by_exp[exp]
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
        ha = np.nanmean([stats[exp][(a, lv)]["hit_rate"] for lv in levels])
        hb = np.nanmean([stats[exp][(b, lv)]["hit_rate"] for lv in levels])
        ma = np.nanmean([stats[exp][(a, lv)]["miss_median"] for lv in levels])
        mb = np.nanmean([stats[exp][(b, lv)]["miss_median"] for lv in levels])
        ea = np.nanmean([stats[exp][(a, lv)]["handover_energy_mjkg"]
                         for lv in levels])
        eb = np.nanmean([stats[exp][(b, lv)]["handover_energy_mjkg"]
                         for lv in levels])
        diff_txt = ("配对中位差（%s − %s）范围 %s ~ %s m，正值为基线脱靶量更大；"
                    % (LAW_LABEL.get(a, a), LAW_LABEL.get(b, b),
                       _fmt(min(diffs), 1) if diffs else "—",
                       _fmt(max(diffs), 1) if diffs else "—"))
        out.append("- **%s**：%s 的平均命中率 %.1f%%，%s 为 %.1f%%；平均中位脱靶量 "
                   "%s m 与 %s m，交接比能量 %s / %s MJ/kg。%s在 %d/%d 个机动档上"
                   "配对差异达到 p < 0.05。"
                   % (label, LAW_LABEL.get(a, a), 100.0 * ha,
                      LAW_LABEL.get(b, b), 100.0 * hb, _fmt(ma, 1), _fmt(mb, 1),
                      _fmt(ea, 2), _fmt(eb, 2), diff_txt, sig, len(levels)))
    out.append("- 两套实验中的“差异显著”仅表示在该模型与样本量下统计可分辨，"
               "不构成对其他弹体/传感器配置的外推结论。")
    return "\n".join(out)


# ============================================================
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Guidance-law comparison: two paired Monte-Carlo experiments")
    parser.add_argument("--exp", default="both",
                        choices=["both", "terminal", "midcourse"])
    parser.add_argument("--cases", type=int, default=24,
                        help="cases per law per sweep level")
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--levels", default=None,
                        help="override sweep levels, e.g. 0,2,4,6,8")
    parser.add_argument("--lethal-radius", type=float,
                        default=C.WARHEAD_LETHAL_RADIUS)
    parser.add_argument("--out", default=os.path.join(
        REPO, "docs", "experiments", "guidance_comparison"))
    parser.add_argument("--quick", action="store_true",
                        help="small smoke campaign (4 cases, 2 levels)")
    args = parser.parse_args(argv)

    if args.quick:
        args.cases = 4
        args.levels = "0,6"

    levels = ([float(x) for x in args.levels.split(",")]
              if args.levels else None)
    levels_by_exp = {
        "terminal": levels or [0.0, 2.0, 4.0, 6.0, 8.0],
        "midcourse": levels or [0.0, 3.0, 6.0],
    }
    os.makedirs(args.out, exist_ok=True)
    workers = args.workers or max(1, min(24, os.cpu_count() or 1))

    print("=" * 72)
    print("Guidance comparison | cases=%d | workers=%d | seed=%d"
          % (args.cases, workers, args.seed))
    print("Output: %s" % os.path.abspath(args.out))
    print("=" * 72)

    experiments = {}
    if args.exp in ("both", "terminal"):
        experiments["terminal"] = _run_experiment(
            "terminal", ["pn", "zem_apn"], {"midcourse": "bezier"},
            args.cases, levels_by_exp["terminal"], workers, args.seed,
            args.out, args.lethal_radius)
    if args.exp in ("both", "midcourse"):
        experiments["midcourse"] = _run_experiment(
            "midcourse", ["pip_pn", "bezier"], {"terminal": "zem_apn"},
            args.cases, levels_by_exp["midcourse"], workers, args.seed,
            args.out, args.lethal_radius)

    stats = {name: {key: _aggregate(res, args.lethal_radius)
                    for key, res in blocks.items()}
             for name, blocks in experiments.items()}

    summary = {
        "meta": {
            "cases_per_law_per_level": args.cases,
            "seed": args.seed,
            "levels_g": {k: v for k, v in levels_by_exp.items()
                         if k in experiments},
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
    for name in experiments:
        print("\n[%s]" % name)
        for level in levels_by_exp[name]:
            for (law, lv), s in stats[name].items():
                if lv != level:
                    continue
                print("  g=%-3g %-24s hit=%5.1f%%  median=%8.1f m  CEP90=%8.1f m"
                      % (level, law, 100.0 * s["hit_rate"],
                         s["miss_median"], s["miss_p90"]))
    return summary


if __name__ == "__main__":
    main()
