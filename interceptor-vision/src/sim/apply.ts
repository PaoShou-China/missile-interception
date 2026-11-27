import { useApp } from "../state";
import { dataClock, getTelemetry, replaceTelemetry, type Telemetry } from "../data/telemetry";
import { defaultSimParams, solveTerminal, type SimParams } from "./terminal";

/**
 * Keeps the recorded payload around while the user runs "what if" solves, so
 * the baseline can be restored without a reload.
 */
let baseline: Telemetry | null = null;

function ensureBaseline(): void {
  if (baseline) return;
  if (useApp.getState().simActive) return;
  const tel = getTelemetry();
  if (tel) baseline = tel;
}

export function simDefaults(): SimParams {
  ensureBaseline();
  return defaultSimParams(baseline ?? getTelemetry());
}

/** Re-solves the terminal leg and makes it the active telemetry source. */
export function runSimulation(params: SimParams): void {
  ensureBaseline();
  const base = baseline ?? getTelemetry();
  if (!base) return;
  const state = useApp.getState();
  state.setSimBusy(true);
  // Paint the busy state before the (synchronous) integration.
  window.setTimeout(() => {
    const t0 = performance.now();
    const tel = solveTerminal(base, params);
    const ms = Math.round(performance.now() - t0);
    replaceTelemetry(tel);
    const lockT = tel.events.find((e) => e.kind === "lock")?.t ?? tel.start;
    dataClock.t = Math.max(tel.start, lockT);
    dataClock.playing = false;
    state.setDataTime(dataClock.t);
    state.setDataPlaying(false);
    state.setDataStatus("ready");
    state.setSimActive(true);
    state.setSimMs(ms);
    state.setSimBusy(false);
  }, 16);
}

/** Returns to the validated recorded payload. */
export function restoreRecorded(): void {
  ensureBaseline();
  if (!baseline) return;
  const state = useApp.getState();
  replaceTelemetry(baseline);
  dataClock.t = baseline.start;
  dataClock.playing = false;
  state.setDataTime(baseline.start);
  state.setDataPlaying(false);
  state.setDataStatus("ready");
  state.setSimActive(false);
  state.setSimMs(0);
}
