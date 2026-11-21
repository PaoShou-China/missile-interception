import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AlgorithmRun, ComparisonManifest } from "../../src/compare/types";
import type { ScenarioManifest } from "../../src/scientific/types";
import {
  buildComparisonMetrics,
  differenceSeries,
  eventAlignmentOffset,
  makeSyntheticDemo,
  matchRuns,
  scenarioFingerprint,
  validateComparisonManifest,
} from "../../src/compare/validation";

const root = path.resolve(__dirname, "../..");
const scenario = JSON.parse(
  fs.readFileSync(path.join(root, "public/data/missile-intercept/scenario.json"), "utf8"),
) as ScenarioManifest;
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "public/data/compare/comparison.json"), "utf8"),
) as ComparisonManifest;

const meta = (over: Partial<AlgorithmRun> = {}): AlgorithmRun => ({
  run_id: "run-a",
  display_name: "A",
  algorithm_id: "algo-a",
  algorithm_version: "1",
  source_commit: "abc",
  scenario_id: scenario.id,
  configuration_hash: "h",
  seed: null,
  trajectory_file: "data/missile-intercept/scenario.json",
  metrics_file: null,
  data_hash: "d",
  time_start: scenario.time.startS,
  time_end: scenario.time.endS,
  reference_frame: "WGS84 ECEF",
  units: "SI",
  validation_status: "PASS",
  availability: "available",
  is_synthetic: false,
  notes: [],
  ...over,
});

describe("comparison contract", () => {
  it("ships a valid manifest with one real run and a pending B", () => {
    const errors = validateComparisonManifest(manifest).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
    expect(manifest.runs).toHaveLength(2);
    expect(manifest.runs[0].availability).toBe("available");
    expect(manifest.runs[1].availability).toBe("awaiting-import");
    expect(manifest.runs[0].validation_status).toBe("PASS");
  });

  it("marks identical conditions as strictly matched", () => {
    const a = meta();
    const b = meta({ run_id: "run-b", algorithm_id: "algo-b", algorithm_version: "2" });
    const result = matchRuns(a, scenario, b, structuredClone(scenario));
    expect(result.level).toBe("A");
    expect(result.eligibleForPerformanceClaims).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("records commit differences as partially matched", () => {
    const result = matchRuns(meta(), scenario, meta({ run_id: "run-b", source_commit: "def", algorithm_id: "algo-b" }), structuredClone(scenario));
    expect(result.level).toBe("B");
    expect(result.eligibleForPerformanceClaims).toBe(true);
    expect(result.issues.some((i) => i.field === "commit")).toBe(true);
  });

  it("blocks comparison when initial conditions differ", () => {
    const changed = structuredClone(scenario);
    changed.launchSite.latDeg += 0.5;
    const result = matchRuns(meta(), scenario, meta({ run_id: "run-b", algorithm_id: "algo-b" }), changed);
    expect(result.level).toBe("C");
    expect(result.eligibleForPerformanceClaims).toBe(false);
  });

  it("never allows synthetic data to support a performance claim", () => {
    const demo = makeSyntheticDemo({
      meta: meta(),
      scenario,
      missile: scenario.entities[0].samples!,
      target: scenario.entities[1].samples!,
    });
    const result = matchRuns(meta(), scenario, demo.meta, demo.scenario);
    expect(result.level).toBe("C");
    expect(result.eligibleForPerformanceClaims).toBe(false);
    expect(demo.meta.validation_status).toBe("NOT RUN");
  });

  it("ignores flight duration but not initial conditions in the fingerprint", () => {
    const longer = structuredClone(scenario);
    longer.time.endS += 9.4;
    expect(scenarioFingerprint(longer)).toBe(scenarioFingerprint(scenario));
    const moved = structuredClone(scenario);
    moved.targetSite.latDeg += 0.2;
    expect(scenarioFingerprint(moved)).not.toBe(scenarioFingerprint(scenario));
  });

  it("keeps B values unavailable until a run is imported", () => {
    const metrics = buildComparisonMetrics(scenario, null);
    expect(metrics.length).toBeGreaterThan(4);
    expect(metrics.every((m) => m.value_b === null && !m.comparison_eligible)).toBe(true);
  });

  it("computes Δ(t) only on the common time interval", () => {
    const a = scenario.entities[0].samples!;
    const b = a.map((s) => ({ ...s, position: { x: s.position.x + 100, y: s.position.y, z: s.position.z } }));
    const diff = differenceSeries(a, b, (s) => s.position.x);
    expect(diff.length).toBeGreaterThan(10);
    expect(diff.every(([, v]) => Math.abs(v - 100) < 1e-6)).toBe(true);
  });

  it("aligns events by label without changing absolute timestamps", () => {
    const offset = eventAlignmentOffset(scenario, {
      ...scenario,
      events: scenario.events.map((e) => ({ ...e, t: e.t + 2 })),
    });
    expect(offset).toBe(2);
  });
});
