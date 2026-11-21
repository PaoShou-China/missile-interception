/**
 * Algorithm Comparison Studio — frozen public contracts.
 *
 * These types describe read-only comparison of already-generated experiment
 * records. They never trigger a new simulation and never rewrite source data.
 */

export const COMPARISON_SCHEMA_VERSION = "1.0.0";

export type Availability = "available" | "awaiting-import" | "missing";
export type ComparisonLevel = "A" | "B" | "C";
export type AlignmentMode = "absolute" | "event-aligned" | "independent";
export type ComparisonMode = "side-by-side" | "overlay" | "before-after" | "statistics";
export type CameraPreset = "global" | "flight" | "attitude" | "structure";

export interface AlgorithmRun {
  run_id: string;
  display_name: string;
  algorithm_id: string;
  algorithm_version: string;
  source_commit: string;
  scenario_id: string;
  configuration_hash: string;
  seed: number | null;
  trajectory_file: string;
  metrics_file: string | null;
  data_hash: string;
  time_start: number;
  time_end: number;
  reference_frame: string;
  units: string;
  validation_status: "PASS" | "FAIL" | "NOT RUN";
  availability: Availability;
  /** True only for the clearly labelled UI demo; never a scientific result. */
  is_synthetic: boolean;
  notes: string[];
}

export interface ComparisonManifest {
  comparison_id: string;
  title: string;
  description: string;
  schemaVersion: string;
  comparison_protocol: {
    name: string;
    matching_criteria: string[];
    statistical_scope: string;
    notes: string[];
  };
  runs: AlgorithmRun[];
  alignment_mode: AlignmentMode;
  common_scenario_id: string;
  matching_status: ComparisonLevel;
  validation_status: "PASS" | "FAIL" | "NOT RUN";
  source_links: { label: string; href: string }[];
}

export interface ComparisonMetric {
  metric_id: string;
  display_name: string;
  unit: string;
  data_source: string;
  aggregation: "single-run" | "mean" | "median";
  metric_definition: string;
  value_a: number | null;
  value_b: number | null;
  comparison_eligible: boolean;
  uncertainty: number | null;
}

export interface ComparisonState {
  run_a: string | null;
  run_b: string | null;
  comparison_time: number;
  synchronization_mode: AlignmentMode;
  camera_mode: CameraPreset;
  visual_mode: ComparisonMode;
  overlay_enabled: boolean;
  selected_metric: string | null;
  selected_event: string | null;
}

/** Runtime pairing of a manifest row with its loaded trajectory payload. */
export interface LoadedRun {
  meta: AlgorithmRun;
  scenario: import("../scientific/types").ScenarioManifest;
  missile: import("../scientific/types").TrajectorySample[];
  target: import("../scientific/types").TrajectorySample[];
}

export interface MatchIssue {
  field: string;
  a: string;
  b: string;
  severity: "blocking" | "warning";
  message: string;
}

export interface MatchResult {
  level: ComparisonLevel;
  issues: MatchIssue[];
  eligibleForPerformanceClaims: boolean;
}
