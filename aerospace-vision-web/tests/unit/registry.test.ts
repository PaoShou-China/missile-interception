import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  comboKey,
  findExperiment,
  localized,
  optionById,
  type ExperimentRegistry,
} from "../../src/compare/registry";

const root = path.resolve(__dirname, "../..");
const registry = JSON.parse(
  fs.readFileSync(path.join(root, "public/data/experiments/registry.json"), "utf8"),
) as ExperimentRegistry;

describe("experiment registry", () => {
  it("has unique option ids in every column", () => {
    for (const column of [registry.guidance, registry.control, registry.vehicles, registry.scenarios]) {
      const ids = column.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("every experiment references existing registry options", () => {
    for (const exp of registry.experiments) {
      expect(optionById(registry.guidance, exp.combo.guidance)).toBeDefined();
      expect(optionById(registry.control, exp.combo.control)).toBeDefined();
      expect(optionById(registry.vehicles, exp.combo.vehicle)).toBeDefined();
      expect(optionById(registry.scenarios, exp.combo.scenario)).toBeDefined();
    }
  });

  it("only exposes combinations that map to a record", () => {
    for (const exp of registry.experiments) {
      expect(findExperiment(registry, exp.combo)?.id).toBe(exp.id);
    }
  });

  it("returns null for a combination without a record", () => {
    const base = registry.experiments[0].combo;
    const missing = { ...base, guidance: "not-implemented" };
    expect(findExperiment(registry, missing)).toBeNull();
    expect(comboKey(missing)).toContain("not-implemented");
  });

  it("keeps exactly one real validated experiment", () => {
    const real = registry.experiments.filter((e) => !e.synthetic);
    expect(real).toHaveLength(1);
    expect(real[0].validation_status).toBe("PASS");
    expect(real[0].run.is_synthetic).toBe(false);
  });

  it("marks every synthetic record as a UI-only demo", () => {
    const synthetic = registry.experiments.filter((e) => e.synthetic);
    expect(synthetic.length).toBeGreaterThan(0);
    for (const exp of synthetic) {
      expect(exp.run.is_synthetic).toBe(true);
      expect(exp.run.trajectory_file).toBe("");
      expect(optionById(registry.scenarios, exp.combo.scenario)?.synthetic).toBe(true);
    }
  });

  it("localises option names for both languages", () => {
    const vehicle = registry.vehicles[0];
    expect(localized(vehicle.name, "zh")).not.toBe("");
    expect(localized(vehicle.name, "en")).not.toBe("");
    expect(localized(vehicle.name, "zh")).not.toBe(localized(vehicle.name, "en"));
  });
});
