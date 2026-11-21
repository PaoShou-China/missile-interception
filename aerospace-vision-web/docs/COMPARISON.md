# Algorithm Comparison Studio

Status: implemented on 2026-11-21. This document defines the comparison policy,
the frozen data contract and the current validation status.

## 1. What is compared

The studio is **read-only**. It loads already-generated experiment records and
never re-simulates, retunes or rewrites them.

Current workspace audit:

| Artifact | State | Usable as |
| --- | --- | --- |
| `missile_intercept/output/telemetry.csv` | one 6-DoF shot, 67 276 rows, workspace snapshot | **Run A** (validated payload) |
| `output/batch/batch_results.csv` | 2-row verification remnant | not a campaign |
| `output/validation/validation_results.csv` | envelope sweep, different protocol | not a paired Run B |
| legacy HTML/MD reports | different versions and statistical units | provenance only |

**No independent Run B exists.** The page therefore shows Run A from the real
payload and a clearly marked “awaiting comparable experiment” state for Run B.
A synthetic demo can be loaded in the browser for UI testing; it is labelled
“not a scientific result” and is excluded from performance claims.

## 2. Comparison levels

| Level | Rule | Performance claim |
| --- | --- | --- |
| A · Strictly matched | same scenario id, datums, Earth model, start time, units; only method differs | allowed if both validated |
| B · Partially matched | no blocking difference, but recorded differences exist (e.g. commit) | allowed only within the matched scope |
| C · Not directly comparable | scenario/config/datum/time differences, missing validation, or synthetic data | forbidden |

The matcher (`src/compare/validation.ts`) reports every difference with field,
A value, B value and severity. Level C comparisons remain browsable but the UI
states that no algorithm superiority conclusion is produced.

## 3. Data contract

`schemas/comparison-manifest.schema.json` freezes:

- `ComparisonManifest`: protocol, runs, alignment mode, matching status, links.
- `AlgorithmRun`: ids, algorithm/version, commit, scenario, configuration hash,
  seed, trajectory file, data hash, time range, frame, units, validation,
  availability, synthetic flag, notes.
- `ComparisonMetric`: definition, source, aggregation, A/B values, eligibility.
- `ComparisonState`: run ids, comparison time, sync mode, camera, visual mode.

`public/data/compare/comparison.json` is generated from the current payload by
`tools/compare/build_comparison.py`; it records Run A and a pending Run B.

## 4. Time model

Three clocks are kept distinct:

1. **Simulation time** — each run's own recorded time.
2. **Comparison time** — the shared clock used by both views.
3. **Presentation time** — not used here; the explorer owns its own film clock.

Default mode is absolute simulation time. The comparison interval is the
intersection of both runs, so no run is extrapolated; a run outside its range is
hidden and labelled `ENDED`, never frozen as if still running.

`Event-Aligned` is optional. It offsets B so a matching event label coincides
with A and displays a warning that absolute times are not equal. Independent
playback lets each run hold its own time; point-wise difference curves are then
disabled.

## 5. Modes

- **Side-by-side**: two canvases, identical camera rule, shared time.
- **Overlay**: both full trajectories in one ECEF frame; fixed colours
  (A `#2f7fd0`, B `#37b9d8`).
- **Before/After**: two identical cameras stacked; the B layer is clipped by a
  draggable divider.
- **Statistics**: A/B curves, Δ(t) (only for matching units/definitions), metric
  table and experiment-condition diff.

Cameras: global, flight, attitude (body axes), control surfaces. Both panes use
Run A's pose as the reference so projection and framing are identical.

## 6. Importing Run B

Accepted file: a scenario payload with schema 1.1.0 (`scenario.json`). On import
the reader validates the schema, derives run metadata, and runs the matcher.
Importing a payload whose scenario/datums/time differ produces Level C and a
visible warning. Only trajectories are used; no algorithm parameters are
exposed or modified.

## 7. Known gaps / NOT RUN

- No paired multi-run campaign is present, so distribution, confidence
  intervals and paired-difference statistics are **NOT RUN**.
- The synthetic demo exercises UI/difference maths only; it is not a scientific
  result and is not included in any aggregate.
- Import has been tested with synthetic payloads only; a real second experiment
  has not been supplied.
- Comparison rendering is verified in Chromium and WebKit; a long-duration
  dual-canvas soak is **NOT RUN**.
- Legacy hit rates and single-shot miss distances use different statistical
  units and are never presented as an algorithm comparison.

## 8. Tests

- Unit: manifest validation, A/B/C matching, commit warning, blocked initial
  conditions, synthetic exclusion, Δ(t) on common interval, event alignment.
- E2E: `/compare` load, real A metadata, pending B, four modes, synthetic demo,
  shared clock playback, language switch preserving selection.

See `docs/ACCEPTANCE.md` for the current run log.
