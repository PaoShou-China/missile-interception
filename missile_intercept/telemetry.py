"""Telemetry logger: pre-allocated numpy buffer, no list.append.

Modules never plot or write files directly; they push one frame through
``TelemetryLogger.send``.  main.py saves the CSV and draws the dashboard
after the run.

Ref: pre-allocated linear buffer practice for real-time telemetry.
"""

import csv
import os
import numpy as np
import config as C
import fastcore as FC


class TelemetryLogger:
    """Fixed-capacity pre-allocated telemetry buffer (supports 0-alloc disabled mode)."""

    def __init__(self, max_steps=None, columns=None, enabled=True):
        self.columns = list(columns) if columns is not None else list(C.TELEMETRY_COLUMNS)
        self.n_cols = len(self.columns)
        self.enabled = bool(enabled)
        if not self.enabled:
            self.capacity = 0
            self.data = np.empty((0, self.n_cols), dtype=np.float64)
        else:
            self.capacity = int(max_steps) if max_steps is not None else int(SimLoggerDefaults.max_steps)
            if self.capacity <= 0:
                raise ValueError("max_steps must be positive")
            self.data = np.empty((self.capacity, self.n_cols), dtype=np.float64)
        self.n = 0
        self.overflow_count = 0
        self._last_time = -np.inf

    # --------------------------------------------------------
    def send(self, t, values):
        """Append one frame; ``values`` length must be ``n_cols - 1``."""
        if not self.enabled:
            return False
        vals = (values if (isinstance(values, np.ndarray)
                           and values.dtype == np.float64
                           and values.ndim == 1)
                else np.asarray(values, dtype=np.float64).reshape(-1))
        if vals.size != self.n_cols - 1:
            raise ValueError("Telemetry width mismatch: expected %d, got %d"
                             % (self.n_cols - 1, vals.size))

        if FC.NUMBA_AVAILABLE:
            n, last_time, status = FC.telemetry_write(
                self.data, self.n, float(t), vals, self._last_time)
            if status == -2:
                raise FloatingPointError("Telemetry contains NaN/Inf at t=%.6f" % t)
            if status == -1:
                self.overflow_count += 1
                return False
            if status == -3:
                return False
            self.n = int(n)
            self._last_time = float(last_time)
            return True

        if not np.all(np.isfinite(vals)):
            raise FloatingPointError("Telemetry contains NaN/Inf at t=%.6f" % t)
        if self.n >= self.capacity:
            # Capacity guard: drop and count, never grow (no memory leak).
            self.overflow_count += 1
            return False
        if t <= self._last_time + 1e-12:
            return False
        self.data[self.n, 0] = float(t)
        self.data[self.n, 1:] = vals
        self._last_time = float(t)
        self.n += 1
        return True

    # --------------------------------------------------------
    def get(self, name):
        """Return the written slice of a named column."""
        if name not in self.columns:
            raise KeyError("Unknown telemetry column: %s" % name)
        return self.data[: self.n, self.columns.index(name)]

    def as_dict(self):
        return {name: self.data[: self.n, i].copy() for i, name in enumerate(self.columns)}

    def save_npz(self, filepath, dtype=np.float64, compressed=True):
        """Write binary telemetry archive (.npz): 10-20x faster than CSV text."""
        directory = os.path.dirname(os.path.abspath(filepath))
        if directory and not os.path.isdir(directory):
            os.makedirs(directory)
        arr = np.asarray(self.data[: self.n], dtype=dtype)
        cols = np.array(self.columns, dtype="U64")
        saver = np.savez_compressed if compressed else np.savez
        saver(filepath, columns=cols, data=arr)
        return filepath

    @staticmethod
    def load_npz(filepath):
        """Read binary telemetry archive saved by ``save_npz`` -> (columns, data)."""
        with np.load(filepath, allow_pickle=False) as z:
            cols = [str(c) for c in z["columns"].tolist()]
            data = np.asarray(z["data"], dtype=np.float64)
        return cols, data

    def save_csv(self, filepath):
        """Write CSV without pandas (vectorised NumPy formatting)."""
        directory = os.path.dirname(os.path.abspath(filepath))
        if directory and not os.path.isdir(directory):
            os.makedirs(directory)
        with open(filepath, "w", newline="") as f:
            f.write(",".join(self.columns) + "\n")
            if self.n > 0:
                np.savetxt(f, self.data[: self.n], delimiter=",", fmt="%.6f")
        return filepath


class SimLoggerDefaults:
    """Default capacity (avoids a config import cycle)."""
    max_steps = 200000
