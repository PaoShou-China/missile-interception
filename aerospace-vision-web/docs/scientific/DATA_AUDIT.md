# Data Audit — Legacy Reports vs. Current Workspace

Status: audited on 2026-11-20. Scope: the three legacy static reports that
are still published under `/legacy/`, plus the telemetry that the current
`scenario.json` payload is built from.

This document records **what can and cannot be reproduced**. It does not
silently pick a "preferred" number: where two legacy artifacts disagree, both
are listed with the file and line that carries them.

## 1. Artifacts under audit

| Artifact | Path | Role |
| --- | --- | --- |
| Overview report | `missile-intercept-overview/missile-intercept-overview.html` | Bilingual program overview, Monte-Carlo summary |
| Intercept report | `intercept-report/intercept-report.html` | Older single-shot narrative report |
| Technical report | `TECHNICAL_REPORT.md` | Written methodology and validation matrix |
| Current telemetry | `missile_intercept/output/telemetry.csv` | 99.2 MB, 67 164 rows, mtime 2026-11-20 20:55 |
| Current batch | `missile_intercept/output/batch/batch_results.csv` | 2 858 B, mtime 2026-11-20 20:55 |

The batch result file was overwritten by a short (2-row) verification run at
the same minute the telemetry was regenerated. The 100-case campaign artifacts
that the overview report cites are **not present** in the workspace now.

## 2. Internal contradiction: 86 % vs 79 %

The overview report contains both values in the same section:

- Stat strip and campaign table, lines 1442–1446:
  `Hits (≤15 m) = 86 (86.0 %)`, `95 % CI 77.9 – 91.5 %`,
  `Mean / std = 10.11 m / 5.81 m`.
- Narrative callout, line 1458, and the Technical Report line 16:
  `79 of 100 cases hit`, `95 % CI 70.0 – 85.8 %`, `mean 10.36 m`,
  `median 9.27 m`, `P90 18.74 m`, `max 34.90 m`.

Both confidence intervals are statistically consistent with their own hit
counts (Wilson intervals for 86/100 and 79/100 respectively), so this is not a
rounding slip: **two different campaign outcomes were merged into one page**.
Neither can be re-derived today because `batch_results.csv` no longer holds
100 cases.

Verdict: the Monte-Carlo hit rate is **unreproducible from the current
workspace**. Displaying either 79 % or 86 % as a verified result would be
misleading. The academic pages therefore report the campaign as *legacy,
unreproducible*, and link to this document.

## 3. Miss distance: 13.40 m vs 7.94 m

Both refer to the **same nominal single shot** (intercept at t = 676.47 s):

- `13.40 m` — closest approach sampled on the 10 ms telemetry grid
  (`output/telemetry.csv`, overview line 378 / 1384).
- `7.94 m` — closest approach returned by the integrator's event locator
  (overview line 1403). The locator refines the root of range(t), so it can
  resolve a minimum between two 10 ms samples.

These are not contradictory measurements; they are two different sampling
resolutions of the same trajectory. The difference (5.46 m) is a discretisation
effect and is a useful lower bound on single-shot uncertainty.

## 4. 61.1 m in the older intercept report

`intercept-report/intercept-report.html` reports a **61.1 m** terminal miss
(lines 306, 610, 660). It is an older run: its handover range (40 km) and its
narrative predate the 20 g load limit and the current terminal-guidance gains.
It is not the same trajectory as the 13.40 / 7.94 m case and cannot be
reconciled with it.

## 5. Current workspace telemetry (what the web payload uses)

The regenerated `telemetry.csv` yielded the following snapshot. Because the
source simulation was re-run in the same session, the file changed between
audits (67 164 rows → 67 276 rows) and the miss distance moved from 22.609 m to
26.726 m. The payload is therefore a **timestamped snapshot**, not a stable
reference; the adapter records its SHA-256, row count and generation time.

| Metric | Value |
| --- | --- |
| Miss distance | 26.726 m |
| Intercept time | 672.75 s |
| Max achieved load | 40.0 g (limit active) |
| Apogee | 29.897 km |
| Downrange | 1 655.37 km |
| Max Mach | 9.4806 |
| Max dynamic pressure | 872.7 kPa |

This is a **different, later run** than the one described by any of the legacy
reports. Differences are expected: the source repository working tree is dirty
(`git status` shows five modified modules) and the payload records
`source.commit = "workspace"`.

## 6. Consequences enforced in the product

1. Every published number is labelled with its artifact and timestamp.
2. The 3D scene replays the *current* payload only; it never mixes in legacy
   numbers.
3. Legacy hit-rate and miss-distance values appear only inside the audit and
   provenance pages, explicitly marked unreproducible.
4. `source.commit = "workspace"` is rendered in the UI provenance block, not
   hidden.
