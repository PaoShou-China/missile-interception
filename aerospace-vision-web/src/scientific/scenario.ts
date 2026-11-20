/**
 * Scenario loading and structural/scientific validation.
 * The renderer refuses to start unless the payload passes these checks.
 */
import type {
  ScenarioManifest,
  TrajectorySample,
  PhaseSegment,
  VisualizationEvent,
} from "./types";
import { SCHEMA_VERSION } from "./types";
import { geodeticToEcef } from "./geodesy";

export interface ValidationIssue {
  id: string;
  message: string;
  severity: "error" | "warning";
}

export interface LoadedScenario {
  manifest: ScenarioManifest;
  missile: TrajectorySample[];
  target: TrajectorySample[];
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function checkSamples(
  samples: TrajectorySample[],
  id: string,
  issues: ValidationIssue[],
) {
  if (!Array.isArray(samples) || samples.length < 2) {
    issues.push({ id: `${id}-count`, message: `${id}: fewer than 2 samples`, severity: "error" });
    return;
  }
  let prevT = -Infinity;
  let maxQNorm = 0;
  let maxGeodeticErr = 0;
  for (const s of samples) {
    if (!isFiniteNumber(s.t) || s.t <= prevT) {
      issues.push({ id: `${id}-time`, message: `${id}: non-monotonic sample time`, severity: "error" });
      break;
    }
    prevT = s.t;
    const vals = [
      s.position.x, s.position.y, s.position.z,
      s.velocity.x, s.velocity.y, s.velocity.z,
      s.altM, s.speedMS, s.mach, s.qPa, s.rangeM,
    ];
    if (vals.some((v) => !isFiniteNumber(v))) {
      issues.push({ id: `${id}-finite`, message: `${id}: non-finite value at t=${s.t}`, severity: "error" });
      break;
    }
    const qn = Math.hypot(s.attitude.w, s.attitude.x, s.attitude.y, s.attitude.z);
    maxQNorm = Math.max(maxQNorm, Math.abs(qn - 1));
    const g = geodeticToEcef(s.latDeg, s.lonDeg, s.altM);
    maxGeodeticErr = Math.max(
      maxGeodeticErr,
      Math.hypot(g.x - s.position.x, g.y - s.position.y, g.z - s.position.z),
    );
  }
  if (maxQNorm > 1e-5) {
    issues.push({
      id: `${id}-quat`,
      message: `${id}: quaternion norm deviates by ${maxQNorm.toExponential(2)}`,
      severity: "error",
    });
  }
  if (maxGeodeticErr > 1) {
    issues.push({
      id: `${id}-geodetic`,
      message: `${id}: ECEF/geodetic mismatch ${maxGeodeticErr.toFixed(2)} m`,
      severity: "error",
    });
  }
}

export function validateScenario(manifest: ScenarioManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    issues.push({
      id: "schema-version",
      message: `unsupported schema ${manifest.schemaVersion} (expected ${SCHEMA_VERSION})`,
      severity: "error",
    });
  }
  if (!manifest.earth || manifest.earth.model !== "wgs84") {
    issues.push({ id: "earth-model", message: "earth model must be WGS84", severity: "error" });
  }
  if (manifest.frames?.render !== "ECEF") {
    issues.push({ id: "render-frame", message: "render frame must be ECEF", severity: "error" });
  }
  if (manifest.validation?.status !== "PASS") {
    issues.push({
      id: "adapter-validation",
      message: "adapter validation report is not PASS",
      severity: "error",
    });
  }

  const missile = manifest.entities.find((e) => e.kind === "missile" && e.samples);
  const target = manifest.entities.find((e) => e.kind === "target" && e.samples);
  if (!missile?.samples) {
    issues.push({ id: "missile-entity", message: "missing missile samples", severity: "error" });
  } else {
    checkSamples(missile.samples, "missile", issues);
    const t0 = missile.samples[0].t;
    const t1 = missile.samples[missile.samples.length - 1].t;
    if (Math.abs(t0 - manifest.time.startS) > 1e-6 || Math.abs(t1 - manifest.time.endS) > 1e-3) {
      issues.push({
        id: "time-axis",
        message: "manifest time range does not match sample endpoints",
        severity: "error",
      });
    }
  }
  if (!target?.samples) {
    issues.push({ id: "target-entity", message: "missing target samples", severity: "error" });
  } else {
    checkSamples(target.samples, "target", issues);
  }

  const phases: PhaseSegment[] = manifest.phases ?? [];
  let prevEnd = -Infinity;
  for (const p of phases) {
    if (!(p.endT > p.startT) || p.startT < prevEnd - 1e-6) {
      issues.push({ id: "phase-order", message: `invalid phase segment ${p.phase}`, severity: "error" });
      break;
    }
    prevEnd = p.endT;
  }
  const events: VisualizationEvent[] = manifest.events ?? [];
  if (!events.some((e) => e.kind === "intercept")) {
    issues.push({ id: "intercept-event", message: "missing intercept event", severity: "warning" });
  }
  return issues;
}

export async function loadScenario(
  url = `${import.meta.env.BASE_URL}data/missile-intercept/scenario.json`,
): Promise<LoadedScenario> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load scenario (${res.status}) from ${url}`);
  const manifest = (await res.json()) as ScenarioManifest;
  const issues = validateScenario(manifest);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) {
    throw new Error(`Scenario validation failed:\n${errors.map((e) => e.message).join("\n")}`);
  }
  const missile = manifest.entities.find((e) => e.kind === "missile")!.samples!;
  const target = manifest.entities.find((e) => e.kind === "target")!.samples!;
  return { manifest, missile, target };
}

let cached: Promise<LoadedScenario> | null = null;

/** Shared, memoised load used by the academic pages and the explorer. */
export function loadScenarioCached(): Promise<LoadedScenario> {
  if (!cached) cached = loadScenario();
  return cached;
}
