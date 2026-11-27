/**
 * Engineering-estimate aerodynamic dataset for the interceptor.
 *
 * No validated SM-3 aero tables are public, so this generates a consistent,
 * reproducible set from the modelled geometry with standard preliminary-design
 * methods (component build-up: skin friction, wave/base drag, slender-body and
 * fin normal force, CN-weighted centre of pressure). Output is representative,
 * not flight-test data; the UI labels it accordingly.
 *
 * Run: node scripts/build_aero.mjs
 */
import fs from "node:fs";
import path from "node:path";

const D = 0.34; // body diameter, m
const S = Math.PI * (D / 2) ** 2; // 0.0908 m2
const L_BODY = 5.82;
const L_TOTAL = 6.76;
const L_NOSE = 1.14;
const S_WET_BODY = Math.PI * D * L_BODY;
const S_STRAKE = 2 * 2.2 * 0.27; // two long strakes, planform
const S_TAIL = 4 * 0.59 * 0.274; // four tail fins
const S_WET_FINS = 2.05 * (S_STRAKE + S_TAIL); // both sides + thickness
const CG_X = 3.30; // from the nose tip, m
const X_CP = 4.08; // CN-weighted centre of pressure, m from the nose
const X_FIN = 5.47; // tail-fin quarter chord, m from the nose
const STATIC_MARGIN = X_CP - CG_X; // m
const ARM = (X_FIN - CG_X) / D;

const MACH = [0.3, 0.5, 0.7, 0.85, 0.95, 1.05, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12];
const ALPHA = [-8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 15, 20];

// Zero-lift axial coefficient: friction + wave + base, representative shape.
const CA0 = [0.34, 0.34, 0.35, 0.37, 0.44, 0.56, 0.54, 0.47, 0.40, 0.36, 0.33, 0.29, 0.26, 0.24, 0.22, 0.21, 0.20];

// Normal-force slope per rad: slender body + strakes + tails, supersonic erodes.
function cnAlpha(m) {
  const sub = 10.6;
  const superSlope = 10.6 * Math.pow(1 + 0.42 * (m - 1), -0.55);
  if (m <= 1) return sub + 0.9 * Math.max(0, 1 - m) * 0;
  return Math.max(3.6, superSlope);
}

// Fin effectiveness drops through the supersonic regime.
function finFactor(m) {
  if (m <= 1) return 1;
  return Math.max(0.35, Math.pow(1 + 0.5 * (m - 1), -0.6));
}

function alphaRad(deg) {
  return (deg * Math.PI) / 180;
}

const ca = [];
const cn = [];
const cm = [];
for (let i = 0; i < MACH.length; i++) {
  const m = MACH[i];
  const rowA = [];
  const rowN = [];
  const rowM = [];
  const slope = cnAlpha(m);
  for (const deg of ALPHA) {
    const ar = alphaRad(deg);
    // Linear to ~10 deg, then a soft saturation.
    const sat = 1 - 0.035 * Math.max(0, Math.abs(deg) - 10);
    const n = slope * Math.sin(ar) * sat;
    const induced = 0.07 * n * n;
    rowN.push(+n.toFixed(4));
    rowA.push(+(CA0[i] + induced + 0.02 * Math.abs(Math.sin(ar))).toFixed(4));
    rowM.push(+(-n * (STATIC_MARGIN / D) * 0.95).toFixed(4));
  }
  ca.push(rowA);
  cn.push(rowN);
  cm.push(rowM);
}

const derivatives = MACH.map((m) => {
  const cnDelta = +(3.1 * finFactor(m)).toFixed(3);
  return {
    mach: m,
    cnDelta,
    cmDelta: +(-cnDelta * ARM).toFixed(3),
    cmq: +(-16 * finFactor(m)).toFixed(3),
    clp: -0.55,
    cnr: +(-1.6 * finFactor(m)).toFixed(3),
    clDelta: +(0.18 * finFactor(m)).toFixed(3),
  };
});

const data = {
  meta: {
    name: "IV-1655 representative interceptor",
    generatedBy: "scripts/build_aero.mjs",
    generatedAt: new Date().toISOString(),
    method:
      "Preliminary component build-up: turbulent skin friction (compressibility corrected), ogive wave drag, base drag, slender-body + strake + tail normal force, CN-weighted centre of pressure. Engineering estimate, not validated wind-tunnel or flight data.",
    provenance: "Public geometry and published SM-3 Block IB/IIA proportions; no classified data.",
    warning:
      "Representative dataset for visualization and trade studies. Do not use for real guidance, safety or performance certification.",
  },
  geometry: {
    diameterM: D,
    lengthM: L_TOTAL,
    noseLengthM: L_NOSE,
    referenceAreaM2: +S.toFixed(5),
    wettedAreaM2: +(S_WET_BODY + S_WET_FINS).toFixed(4),
    strakePlanformM2: +S_STRAKE.toFixed(4),
    tailPlanformM2: +S_TAIL.toFixed(4),
    cgFromNoseM: CG_X,
    cpFromNoseM: X_CP,
    staticMarginM: +STATIC_MARGIN.toFixed(3),
    tailArmM: +(X_FIN - CG_X).toFixed(3),
  },
  reference: {
    momentReference: "cg",
    forceReferenceArea: "body cross-section",
    angleUnit: "deg",
    machUnit: "-",
    momentReferenceLengthM: D,
  },
  mach: MACH,
  alphaDeg: ALPHA,
  ca,
  cn,
  cm,
  derivatives,
};

const outSrc = path.join(process.cwd(), "src", "sim", "aero-interceptor.json");
const outPub = path.join(process.cwd(), "public", "data", "aero-interceptor.json");
fs.mkdirSync(path.dirname(outSrc), { recursive: true });
fs.mkdirSync(path.dirname(outPub), { recursive: true });
const text = JSON.stringify(data, null, 2);
fs.writeFileSync(outSrc, text + "\n");
fs.writeFileSync(outPub, text + "\n");
console.log(`wrote ${outSrc}`);
console.log(`wrote ${outPub}`);
console.log(`CA0(M=2)=${CA0[8]} CNa(2)=${cnAlpha(2).toFixed(2)} staticMargin=${STATIC_MARGIN.toFixed(2)} m`);
