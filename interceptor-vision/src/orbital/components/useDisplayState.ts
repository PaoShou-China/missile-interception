import { useEffect, useMemo, useState } from "react";
import { simClock, useAppStore } from "../state/store";
import type { SampledState } from "../scientific/interpolate";

/** Sampled state at the shared (throttled) display time. */
export function useSampledState(): SampledState | null {
  const time = useAppStore((s) => s.time);
  const runtime = useAppStore((s) => s.runtime);
  return useMemo(() => {
    if (!runtime) return null;
    return runtime.missileSampler.sampleAt(time);
  }, [runtime, time]);
}

export function useSampledTarget(): SampledState | null {
  const time = useAppStore((s) => s.time);
  const runtime = useAppStore((s) => s.runtime);
  return useMemo(() => {
    if (!runtime) return null;
    return runtime.targetSampler.sampleAt(time);
  }, [runtime, time]);
}

/**
 * Low-frequency mirror of the clock for text-heavy UI. The 3D scene reads
 * simClock directly, so this throttling never affects visual smoothness.
 */
export function useClockDisplay(intervalMs = 100) {
  const time = useAppStore((s) => s.time);
  const [display, setDisplay] = useState(time);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= intervalMs) {
        last = now;
        setDisplay(simClock.time);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [intervalMs]);
  return display;
}
