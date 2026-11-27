import data from "./aero-interceptor.json";

export interface AeroPoint {
  ca: number;
  cn: number;
  cm: number;
}

const MACH: number[] = data.mach;
const ALPHA: number[] = data.alphaDeg;
const CA: number[][] = data.ca;
const CN: number[][] = data.cn;
const CM: number[][] = data.cm;

export const AERO_REF = data.geometry;
export const AERO_META = data.meta;

function bracket(arr: number[], v: number): [number, number, number] {
  if (v <= arr[0]) return [0, 0, 0];
  if (v >= arr[arr.length - 1]) {
    const n = arr.length - 1;
    return [n, n, 0];
  }
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid;
  }
  const span = arr[hi] - arr[lo] || 1;
  return [lo, hi, (v - arr[lo]) / span];
}

/** Bilinear interpolation of the engineering-estimate coefficient tables. */
export function aeroAt(mach: number, alphaDeg: number): AeroPoint {
  const [i0, i1, km] = bracket(MACH, mach);
  const [j0, j1, ka] = bracket(ALPHA, alphaDeg);
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  return {
    ca: lerp(lerp(CA[i0][j0], CA[i0][j1], ka), lerp(CA[i1][j0], CA[i1][j1], ka), km),
    cn: lerp(lerp(CN[i0][j0], CN[i0][j1], ka), lerp(CN[i1][j0], CN[i1][j1], ka), km),
    cm: lerp(lerp(CM[i0][j0], CM[i0][j1], ka), lerp(CM[i1][j0], CM[i1][j1], ka), km),
  };
}

export function aeroDerivatives(mach: number) {
  const rows = data.derivatives;
  const [i0, i1, k] = bracket(
    rows.map((r) => r.mach),
    mach,
  );
  const lerp = (a: number, b: number) => a + (b - a) * k;
  const a = rows[i0];
  const b = rows[i1];
  return {
    cnDelta: lerp(a.cnDelta, b.cnDelta),
    cmDelta: lerp(a.cmDelta, b.cmDelta),
    cmq: lerp(a.cmq, b.cmq),
    clp: lerp(a.clp, b.clp),
    cnr: lerp(a.cnr, b.cnr),
    clDelta: lerp(a.clDelta, b.clDelta),
  };
}
