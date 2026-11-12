"""Packed-state schema: field names, units, frames, slices and layout hash.

Mirrors uniflight's ``StateSchema`` / ``StateField`` contract.  The packed
layout is unchanged from the compiled core:

    missile: position(3) velocity(3) attitude(4) angular_rate(3) mass(1)
    target:  position(3) velocity(3)

``SYSTEM_SCHEMA.sl(key)`` returns the slice for a named field, so callers no
longer hard-code ``y[14:17]``-style offsets.  ``layout_hash`` changes if any
field name/shape/unit/frame/owner changes, which makes accidental layout edits
visible in logs and tests.
"""

import hashlib
import json
from dataclasses import dataclass
from types import MappingProxyType

import numpy as np


@dataclass(frozen=True)
class StateField:
    key: str
    shape: tuple
    unit: str
    frame: str
    owner: str

    @property
    def size(self):
        return int(np.prod(self.shape, dtype=int)) if self.shape else 1


class StateSchema(object):
    def __init__(self, fields):
        self.fields = tuple(fields)
        keys = [f.key for f in self.fields]
        if len(keys) != len(set(keys)):
            raise ValueError("state field keys must be unique")
        slices = {}
        offset = 0
        for f in self.fields:
            slices[f.key] = slice(offset, offset + f.size)
            offset += f.size
        self.sl = MappingProxyType(slices)
        self.total_size = offset
        serial = [{"key": f.key, "shape": f.shape, "unit": f.unit,
                   "frame": f.frame, "owner": f.owner} for f in self.fields]
        self.layout_hash = hashlib.sha256(
            json.dumps(serial, sort_keys=True).encode()).hexdigest()

    def pack(self, values):
        """Pack a mapping into the contiguous float state vector."""
        expected = {f.key for f in self.fields}
        missing = expected - values.keys()
        extra = values.keys() - expected
        if missing or extra:
            raise ValueError("state keys mismatch; missing=%s extra=%s"
                             % (sorted(missing), sorted(extra)))
        y = np.empty(self.total_size, dtype=float)
        for f in self.fields:
            a = np.asarray(values[f.key], dtype=float)
            if f.shape:
                if a.shape != f.shape:
                    raise ValueError("%s expected shape %s, got %s"
                                     % (f.key, f.shape, a.shape))
                y[self.sl[f.key]] = a.reshape(-1)
            else:
                if a.size != 1:
                    raise ValueError("%s must be scalar" % f.key)
                y[self.sl[f.key]] = float(a.reshape(-1)[0])
        if not np.all(np.isfinite(y)):
            raise ValueError("state contains non-finite values")
        return y

    def unpack(self, packed):
        y = np.asarray(packed, dtype=float)
        if y.shape != (self.total_size,):
            raise ValueError("expected packed shape (%d,), got %s"
                             % (self.total_size, y.shape))
        out = {}
        for f in self.fields:
            a = y[self.sl[f.key]]
            out[f.key] = float(a[0]) if not f.shape else a.reshape(f.shape).copy()
        return out


MISSILE_SCHEMA = StateSchema([
    StateField("m_position", (3,), "m", "ECI", "missile-kinematics"),
    StateField("m_velocity", (3,), "m/s", "ECI", "missile-dynamics"),
    StateField("m_attitude", (4,), "1", "ECI<-BODY", "attitude"),
    StateField("m_angular_rate", (3,), "rad/s", "BODY", "rotation"),
    StateField("m_mass", (), "kg", "-", "mass"),
])

TARGET_SCHEMA = StateSchema([
    StateField("t_position", (3,), "m", "ECI", "target-kinematics"),
    StateField("t_velocity", (3,), "m/s", "ECI", "target-dynamics"),
])

SYSTEM_SCHEMA = StateSchema(MISSILE_SCHEMA.fields + TARGET_SCHEMA.fields)

# Convenience slice constants for hot paths (same objects as SYSTEM_SCHEMA.sl).
SL_M_POS = SYSTEM_SCHEMA.sl["m_position"]
SL_M_VEL = SYSTEM_SCHEMA.sl["m_velocity"]
SL_M_ATT = SYSTEM_SCHEMA.sl["m_attitude"]
SL_M_OMEGA = SYSTEM_SCHEMA.sl["m_angular_rate"]
SL_M_MASS = SYSTEM_SCHEMA.sl["m_mass"]
SL_T_POS = SYSTEM_SCHEMA.sl["t_position"]
SL_T_VEL = SYSTEM_SCHEMA.sl["t_velocity"]
