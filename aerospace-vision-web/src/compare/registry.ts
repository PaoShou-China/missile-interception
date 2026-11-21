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

export interface ExperimentRecord {
  id: string;
  combo: ExperimentCombo;
  synthetic: boolean;
  validation_status: "PASS" | "FAIL" | "NOT RUN";
  run: AlgorithmRun;
  notes: LocalizedText;
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
