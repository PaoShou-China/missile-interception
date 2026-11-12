"""Analysis backend unit tests: overrides and Sobol estimators."""

import numpy as np

import config as C
from analysis import apply_overrides, sobol_indices


def test_apply_overrides_config_and_scenario():
    cfg, scenario = apply_overrides(
        C.SimConfig(), C.Scenario(),
        {"config.midcourse_max_step": 0.02, "scenario.target_alt": 12000.0})
    assert cfg.midcourse_max_step == 0.02
    assert scenario.target_alt == 12000.0
    # The originals must be untouched (dataclass replace semantics).
    assert C.SimConfig().midcourse_max_step != 0.02


def test_sobol_indices_recover_analytic():
    """f = x0 only: S0 = ST0 = 1, second parameter carries no variance."""
    rng = np.random.RandomState(7)
    n = 20000
    a = rng.random_sample((n, 2))
    b = rng.random_sample((n, 2))
    f_a = a[:, 0]
    f_b = b[:, 0]
    ab0 = a.copy()
    ab0[:, 0] = b[:, 0]
    ab1 = a.copy()
    ab1[:, 1] = b[:, 1]
    f_ab = np.vstack([ab0[:, 0], ab1[:, 0]])
    s_first, s_total = sobol_indices(f_a, f_b, f_ab)
    assert abs(s_first[0] - 1.0) < 0.03
    assert abs(s_total[0] - 1.0) < 0.03
    assert abs(s_first[1]) < 0.01
    assert abs(s_total[1]) < 0.01
