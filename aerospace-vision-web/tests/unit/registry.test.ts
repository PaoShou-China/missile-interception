import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  campaignKey,
  comboKey,
  findExperiment,
  localized,
  optionById,
  type CampaignManifest,
  type ExperimentRegistry,
} from "../../src/compare/registry";

const root = path.resolve(__dirname, "../..");
const registry = JSON.parse(
  fs.readFileSync(path.join(root, "public/data/experiments/registry.json"), "utf8"),
) as ExperimentRegistry;
const campaign = JSON.parse(
  fs.readFileSync(path.join(root, "public/data/experiments/campaign.json"), "utf8"),
) as CampaignManifest;

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

  it("offers at least three guidance laws and three attitude controllers", () => {
    expect(registry.guidance.length).toBeGreaterThanOrEqual(3);
    expect(registry.control.length).toBeGreaterThanOrEqual(3);
  });

  it("has a real experiment for every guidance and control option", () => {
    const real = registry.experiments.filter((e) => !e.synthetic);
    expect(real.length).toBeGreaterThanOrEqual(4);
    for (const option of registry.guidance) {
      expect(real.some((e) => e.combo.guidance === option.id), option.id).toBe(true);
    }
    for (const option of registry.control) {
      expect(real.some((e) => e.combo.control === option.id), option.id).toBe(true);
    }
  });

  it("keeps every real record on the same scenario and validation state", () => {
    const real = registry.experiments.filter((e) => !e.synthetic);
    const scenarioIds = new Set(real.map((e) => e.run.scenario_id));
    expect(scenarioIds.size).toBe(1);
    for (const exp of real) {
      expect(exp.run.trajectory_file).not.toBe("");
      expect(exp.validation_status).toBe("PASS");
      expect(exp.run.is_synthetic).toBe(false);
    }
  });

  it("resolves every campaign reference to a real statistics slice", () => {
    const refs = registry.experiments.flatMap((e) => e.campaigns ?? []);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const ref of refs) {
      expect(ref.campaign_id).toBe(campaign.campaign_id);
      const key = campaignKey(ref.stage, ref.law, ref.level_g);
      expect(campaign.stats[key], key).toBeDefined();
      expect(campaign.stats[key].n_total).toBeGreaterThanOrEqual(campaign.cases_per_law_per_level);
      expect(campaign.levels_g[ref.stage]).toContain(ref.level_g);
      expect(campaign.laws[ref.stage]).toContain(ref.law);
    }
  });

  it("ships the full paired campaign, not only the representative level", () => {
    expect(campaign.cases_per_law_per_level).toBeGreaterThanOrEqual(4);
    expect(campaign.levels_g.terminal.length).toBeGreaterThanOrEqual(2);
    expect(campaign.levels_g.midcourse.length).toBeGreaterThanOrEqual(2);
    expect(campaign.levels_g.boost.length).toBeGreaterThanOrEqual(2);
    expect(campaign.levels_g.control.length).toBeGreaterThanOrEqual(2);
    expect(campaign.levels_g.architecture.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(campaign.stats).length).toBe(
      (campaign.laws.terminal.length * campaign.levels_g.terminal.length)
      + (campaign.laws.midcourse.length * campaign.levels_g.midcourse.length)
      + (campaign.laws.boost.length * campaign.levels_g.boost.length)
      + (campaign.laws.control.length * campaign.levels_g.control.length)
      + (campaign.laws.architecture.length * campaign.levels_g.architecture.length),
    );
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
