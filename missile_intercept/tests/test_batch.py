"""Batch parallel test-firing: multiprocess execution and statistics correctness."""

import numpy as np
import pytest

import config as C
import batch


def test_batch_parallel_small(tmp_path):
    """Two cases executed in parallel: complete results, no exceptions, CSV written to disk."""
    cfg = C.SimConfig(max_step=0.01, t_end=2.0, enable_plot=False, verbose=False)
    disp = batch.Dispersion(launch_cep_m=0.0, target_cep_m=0.0,
                            target_alt_sigma_m=0.0, target_mach_sigma=0.0,
                            evade_g_sigma=0.0)
    out = tmp_path / "batch"
    results = batch.run_batch(2, workers=2, cfg=cfg, dispersion=disp,
                              output_dir=str(out), plot=False)

    assert len(results) == 2
    assert [r["case_id"] for r in results] == [0, 1]
    assert all(r["error"] == "" for r in results)
    assert all(np.isfinite(r["miss_distance"]) for r in results)
    assert (out / "batch_results.csv").exists()


def test_run_case_includes_handover_diagnostics():
    """Batch results must carry the handover/terminal diagnostic fields."""
    cfg = C.SimConfig(t_end=3.0, max_steps=3000, enable_plot=False,
                      verbose=False, telemetry_profile="basic")
    r = batch.run_case((0, cfg, C.Scenario()))
    for key in ("first_lock_time", "first_lock_range",
                "handover_time", "handover_range", "handover_fov_deg",
                "handover_fov_margin_deg", "handover_tgo",
                "handover_lead_deg", "handover_n_avail_g",
                "handover_n_req_g", "handover_gates",
                "terminal_peak_cmd_g", "terminal_peak_act_g",
                "terminal_fov_max_deg", "terminal_lock_loss_pct",
                "terminal_min_range_km"):
        assert key in r, key
    assert r["error"] == ""


def test_summarize_hit_rate_and_cep():
    """Statistics: hit count and CEP50 computed correctly."""
    res = [{"error": "", "miss_distance": m} for m in (1.0, 2.0, 3.0, 4.0)]
    stats = batch.summarize(res, lethal_radius=2.0)
    assert stats["hits"] == 2
    assert stats["hit_rate"] == pytest.approx(0.5)
    assert stats["cep50"] == pytest.approx(2.5)


def test_dispersion_sampling_is_reproducible():
    """The same seed produces exactly the same case parameters."""
    cfg = C.SimConfig()
    disp = batch.Dispersion()
    a = batch.build_case(3, 42, cfg, disp)
    b = batch.build_case(3, 42, cfg, disp)
    assert a[2] == b[2]
    assert a[2].seeker_seed == b[2].seeker_seed
