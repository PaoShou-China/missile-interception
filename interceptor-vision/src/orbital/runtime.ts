import type { ScenarioManifest } from "./scientific/types";
import { TrajectorySampler } from "./scientific/interpolate";
import type { ScenarioRuntime } from "./state/store";
import type { Telemetry } from "../data/telemetry";

/** Convert the lazily loaded telemetry payload into the orbital store runtime. */
export function buildRuntime(tel: Telemetry): ScenarioRuntime {
  return {
    manifest: tel.manifest as ScenarioManifest,
    missile: tel.samples as ScenarioRuntime["missile"],
    target: tel.targetSamples as ScenarioRuntime["target"],
    missileSampler: new TrajectorySampler(tel.samples as ScenarioRuntime["missile"]),
    targetSampler: new TrajectorySampler(tel.targetSamples as ScenarioRuntime["target"]),
  };
}
