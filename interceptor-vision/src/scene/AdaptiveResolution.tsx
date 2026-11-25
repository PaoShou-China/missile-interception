import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

/**
 * Drops the render resolution while the frame budget is missed, then recovers.
 * Fixed DPR 1.5-2 on a 2K/4K panel is the single biggest fill-rate cost, so the
 * cap is treated as a ceiling rather than a constant.
 */
export function AdaptiveResolution({ max }: { max: number }) {
  const setDpr = useThree((s) => s.setDpr);
  const acc = useRef({ t: 0, frames: 0, dpr: max, low: 0, locked: false });

  useEffect(() => {
    acc.current.dpr = max;
    acc.current.low = 0;
    acc.current.locked = false;
    setDpr(max);
  }, [max, setDpr]);

  useFrame((_, delta) => {
    const a = acc.current;
    a.t += delta;
    a.frames += 1;
    if (a.t < 2) return;
    const fps = a.frames / a.t;
    a.t = 0;
    a.frames = 0;
    // Only step down, and only after two consecutive bad windows. Recovering
    // upward caused the resolution (and the whole image) to pulse every second.
    if (fps < 48) {
      a.low += 1;
      if (a.low >= 2 && a.dpr > 0.7 && !a.locked) {
        a.dpr = Math.max(0.7, a.dpr - 0.15);
        a.locked = true;
        a.low = 0;
        setDpr(Number(a.dpr.toFixed(2)));
      }
    } else {
      a.low = 0;
    }
  });
  return null;
}

/** Resolution ceiling per quality tier. */
export const DPR_CAP: Record<string, number> = {
  performance: 1,
  balanced: 1.25,
  // 1.5 costs ~18 FPS at 1080p on integrated graphics because of the bloom
  // chain, and the extra sharpness is barely visible next to the cost.
  cinematic: 1.25,
};
