import type {
  AlgorithmRun,
  ComparisonLevel,
  ComparisonManifest,
  ComparisonMetric,
  MatchIssue,
  MatchResult,
  LoadedRun,
} from "./types";
import type { ScenarioManifest, TrajectorySample } from "../scientific/types";
import { SCHEMA_VERSION } from "../scientific/types";

/** Stable FNV-1a hash for configuration fingerprints (not cryptographic). */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function scenarioFingerprint(s: ScenarioManifest): string {
  return fingerprint({
    id: s.id,
    earth: s.earth,
    launch: { lat: s.launchSite.latDeg, lon: s.launchSite.lonDeg, alt: s.launchSite.altM },
    target: { lat: s.targetSite.latDeg, lon: s.targetSite.lonDeg, alt: s.targetSite.altM },
    start: s.time.startS,
    end: s.time.endS,
  });
}

export interface ComparisonValidationIssue {
  id: string;
  message: string;
  severity: "error" | "warning";
}

export function validateComparisonManifest(m: ComparisonManifest): ComparisonValidationIssue[] {
  const issues: ComparisonValidationIssue[] = [];
  const err = (id: string, message: string) => issues.push({ id, message, severity: "error" });
  const warn = (id: string, message: string) => issues.push({ id, message, severity: "warning" });

  if (m.schemaVersion !== "1.0.0") err("schema", `Unsupported comparison schema ${m.schemaVersion}`);
  if (!m.comparison_id) err("id", "comparison_id is required");
  if (!m.runs?.length) err("runs", "at least one run is required");
  if (m.runs.length > 1 && m.runs[0].run_id === m.runs[1].run_id) err("run-id", "run ids must be unique");
  if (m.matching_status === "C" && m.validation_status === "PASS") {
    warn("level-c", "Level C comparisons must not claim a validated performance conclusion");
  }
  for (const run of m.runs) {
    if (run.availability === "available") {
      if (!run.trajectory_file) err(`file-${run.run_id}`, `${run.run_id}: trajectory_file missing`);
      if (!(run.time_end > run.time_start)) err(`time-${run.run_id}`, `${run.run_id}: invalid time range`);
      if (!run.data_hash) warn(`hash-${run.run_id}`, `${run.run_id}: data hash missing`);
    }
    if (run.is_synthetic && run.validation_status === "PASS") {
      err(`synthetic-${run.run_id}`, "synthetic runs cannot be marked as validated");
    }
  }
  return issues;
}

export function matchRuns(
  metaA: AlgorithmRun,
  scenarioA: ScenarioManifest,
  metaB: AlgorithmRun,
  scenarioB: ScenarioManifest,
): MatchResult {
  const issues: MatchIssue[] = [];
  const add = (
    field: string,
    a: string,
    b: string,
    severity: "blocking" | "warning",
    message: string,
  ) => issues.push({ field, a, b, severity, message });

  if (metaB.is_synthetic) {
    add("source", "measured/validated telemetry", "synthetic UI demo", "blocking",
      "Synthetic demonstration data cannot support a scientific comparison.");
  }
  if (scenarioA.id !== scenarioB.id) {
    add("scenario", scenarioA.id, scenarioB.id, "blocking", "Different scenario identifiers.");
  }
  if (scenarioFingerprint(scenarioA) !== scenarioFingerprint(scenarioB)) {
    add("configuration", scenarioFingerprint(scenarioA), scenarioFingerprint(scenarioB), "blocking",
      "Initial conditions, datums or time base differ.");
  }
  if (scenarioA.earth.model !== scenarioB.earth.model) {
    add("earth", scenarioA.earth.model, scenarioB.earth.model, "blocking", "Different Earth models.");
  }
  if (metaA.source_commit !== metaB.source_commit) {
    add("commit", metaA.source_commit, metaB.source_commit, "warning", "Source commits differ.");
  }
  if (metaA.algorithm_id === metaB.algorithm_id && metaA.algorithm_version === metaB.algorithm_version) {
    add("algorithm", `${metaA.algorithm_id}@${metaA.algorithm_version}`,
      `${metaB.algorithm_id}@${metaB.algorithm_version}`, "warning",
      "Both runs appear to use the same algorithm version.");
  }
  if (metaB.validation_status !== "PASS") {
    add("validation", metaA.validation_status, metaB.validation_status, "warning",
      "Run B is not validated.");
  }

  const blocking = issues.some((i) => i.severity === "blocking");
  const level: ComparisonLevel = blocking ? "C" : issues.length ? "B" : "A";
  return {
    level,
    issues,
    eligibleForPerformanceClaims: level !== "C" && !metaB.is_synthetic && metaB.validation_status === "PASS",
  };
}

const METRIC_SPECS: { id: keyof ScenarioManifest["metrics"]; name: string; unit: string; source: string }[] = [
  { id: "missDistanceM", name: "Miss distance", unit: "m", source: "scenario.metrics" },
  { id: "interceptTimeS", name: "Intercept time", unit: "s", source: "scenario.metrics" },
  { id: "maxSpeedMS", name: "Max speed", unit: "m/s", source: "scenario.metrics" },
  { id: "maxMach", name: "Max Mach", unit: "—", source: "scenario.metrics" },
  { id: "maxAltitudeM", name: "Apogee", unit: "m", source: "scenario.metrics" },
  { id: "downrangeKM", name: "Downrange", unit: "km", source: "scenario.metrics" },
  { id: "maxDynamicPressurePa", name: "Max dynamic pressure", unit: "Pa", source: "scenario.metrics" },
  { id: "maxLoadG", name: "Max load", unit: "g", source: "scenario.metrics" },
  { id: "flightDurationS", name: "Flight duration", unit: "s", source: "scenario.metrics" },
];

export function buildComparisonMetrics(a: ScenarioManifest, b: ScenarioManifest | null): ComparisonMetric[] {
  return METRIC_SPECS.map((spec) => {
    const va = Number(a.metrics[spec.id]);
    const vb = b ? Number(b.metrics[spec.id]) : null;
    return {
      metric_id: String(spec.id),
      display_name: spec.name,
      unit: spec.unit,
      data_source: spec.source,
      aggregation: "single-run" as const,
      metric_definition: "Value recorded in the run manifest; no re-simulation.",
      value_a: Number.isFinite(va) ? va : null,
      value_b: vb !== null && Number.isFinite(vb) ? vb : null,
      comparison_eligible: b !== null && b !== undefined,
      uncertainty: null,
    };
  });
}

const stride = (n: number) => Math.max(1, Math.ceil(n / 600));

/** Common-time difference series; callers must supply the same unit/definition. */
export function differenceSeries(
  a: TrajectorySample[],
  b: TrajectorySample[],
  pick: (s: TrajectorySample) => number,
): [number, number][] {
  if (!a.length || !b.length) return [];
  const start = Math.max(a[0].t, b[0].t);
  const end = Math.min(a[a.length - 1].t, b[b.length - 1].t);
  const step = stride(Math.min(a.length, b.length));
  const out: [number, number][] = [];
  let ia = 0;
  let ib = 0;
  for (let i = 0; i < a.length; i += step) {
    const t = a[i].t;
    if (t < start || t > end) continue;
    while (ia + 1 < a.length && a[ia + 1].t < t) ia++;
    while (ib + 1 < b.length && b[ib + 1].t < t) ib++;
    // Linear interpolation on B for the common time.
    const b0 = b[ib];
    const b1 = b[Math.min(ib + 1, b.length - 1)];
    const span = b1.t - b0.t;
    const u = span > 0 ? (t - b0.t) / span : 0;
    const bv = pick(b0) + (pick(b1) - pick(b0)) * Math.min(1, Math.max(0, u));
    out.push([t, +(bv - pick(a[i])).toFixed(3)]);
  }
  return out;
}

/** Deterministic synthetic run used only for UI demonstration. Never validated. */
export function makeSyntheticDemo(a: LoadedRun): LoadedRun {
  const perturb = (s: TrajectorySample): TrajectorySample => {
    const t = s.t;
    const dx = 220 * Math.sin(t / 41);
    const dy = 160 * Math.sin(t / 57 + 1.2);
    const dz = 120 * Math.sin(t / 33 + 0.4);
    return {
      ...s,
      position: { x: s.position.x + dx, y: s.position.y + dy, z: s.position.z + dz },
    };
  };
  const missile = a.missile.map(perturb);
  const meta: AlgorithmRun = {
    ...a.meta,
    run_id: "run-b-demo",
    display_name: "Synthetic UI demo (not a scientific result)",
    algorithm_id: "synthetic-demo",
    algorithm_version: "ui-only",
    source_commit: "synthetic",
    configuration_hash: "synthetic",
    data_hash: "synthetic",
    validation_status: "NOT RUN",
    availability: "available",
    is_synthetic: true,
    notes: [
      "Generated in the browser from run A by a smooth positional perturbation.",
      "Shown only to exercise the comparison UI; excluded from scientific claims.",
    ],
  };
  const scenario: ScenarioManifest = {
    ...a.scenario,
    title: a.scenario.title + " — synthetic UI demo",
    validation: { status: "NOT RUN", checks: [] },
  };
  return {
    meta,
    scenario,
    missile,
    target: a.target,
  };
}

export function compareStatusLabel(level: ComparisonLevel): string {
  if (level === "A") return "Strictly matched";
  if (level === "B") return "Partially matched";
  return "Not directly comparable";
}

/** Offset added to B time so a matching event coincides with A (labels only). */
export function eventAlignmentOffset(
  a: { events: { label: string; t: number }[] },
  b: { events: { label: string; t: number }[] },
): number {
  for (const ea of a.events) {
    const eb = b.events.find((e) => e.label === ea.label);
    if (eb) return eb.t - ea.t;
  }
  return 0;
}

export { SCHEMA_VERSION };
