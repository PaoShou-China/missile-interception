import type { Lang } from "../i18n/messages";
import type { AlgorithmRun } from "./types";

export interface LocalizedText {
  zh: string;
  en: string;
}

export interface RegistryOption {
  id: string;
  name: LocalizedText;
  version?: string;
  source: string;
  description?: LocalizedText;
}

export interface VehicleProfile extends RegistryOption {
  model_id: string;
  length_m: number;
  diameter_m: number;
  launch_mass_kg: number;
  dry_mass_kg: number;
  fin_span_m: number;
  physical_note?: LocalizedText;
}

export interface ScenarioOption extends RegistryOption {
  synthetic: boolean;
}

export interface ExperimentCombo {
  guidance: string;
  control: string;
  vehicle: string;
  scenario: string;
}

export type CampaignStage = "boost" | "midcourse" | "terminal" | "control" | "architecture";

export interface CampaignRef {
  campaign_id: string;
  stage: CampaignStage;
  law: string;
  level_g: number;
}

export interface ExperimentRecord {
  id: string;
  combo: ExperimentCombo;
  synthetic: boolean;
  validation_status: "PASS" | "FAIL" | "NOT RUN";
  run: AlgorithmRun;
  notes: LocalizedText;
  /** Present when this record is a representative case of a paired campaign. */
  campaigns?: CampaignRef[];
}

export interface CampaignStat {
  n_total: number;
  n_valid: number;
  n_failed: number;
  hits: number;
  hit_rate: number;
  miss_mean: number;
  miss_std: number;
  miss_median: number;
  miss_p90: number;
  miss_max: number;
  handover_rate: number;
  handover_range_km: number;
  handover_lead_deg: number;
  boost_end_mach: number;
  boost_end_alt_km: number;
  midcourse_peak_mach: number;
  midcourse_peak_alt_km: number;
  handover_energy_mjkg: number;
  handover_specific_energy_mjkg?: number;
  terminal_peak_cmd_g: number;
  terminal_peak_act_g: number;
  terminal_fin_sat_pct: number;
  midcourse_fin_sat_pct: number;
}

export interface CampaignManifest {
  schemaVersion: string;
  campaign_id: string;
  generated_at: string;
  seed: number;
  cases_per_law_per_level: number;
  lethal_radius_m: number;
  levels_g: Record<CampaignStage, number[]>;
  laws: Record<CampaignStage, string[]>;
  sweep?: Partial<Record<CampaignStage, string>>;
  stats: Record<string, CampaignStat>;
}

export interface ExperimentRegistry {
  schemaVersion: string;
  registry_id: string;
  generated_from: string;
  guidance: RegistryOption[];
  control: RegistryOption[];
  vehicles: VehicleProfile[];
  scenarios: ScenarioOption[];
  experiments: ExperimentRecord[];
}

export function localized(text: LocalizedText | undefined, lang: Lang): string {
  if (!text) return "";
  return lang === "zh" ? text.zh : text.en;
}

export async function loadRegistry(
  url = `${import.meta.env.BASE_URL}data/experiments/registry.json`,
): Promise<ExperimentRegistry> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cannot load experiment registry (${res.status})`);
  return (await res.json()) as ExperimentRegistry;
}

export function comboKey(c: ExperimentCombo): string {
  return `${c.guidance}|${c.control}|${c.vehicle}|${c.scenario}`;
}

export function findExperiment(
  registry: ExperimentRegistry,
  combo: ExperimentCombo,
): ExperimentRecord | null {
  const key = comboKey(combo);
  return registry.experiments.find((e) => comboKey(e.combo) === key) ?? null;
}

export function optionById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((i) => i.id === id);
}

export async function loadCampaign(
  url = `${import.meta.env.BASE_URL}data/experiments/campaign.json`,
): Promise<CampaignManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cannot load campaign manifest (${res.status})`);
  return (await res.json()) as CampaignManifest;
}

export function campaignKey(stage: CampaignStage, law: string, level: number): string {
  return `${stage}|${law}|${level}`;
}

export function campaignStat(
  manifest: CampaignManifest | null,
  ref: CampaignRef | undefined,
): CampaignStat | null {
  if (!manifest || !ref) return null;
  return manifest.stats[campaignKey(ref.stage, ref.law, ref.level_g)] ?? null;
}

/** Pick the campaign slice of A that matches the stage B is reporting. */
export function sharedCampaignRef(
  a: ExperimentRecord | null | undefined,
  b: ExperimentRecord | null | undefined,
): { a: CampaignRef; b: CampaignRef } | null {
  if (!a?.campaigns?.length || !b?.campaigns?.length) return null;
  for (const refB of b.campaigns) {
    const refA = a.campaigns.find(
      (r) => r.campaign_id === refB.campaign_id && r.stage === refB.stage && r.level_g === refB.level_g,
    );
    if (refA) return { a: refA, b: refB };
  }
  return null;
}
