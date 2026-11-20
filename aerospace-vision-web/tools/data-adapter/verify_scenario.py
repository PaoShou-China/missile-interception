"""Independent post-build verification of scenario.json (no simulator import).

Checks:
  1. schema version and frame declarations
  2. monotonic time and finite numeric fields
  3. unit quaternions
  4. WGS84 LLH -> ECEF agreement with stored positions
  5. adapter validation status is PASS
  6. intercept metric agrees with the sample set

Run:
    python tools/data-adapter/verify_scenario.py
Exit code 0 = PASS, 1 = failed checks.
"""

from __future__ import annotations

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(os.path.dirname(HERE))
DEFAULT = os.path.join(PROJECT, "public", "data", "missile-intercept", "scenario.json")

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)


def llh_to_ecef(lat_deg, lon_deg, alt_m):
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    s = math.sin(lat)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * s * s)
    return (
        (n + alt_m) * math.cos(lat) * math.cos(lon),
        (n + alt_m) * math.cos(lat) * math.sin(lon),
        (n * (1 - WGS84_E2) + alt_m) * s,
    )


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    checks = []

    def check(cid, ok, detail):
        checks.append((cid, bool(ok), detail))

    check("schema", data.get("schemaVersion") == "1.0.0", str(data.get("schemaVersion")))
    check("frame", data.get("frames", {}).get("render") == "ECEF",
          str(data.get("frames", {}).get("render")))
    check("adapter-pass", data.get("validation", {}).get("status") == "PASS",
          str(data.get("validation", {}).get("status")))

    missile = next(e for e in data["entities"] if e["kind"] == "missile")["samples"]
    target = next(e for e in data["entities"] if e["kind"] == "target")["samples"]

    times = [s["t"] for s in missile]
    check("monotonic", all(b > a for a, b in zip(times, times[1:])),
          "n=%d, t=[%.3f, %.3f]" % (len(times), times[0], times[-1]))

    finite = True
    qmax = 0.0
    geodetic_max = 0.0
    for s in missile + target:
        vals = [*s["position"].values(), *s["velocity"].values(),
                s["altM"], s["speedMS"], s["mach"], s["qPa"]]
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in vals):
            finite = False
        q = s["attitude"]
        qmax = max(qmax, abs(math.sqrt(q["w"] ** 2 + q["x"] ** 2 + q["y"] ** 2 + q["z"] ** 2) - 1))
        p = llh_to_ecef(s["latDeg"], s["lonDeg"], s["altM"])
        geodetic_max = max(geodetic_max, math.dist(
            p, (s["position"]["x"], s["position"]["y"], s["position"]["z"])))

    check("finite", finite, "all position/velocity/observable values finite")
    check("unit-quaternions", qmax < 1e-5, "max |‖q‖-1| = %.2e" % qmax)
    check("geodetic-ecef", geodetic_max < 1.0, "max mismatch = %.3f m" % geodetic_max)

    min_range = min(s["rangeM"] for s in missile)
    min_t = min(missile, key=lambda s: s["rangeM"])["t"]
    check("intercept-metric",
          abs(min_range - data["metrics"]["missDistanceM"]) < 0.5
          and abs(min_t - data["metrics"]["interceptTimeS"]) < 0.05,
          "miss=%.3f m @ %.2f s" % (min_range, min_t))

    ok = all(c[1] for c in checks)
    print("scenario:", path)
    for cid, passed, detail in checks:
        print("  [%s] %-18s %s" % ("PASS" if passed else "FAIL", cid, detail))
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
