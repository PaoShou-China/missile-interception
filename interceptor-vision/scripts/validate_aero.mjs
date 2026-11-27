/**
 * Structural + physical sanity checks for the generated aero dataset.
 * Run: node scripts/validate_aero.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcPath = path.join(root, "src", "sim", "aero-interceptor.json");
const pubPath = path.join(root, "public", "data", "aero-interceptor.json");
const d = JSON.parse(fs.readFileSync(srcPath, "utf8"));
const pubText = fs.readFileSync(pubPath, "utf8");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
};

const M = d.mach;
const A = d.alphaDeg;
const { ca, cn, cm, derivatives, geometry, reference } = d;

check("public copy is identical", pubText === fs.readFileSync(srcPath, "utf8"), "src/sim vs public/data");

check("mach axis strictly increasing", M.every((m, i) => i === 0 || m > M[i - 1]), `${M.length} points ${M[0]}..${M[M.length - 1]}`);
check("alpha axis strictly increasing", A.every((a, i) => i === 0 || a > A[i - 1]), `${A.length} points ${A[0]}..${A[A.length - 1]}`);
check(
  "table dimensions match axes",
  ca.length === M.length && cn.length === M.length && cm.length === M.length && ca.every((r) => r.length === A.length) && cn.every((r) => r.length === A.length) && cm.every((r) => r.length === A.length),
  `${M.length} x ${A.length}`,
);
const finite = [...ca, ...cn, ...cm].flat().every((v) => Number.isFinite(v));
check("all coefficients finite", finite, "");

const ai = (deg) => A.indexOf(deg);
// Symmetry about alpha = 0.
let symCN = 0;
let symCM = 0;
let symCA = 0;
for (let i = 0; i < M.length; i++) {
  for (const deg of A.filter((a) => a > 0 && A.includes(-a))) {
    const p = ai(deg);
    const n = ai(-deg);
    symCN = Math.max(symCN, Math.abs(cn[i][p] + cn[i][n]));
    symCM = Math.max(symCM, Math.abs(cm[i][p] + cm[i][n]));
    symCA = Math.max(symCA, Math.abs(ca[i][p] - ca[i][n]));
  }
}
check("CN is odd in alpha", symCN < 1e-6, `max |CN(a)+CN(-a)| = ${symCN.toExponential(2)}`);
check("CM is odd in alpha", symCM < 1e-6, `max |CM(a)+CM(-a)| = ${symCM.toExponential(2)}`);
check("CA is even in alpha", symCA < 1e-6, `max |CA(a)-CA(-a)| = ${symCA.toExponential(2)}`);

// CN sign and monotonicity in alpha.
let cnMonotonic = true;
let cnSign = true;
for (let i = 0; i < M.length; i++) {
  for (let j = 1; j < A.length; j++) {
    if (cn[i][j] < cn[i][j - 1] - 1e-9) cnMonotonic = false;
    if (Math.sign(cn[i][j]) !== Math.sign(A[j]) && Math.abs(A[j]) > 0) cnSign = false;
  }
}
check("CN increases with alpha", cnMonotonic, "");
check("CN sign follows alpha", cnSign, "");

const zero = ai(0);
const a10 = ai(10);
const ca0M = (m) => ca[M.indexOf(m)][zero];
check("CA0 stays in a plausible band", ca.every((row) => row[zero] > 0.15 && row[zero] < 0.8), `min ${Math.min(...ca.map((r) => r[zero])).toFixed(3)} max ${Math.max(...ca.map((r) => r[zero])).toFixed(3)}`);
check("transonic CA peak", ca0M(1.05) > ca0M(1.2) * 0.98 && ca0M(1.05) > ca0M(3), `CA0(1.05)=${ca0M(1.05)} CA0(3)=${ca0M(3)}`);
check("supersonic CA decays", ca0M(3) < ca0M(1.5) && ca0M(10) < ca0M(3), `CA0(1.5)=${ca0M(1.5)} CA0(3)=${ca0M(3)} CA0(10)=${ca0M(10)}`);
check("CA at 10 deg in band", ca.every((row) => row[a10] > 0.2 && row[a10] < 1.0), `min ${Math.min(...ca.map((r) => r[a10])).toFixed(3)} max ${Math.max(...ca.map((r) => r[a10])).toFixed(3)}`);

// CN alpha slope at M=2.
const i2 = M.indexOf(2);
const slope2 = cn[i2][a10] / (10 * Math.PI / 180);
check("CNa(M=2) in 6..12 /rad", slope2 > 6 && slope2 < 12, `${slope2.toFixed(2)} /rad`);

// Static stability.
const cmAll = cm.flat().filter((_, i) => A[i % A.length] > 0);
check("CM negative for alpha>0", cm.every((row) => row.every((v, j) => A[j] <= 0 || v < 0)), "");
check("CM magnitude bounded", cm.every((row) => row.every((v) => Math.abs(v) < 8)), `max |CM| = ${Math.max(...cm.flat().map(Math.abs)).toFixed(2)}`);
check("static margin positive", geometry.cpFromNoseM > geometry.cgFromNoseM, `${geometry.staticMarginM} m`);

// Derivative signs and magnitudes.
check("CNdelta > 0", derivatives.every((r) => r.cnDelta > 0), "");
check("CMdelta < 0", derivatives.every((r) => r.cmDelta < 0), "");
check("Cmq < 0", derivatives.every((r) => r.cmq < 0), "");
check("Clp < 0", derivatives.every((r) => r.clp < 0), "");
check("Cnr < 0", derivatives.every((r) => r.cnr < 0), "");

// Continuity between neighbouring Mach rows (no tabulation glitches).
let maxJumpCA = 0;
let maxJumpCN = 0;
for (let i = 1; i < M.length; i++) {
  for (let j = 0; j < A.length; j++) {
    const dM = M[i] - M[i - 1] || 1;
    maxJumpCA = Math.max(maxJumpCA, Math.abs(ca[i][j] - ca[i - 1][j]) / dM);
    maxJumpCN = Math.max(maxJumpCN, Math.abs(cn[i][j] - cn[i - 1][j]) / dM);
  }
}
check("CA slope bounded outside the transonic band", maxJumpCA < 1.6, `max dCA/dM=${maxJumpCA.toFixed(3)}`);
check("CN slope bounded across Mach", maxJumpCN < 1.2, `max dCN/dM=${maxJumpCN.toFixed(3)}`);

// Independent friction estimate at M=0.5, sea-level-ish Re.
const Swet = geometry.wettedAreaM2;
const Sref = geometry.referenceAreaM2;
const Re = 8e6;
const cf = 0.074 / Math.pow(Re, 0.2);
const caFriction = (cf * Swet) / Sref;
check("friction estimate consistent with CA0(M=0.5)", Math.abs(caFriction - ca[M.indexOf(0.5)][zero]) < 0.25, `Cf-based ${caFriction.toFixed(3)} vs table ${ca[M.indexOf(0.5)][zero].toFixed(3)}`);

check("reference area matches diameter", Math.abs(Sref - Math.PI * (geometry.diameterM / 2) ** 2) < 1e-4, `${Sref} m2`);
check("moment reference length = diameter", reference.momentReferenceLengthM === geometry.diameterM, `${reference.momentReferenceLengthM} m`);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

console.log("\nRepresentative coefficients");
const pad = (v) => v.toFixed(3).padStart(7);
console.log("  M     CA0    CA10    CN10    CM10   CNa/rad");
for (const m of [0.3, 0.85, 1.05, 1.5, 2, 3, 5, 8, 12]) {
  const i = M.indexOf(m);
  console.log(`  ${String(m).padStart(4)} ${pad(ca[i][zero])} ${pad(ca[i][a10])} ${pad(cn[i][a10])} ${pad(cm[i][a10])} ${(cn[i][a10] / (10 * Math.PI / 180)).toFixed(2).padStart(7)}`);
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exitCode = 1;
}
