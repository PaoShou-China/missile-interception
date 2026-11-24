import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { dataClock, getTelemetry } from "../data/telemetry";
import { useApp } from "../state";

/** Advances the validated telemetry clock and mirrors it to the UI at ~12 Hz. */
export function TelemetryClock() {
  const acc = useRef(0);
  const store = useMemo(() => useApp, []);

  useFrame((_, delta) => {
    const state = store.getState();
    if (state.dataStatus !== "ready" || state.cameraMode === "cinematic") return;
    const tel = getTelemetry();
    if (!tel) return;

    if (dataClock.playing) {
      dataClock.t += delta * dataClock.rate;
      if (dataClock.t >= tel.end) {
        dataClock.t = tel.end;
        dataClock.playing = false;
        state.setDataPlaying(false);
      }
    }
    acc.current += delta;
    if (acc.current >= 0.08) {
      acc.current = 0;
      if (Math.abs(state.dataTime - dataClock.t) > 0.01) state.setDataTime(dataClock.t);
    }
  });

  return null;
}
