"""Classical true proportional navigation (PN) terminal guidance.

Law
---
    omega = (r x v_rel) / R^2          # LOS angular-rate vector
    a     = N * Vc * (omega x u)       # true PN, perpendicular to the LOS

This is the textbook baseline: a constant navigation constant ``N`` and no
target-acceleration feed-forward.  Everything else - navigation time
alignment, seeker-direct geometry, gravity compensation, the soft FOV guard,
command smoothing and the load limit - is inherited unchanged from
``TerminalGuidance``, so a comparison against ZEM/APN isolates the guidance
law itself.

Ref: Murtaugh & Criel true PN; Zarchan, Tactical and Strategic Missile
Guidance (PN and augmented PN).
"""

import numpy as np
import config as C
import math_utils as MU
from guidance.terminal_guidance import TerminalGuidance


class PurePNGuidance(TerminalGuidance):
    """Constant-gain true PN with the shared terminal pipeline."""

    name = "terminal_pn"

    def __init__(self, n=C.TERMINAL_PN_N, n_max_g=C.MAX_LOAD_TERMINAL_G):
        super().__init__(n=n, n_max_g=n_max_g)

    # --------------------------------------------------------
    def _command_accel(self, geo, vc, t_go, a_T):
        """True PN: N * Vc * (omega x u), no APN feed-forward."""
        u = geo["u"]
        omega = geo["omega"]
        return self.n * vc * MU.cross3(omega, u)
