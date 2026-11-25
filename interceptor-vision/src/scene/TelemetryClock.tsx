import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { dataClock, getTelemetry } from "../data/telemetry";
import { useApp } from "../state";
import { useAppStore as useOrbitalStore } from "../orbital/state/store";

/** Advances the validated telemetry clock and mirrors it to the UI at ~12 Hz. */
export function TelemetryClock() {
  const acc = useRef(0);
  const store = useMemo(() => useApp, []);

  useFrame((_, delta) => {
    const state = store.getState();
    if (state.dataStatus !== "ready" || state.cameraMode === "cinematic") return;
    // The orbital three-minute film owns the clock while it runs.
    if (state.sceneMode === "orbital" && useOrbitalStore.getState().presentation === "cinematic") return;
    const tel = getTelemetry();
    if (!tel) return;

    if (dataClock.playing) {
      dataClock.t += Math.min(delta, 0.1) * dataClock.rate;
      if (dataClock.t >= tel.end) {
        dataClock.t = tel.end;
        dataClock.playing = false;
        state.setDataPlaying(false);
      }
    }
    acc.current += delta;
    // The 3D scene samples the clock directly; the React mirror only needs to
    // refresh the numeric read-outs, so 7 Hz is plenty and halves panel churn.
    if (acc.current >= 0.14) {
      acc.current = 0;
      if (Math.abs(state.dataTime - dataClock.t) > 0.01) state.setDataTime(dataClock.t);
    }
  });

  return null;
}
