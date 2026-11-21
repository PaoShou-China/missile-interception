# Result Provenance

Every number shown by Aerospace Vision Web must be traceable to an artifact and
a transformation. This file defines the chain and the disclosure rules.

## 1. Chain of custody

```
missile_intercept/main.py
   └─ output/telemetry.csv            99.2 MB · 67 164 rows · SHA-256 recorded
        └─ tools/data-adapter/build_scenario.py   (only interpreter of raw data)
             └─ public/data/missile-intercept/scenario.json  (schema 1.1.0)
             └─ public/data/missile-intercept/validation.json
                  └─ src/scientific/scenario.ts              (runtime re-validation)
                       └─ 3D scene + charts + panels
```

The adapter is the single point where units, frames and quaternion conventions
are interpreted. Each conversion is asserted against the source schema before
any output is written; failures abort the build.

## 2. Recorded source identity

`scenario.json.source` and `validation.json.source` carry:

- `repository` — public source repository URL
- `commit` — `GIT_COMMIT` if set, otherwise `workspace`
- `telemetryFile`, `telemetryRows`, `sha256`, `generatedAt`, `generator`

The current payload was generated from a dirty working tree, so `commit` is
`workspace`. The interface shows this verbatim. A release build is expected to
set `GIT_COMMIT=$(git rev-parse HEAD)`.

## 3. Experiment manifest (schema 1.1.0)

The payload adds an `experiment` block that separates **what was measured**
from **what was assumed**:

| Field | Meaning |
| --- | --- |
| `kind` | `simulation` — never presented as flight test data |
| `name`, `purpose` | Human description of the case |
| `engine` | Solver and integrator description from the source project |
| `dtS` | Source sampling step (0.01 s) |
| `dispersion` | Launch/target datum and the nominal case definition |
| `reproducibility` | `reproducible` / `unreproducible-current-artifacts` |
| `notes` | Free-text caveats, including dirty-tree disclosure |

`reproducibility` is `unreproducible-current-artifacts` whenever the referenced
batch artifacts are absent or were overwritten by a shorter run.

## 4. Demonstration UTC

The source telemetry is **UTC-agnostic** (t = 0 at launch). Sun/moon geometry
therefore needs a declared demonstration epoch:

- `time.demoUtc` stores an ISO-8601 instant chosen for presentation only.
- The value is fixed (not "now"), so every viewer sees the same sky.
- The UI labels the sky as `DEMO UTC` and links to this section.
- Astronomy is computed from that epoch plus elapsed simulation seconds; it is
  never used to alter trajectory data.

## 5. Visual aids vs. data

The following are **symbols**, disclosed in the interface:

- Trajectory tube radius near orbital scale (centreline is exact telemetry).
- Vehicle model size (physical length is 6.5 m; the model is drawn at a
  separately scaled but internally consistent size).
- The target is a schematic F-35-style aircraft shape (blended fuselage, swept
  wings, canted tails); it is not CAD data and implies no affiliation.
- Seeker FOV cone, body-axis triad, and engine plume visuals.
- The interceptor body colour and engine glow are illustrative, not measured.

The following are **measured / derived**, never adjusted for looks:

- Position, velocity, attitude, altitude, speed, Mach, dynamic pressure, load,
  range, mass, fin deflections, body rates.

## 6. Legacy numbers

Legacy results (79 % / 86 % hit rate, 13.40 m, 7.94 m, 61.1 m) are reproduced
only in `DATA_AUDIT.md` and in the Resources page, each with its file and line
reference and an explicit unreproducible label. They never feed the live scene.
