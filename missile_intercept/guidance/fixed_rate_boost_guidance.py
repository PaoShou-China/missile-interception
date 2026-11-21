"""Classical fixed-programme boost guidance (comparison baseline).

The pitch programme is a constant-rate gravity turn: ``gamma_ref`` decreases
by ``BOOST_FIXED_PITCH_RATE`` every second until the midcourse handover angle,
regardless of dynamic pressure, available normal force or thrust-vector
contribution.  The lateral command is not re-budgeted either.

This is the textbook open-loop pitch programme.  Everything else - vertical
cold-launch rise, gamma/heading feedback, thrust-aware aero derating, command
frame and the low-altitude pull-up - is inherited from ``BoostGuidance``, so
the comparison isolates *feasibility-aware programme shaping*.

Ref: fixed pitch-rate gravity-turn ascent programme.
"""

import config as C
from guidance.boost_guidance import BoostGuidance


class FixedRateBoostGuidance(BoostGuidance):
    name = "boost_fixed_rate"

    def __init__(self, pitch_rate=C.BOOST_FIXED_PITCH_RATE, **kwargs):
        super().__init__(**kwargs)
        self.fixed_rate = float(pitch_rate)

    def _rate_max(self, a_feasible, V):
        """Constant programme rate: no q/load feasibility knowledge."""
        return self.fixed_rate

    @staticmethod
    def _budget(a_perp, a_head, a_feasible):
        """No lateral re-budgeting in the classical programme."""
        return a_perp, a_head
