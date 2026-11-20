"""Probe isolated generic data containers using dimensionless synthetic records.

Only the StateField/StateSchema and TelemetryLogger/SimLoggerDefaults class
definitions are selected by AST. No simulation module, model, configuration,
accelerated kernel, trajectory, or decision algorithm is imported or executed.
"""
from __future__ import annotations

import argparse
import ast
import csv
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
from types import MappingProxyType, SimpleNamespace

import numpy as np

PAPER = Path(__file__).resolve().parents[1]


def extract_classes(path, names, namespace):
    content = path.read_bytes()
    tree = ast.parse(content.decode("utf-8-sig"))
    selected = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in names]
    if {node.name for node in selected} != set(names):
        raise ValueError("Missing generic class definition")
    code = ast.Module(body=selected, type_ignores=[])
    ast.fix_missing_locations(code)
    # dont_inherit prevents this harness's future annotations changing the source.
    exec(compile(code, str(path.name), "exec", dont_inherit=True), namespace)
    lines = content.decode("utf-8-sig").splitlines(keepends=True)
    return {"source": path.name, "source_sha256": hashlib.sha256(content).hexdigest(),
            "selection": [{"name": node.name, "line_start": min([node.lineno] + [d.lineno for d in node.decorator_list]),
                           "line_end": node.end_lineno,
                           "class_text_sha256": hashlib.sha256("".join(lines[min([node.lineno] + [d.lineno for d in node.decorator_list])-1:node.end_lineno]).encode()).hexdigest()}
                          for node in selected]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=PAPER.parent)
    args = parser.parse_args()
    root = args.source_root.resolve(strict=True)
    namespace = {"__name__": "paper_generic_contracts", "np": np, "dataclass": dataclass,
                 "MappingProxyType": MappingProxyType, "hashlib": hashlib, "json": json,
                 "csv": csv, "os": os,
                 "C": SimpleNamespace(TELEMETRY_COLUMNS=["time", "signal", "aux"]),
                 "FC": SimpleNamespace(NUMBA_AVAILABLE=False)}
    selection = [
        extract_classes(root / "missile_intercept/state_schema.py", {"StateField", "StateSchema"}, namespace),
        extract_classes(root / "missile_intercept/telemetry.py", {"TelemetryLogger", "SimLoggerDefaults"}, namespace),
    ]
    Field, Schema, Logger = (namespace[name] for name in ("StateField", "StateSchema", "TelemetryLogger"))
    fields = [Field("vector", (3,), "1", "synthetic", "demo"), Field("label", (), "1", "-", "demo")]
    schema = Schema(fields)
    values = {"vector": np.array([1., 2., 3.]), "label": 7.}
    rows = []

    def observe(name, area, function, desired=True, detail=""):
        observed = bool(function())
        rows.append({"name": name, "area": area, "property_observed": observed,
                     "desired_property": desired, "requirement_met": observed == desired, "detail": detail})

    def raises(function, kind):
        try:
            function()
        except kind:
            return True
        return False

    observe("pack_unpack_roundtrip", "schema", lambda: np.array_equal(schema.unpack(schema.pack(values))["vector"], values["vector"]))
    observe("missing_key_rejected", "schema", lambda: raises(lambda: schema.pack({"vector": values["vector"]}), ValueError))
    observe("extra_key_rejected", "schema", lambda: raises(lambda: schema.pack(dict(values, extra=0)), ValueError))
    observe("array_shape_rejected", "schema", lambda: raises(lambda: schema.pack(dict(values, vector=np.zeros((1, 3)))), ValueError))
    observe("nonscalar_label_rejected", "schema", lambda: raises(lambda: schema.pack(dict(values, label=[1, 2])), ValueError))
    observe("nonfinite_pack_rejected", "schema", lambda: raises(lambda: schema.pack(dict(values, vector=[1, np.nan, 3])), ValueError))
    observe("duplicate_field_key_rejected", "schema", lambda: raises(lambda: Schema([fields[0], fields[0]]), ValueError))
    observe("wrong_packed_length_rejected", "schema", lambda: raises(lambda: schema.unpack(np.zeros(5)), ValueError))

    packed = schema.pack(values)
    copied = schema.unpack(packed)
    copied["vector"][0] = 99
    observe("unpack_returns_array_copy", "schema", lambda: packed[0] == 1)
    alternate = Schema([Field("vector", (3,), "changed-unit", "synthetic", "demo"), fields[1]])
    observe("metadata_change_changes_layout_hash", "schema", lambda: alternate.layout_hash != schema.layout_hash)
    bad_packed = packed.copy()
    bad_packed[0] = np.nan
    observe("nonfinite_unpack_rejected", "schema", lambda: raises(lambda: schema.unpack(bad_packed), ValueError),
            detail="Diagnostic requirement: unpack checks shape but does not reject nonfinite values.")

    def logger(capacity=2):
        return Logger(max_steps=capacity, columns=["time", "signal", "aux"])

    log = logger()
    observe("valid_row_accepted", "telemetry", lambda: log.send(0., [1., 2.]) and log.n == 1)
    observe("wrong_row_width_rejected", "telemetry", lambda: raises(lambda: logger().send(0., [1.]), ValueError))
    observe("nonfinite_values_rejected", "telemetry", lambda: raises(lambda: logger().send(0., [np.nan, 2.]), FloatingPointError))
    observe("zero_capacity_rejected", "telemetry", lambda: raises(lambda: logger(0), ValueError))
    observe("equal_timestamp_dropped", "telemetry", lambda: log.send(0., [3., 4.]) is False and log.n == 1)
    observe("earlier_timestamp_dropped", "telemetry", lambda: log.send(-1., [3., 4.]) is False and log.n == 1)
    log.send(1., [3., 4.])
    observe("capacity_overflow_dropped_and_counted", "telemetry", lambda: log.send(2., [5., 6.]) is False and log.n == 2 and log.overflow_count == 1 and log.data.shape == (2, 3))
    copied_columns = log.as_dict()
    copied_columns["signal"][0] = 99.
    observe("as_dict_returns_copies", "telemetry", lambda: log.data[0, 1] == 1.)
    column_view = log.get("signal")
    column_view[0] = 9.
    observe("get_returns_column_view", "telemetry", lambda: log.data[0, 1] == 9., detail="Observed ownership semantics; get is not an immutable snapshot.")
    observe("unknown_column_rejected", "telemetry", lambda: raises(lambda: log.get("missing"), KeyError))
    scratch = (PAPER / "build/software-probes").resolve()
    scratch.relative_to(PAPER)
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="paper-record-", dir=str(scratch)) as tmp:
        sample = logger()
        sample.send(0., [0.123456789, 2.])
        path = sample.save_csv(str(Path(tmp) / "record.csv"))
        with open(path, newline="") as stream:
            exported = list(csv.reader(stream))
        observe("csv_uses_six_decimal_places", "telemetry", lambda: exported[1][1] == "0.123457")
    nan_time = logger()
    observe("nonfinite_timestamp_rejected", "telemetry", lambda: raises(lambda: nan_time.send(np.nan, [1., 2.]), (ValueError, FloatingPointError)) or nan_time.n == 0,
            detail="Diagnostic requirement: the tested Python path accepts a NaN timestamp; no repair is applied.")

    allocation = []
    for capacity in (256, 1024, 4096, 16384):
        for channels in (8, 32, 128):
            obj = Logger(max_steps=capacity, columns=["time"] + ["c%d" % i for i in range(channels - 1)])
            allocation.append({"capacity": capacity, "channels_including_time": channels,
                               "dtype": str(obj.data.dtype), "payload_bytes": obj.data.nbytes,
                               "predicted_payload_bytes": capacity * channels * np.dtype(float).itemsize})
    result = {
        "schema": "paper-generic-contract-probes/v1", "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
        "scope": "Isolated generic class definitions, dimensionless synthetic fields, Python telemetry path only. No simulation execution.",
        "environment": {"python": platform.python_version(), "numpy": np.__version__, "system": platform.system(), "machine": platform.machine()},
        "class_extraction": selection, "probes": rows, "probe_count": len(rows),
        "requirements_met": sum(row["requirement_met"] for row in rows),
        "limitations_observed": [row["name"] for row in rows if not row["requirement_met"]],
        "allocation_experiment": allocation,
        "allocation_predictions_match": all(row["payload_bytes"] == row["predicted_payload_bytes"] for row in allocation),
        "allocation_metric": "NumPy data-array payload only; excludes Python objects, process RSS, output copies, and allocator overhead.",
    }
    output = PAPER / "evidence/software_probes.json"
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    macros = {"SoftwareProbeCount": len(rows), "SoftwareRequirementsMet": result["requirements_met"],
              "SoftwareLimitations": len(result["limitations_observed"]), "AllocationCases": len(allocation),
              "SoftwarePython": result["environment"]["python"], "SoftwareNumpy": result["environment"]["numpy"]}
    (PAPER / "software_numbers.tex").write_text("% Generated by scripts/probe_data_contracts.py\n" + "".join("\\newcommand{\\%s}{%s\\xspace}\n" % (key, value) for key, value in macros.items()), encoding="ascii")
    print(json.dumps({key: result[key] for key in ("probe_count", "requirements_met", "limitations_observed", "allocation_predictions_match", "environment")}, indent=2))


if __name__ == "__main__":
    main()
