"""Classical fixed-gain three-loop PID autopilot (comparison baseline).

Differences from the reference autopilot (everything else is shared):

- gains are fixed at the nominal values; no dynamic-pressure/plant gain
  scheduling and no low-q integral taper;
- no direct load-factor (n_z) trimming loop.

The angle pre-filter, reference governor, transport-delay prediction,
alpha/beta envelopes, trim feed-forward, roll alignment, anti-windup and fin
position limits are identical.  Those are treated as common airframe
requirements: removing the dead-time prediction at the 40 ms command delay
destabilises the loop and would confound the comparison with a stability
failure instead of a control-architecture difference.

The class deliberately uses the pure-Python control path so the compiled
reference path (which embeds the gain schedule) is untouched.
"""

import config as C
from control.autopilot import Autopilot


class ClassicAutopilot(Autopilot):
    """Fixed-gain three-loop PID without gain scheduling or the n_z loop."""

    USE_NUMBA = False
    GAIN_SCHED = False
    REF_GOV = True
    PREDICT = True
    NZ_LOOP = False

    def __init__(self, dt=C.DT_AUTOPILOT, alpha_max=25.0 * C.DEG):
        super().__init__(dt=dt, alpha_max=alpha_max)
