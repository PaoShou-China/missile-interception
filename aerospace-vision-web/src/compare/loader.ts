import type { ComparisonManifest, LoadedRun, AlgorithmRun } from "./types";
import type { ScenarioManifest } from "../scientific/types";
import { validateScenario } from "../scientific/scenario";
import { scenarioFingerprint } from "./validation";

const BASE = import.meta.env.BASE_URL;

export async function loadComparisonManifest(
  url = `${BASE}data/compare/comparison.json`,
): Promise<ComparisonManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cannot load comparison manifest (${res.status})`);
  return (await res.json()) as ComparisonManifest;
}

function runsFrom(manifest: ScenarioManifest): Pick<LoadedRun, "missile" | "target"> {
  const missile = manifest.entities.find((e) => e.kind === "missile")?.samples;
  const target = manifest.entities.find((e) => e.kind === "target")?.samples;
  if (!missile?.length || !target?.length) throw new Error("Scenario is missing missile/target samples");
  return { missile, target };
}

/** Load a manifest-declared run (Run A). Validated scenarios only. */
export async function loadDeclaredRun(meta: AlgorithmRun): Promise<LoadedRun> {
  if (meta.availability !== "available") throw new Error(`${meta.run_id} is not available`);
  const res = await fetch(`${BASE}${meta.trajectory_file}`);
  if (!res.ok) throw new Error(`Cannot load ${meta.run_id} (${res.status})`);
  const scenario = (await res.json()) as ScenarioManifest;
  const issues = validateScenario(scenario);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) throw new Error(`Run ${meta.run_id}: ${errors.map((e) => e.message).join("; ")}`);
  return { meta, scenario, ...runsFrom(scenario) };
}

/** Metadata derived from an imported scenario payload. */
export function metaFromScenario(scenario: ScenarioManifest, fileName: string): AlgorithmRun {
  return {
    run_id: "run-b-imported",
    display_name: `${scenario.title} (imported)`,
    algorithm_id: scenario.experiment?.engine ?? scenario.source.generator,
    algorithm_version: scenario.experiment?.name ?? "imported",
    source_commit: scenario.source.commit,
    scenario_id: scenario.id,
    configuration_hash: scenarioFingerprint(scenario),
    seed: null,
    trajectory_file: fileName,
    metrics_file: null,
    data_hash: scenario.source.sha256 ?? scenarioFingerprint(scenario),
    time_start: scenario.time.startS,
    time_end: scenario.time.endS,
    reference_frame: "WGS84 ECEF",
    units: "SI",
    validation_status: scenario.validation.status,
    availability: "available",
    is_synthetic: false,
    notes: ["Imported locally by the reader; not re-simulated."],
  };
}

/** Parse a user-supplied scenario JSON as Run B. */
export async function importRunFile(file: File): Promise<LoadedRun> {
  const text = await file.text();
  let scenario: ScenarioManifest;
  try {
    scenario = JSON.parse(text) as ScenarioManifest;
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  const issues = validateScenario(scenario);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.message).join("\n"));
  return { meta: metaFromScenario(scenario, file.name), scenario, ...runsFrom(scenario) };
}
