import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

/**
 * Drops the render resolution while the frame budget is missed, then recovers.
 * Fixed DPR 1.5-2 on a 2K/4K panel is the single biggest fill-rate cost, so the
 * cap is treated as a ceiling rather than a constant.
 */
export function AdaptiveResolution({ max }: { max: number }) {
  const setDpr = useThree((s) => s.setDpr);
  const acc = useRef({ t: 0, frames: 0, dpr: max });

  useEffect(() => {
    acc.current.dpr = max;
    setDpr(max);
  }, [max, setDpr]);

  useFrame((_, delta) => {
    const a = acc.current;
    a.t += delta;
    a.frames += 1;
    if (a.t < 1.2) return;
    const fps = a.frames / a.t;
    a.t = 0;
    a.frames = 0;
    let next = a.dpr;
    if (fps < 44 && next > 0.7) next = Math.max(0.7, next - 0.15);
    else if (fps > 57 && next < max) next = Math.min(max, next + 0.05);
    if (Math.abs(next - a.dpr) < 0.01) return;
    a.dpr = next;
    setDpr(Number(next.toFixed(2)));
  });
  return null;
}

/** Resolution ceiling per quality tier. */
export const DPR_CAP: Record<string, number> = {
  performance: 1,
  balanced: 1.25,
  cinematic: 1.5,
};
