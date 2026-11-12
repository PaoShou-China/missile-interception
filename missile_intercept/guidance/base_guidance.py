"""Guidance base class and shared geometry helpers (full 3D vectors).

Ref: JAST midcourse Bezier shaping; ZEM/APN terminal guidance.
"""

import abc
import numpy as np
import config as C
import math_utils as MU


class BaseGuidance(abc.ABC):
    """Common interface for all guidance laws."""

    name = "base"

    def reset(self):
        """Reset internal state (new missile / repeat run)."""
        return None

    @abc.abstractmethod
    def compute(self, t, nav, target_state, q=None, seeker=None):
        """Return a GuidanceCommand.

        Parameters
        ----------
        nav : NavEstimate
        target_state : (6,) target state [r, v] in ECI
        q : (4,) missile attitude quaternion (for FOV constraints)
        seeker : SeekerMeasurement or None
        """
        raise NotImplementedError

    # --------------------------------------------------------
    @staticmethod
    def target_velocity(target_state):
        return np.asarray(target_state, dtype=float).reshape(6)[3:6]

    @staticmethod
    def target_position(target_state):
        return np.asarray(target_state, dtype=float).reshape(6)[0:3]

    @staticmethod
    def handover_point(nav, target_state, alt_offset=C.HANDOVER_DH_MIN):
        """Handover point above the predicted intercept for energy advantage."""
        r_p, t_go = MU.predict_intercept(
            nav.r_eci, nav.v_eci,
            BaseGuidance.target_position(target_state),
            BaseGuidance.target_velocity(target_state))
        up = MU.local_up(r_p)
        return r_p + up * alt_offset, t_go
