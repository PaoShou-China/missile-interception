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
      // The last 10 s of data cover ~28 km while closing at 2.8 km/s, so at 20x
      // the whole endgame is one frame. Ramp the effective rate down with the
      // time left so the terminal approach lasts ~14 s of wall time and the
      // target actually resolves before the flyby.
      const remaining = tel.end - dataClock.t;
      const effective =
        remaining < 10
          ? Math.min(dataClock.rate, Math.max(0.12, remaining * 0.25))
          : dataClock.rate;
      dataClock.t += Math.min(delta, 0.1) * effective;
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
