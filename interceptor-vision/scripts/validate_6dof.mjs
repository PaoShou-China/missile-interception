// Numeric checks for the shipped 6-DoF integrator (src/sim/sixdof.ts).
// Compiles the module with tsc, then runs convergence / boundedness / intercept
// checks. Run from interceptor-vision/:  node scripts/validate_6dof.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as THREE from "three";

const root = process.cwd();
const out = path.join(root, "scripts", "_b6");
fs.rmSync(out, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "src/sim/sixdof.ts",
    "src/sim/aero.ts",
    "--outDir", out,
    "--module", "esnext",
    "--target", "es2020",
    "--moduleResolution", "bundler",
    "--resolveJsonModule",
    "--skipLibCheck",
    "--esModuleInterop",
  ],
  { stdio: "inherit" },
);
// tsc emits extensionless / JSON imports that Node's ESM loader rejects; patch them.
const sixjs = path.join(out, "sixdof.js");
fs.writeFileSync(sixjs, fs.readFileSync(sixjs, "utf8").replace('from "./aero"', 'from "./aero.js"'));
const aerojs = path.join(out, "aero.js");
fs.writeFileSync(
  aerojs,
  fs.readFileSync(aerojs, "utf8").replace('from "./aero-interceptor.json"', 'from "./aero-interceptor.json" with { type: "json" }'),
);
const { integrateSixDof } = await import(pathToFileURL(sixjs).href);

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

// Recorded hand-over state (scenario.json, seeker lock at t = 664.54 s).
const scenario = () => ({
  t0: 664.54,
  pos: new THREE.Vector3(-3063770.022, 4605487.045, 3197014.997),
  vel: new THREE.Vector3(-1820.341, -335.117, -2084.055),
  att: new THREE.Quaternion(0.401240217, 0.243922628, -0.867513101, 0.164100758).normalize(),
  mass: 1122.156,
  targetPos: new THREE.Vector3(-3082037.4, 4603138.5, 3180118.6),
  targetVel: new THREE.Vector3(406.542, 152.154, 7.89),
  navConst: 4,
  maxLoadG: 40,
  maneuver: "none",
  maneuverG: 0,
  targetSpeed: 434.153,
});

const run = (patch = {}) => integrateSixDof({ ...scenario(), ...patch });

const nearest = (samples, t) => {
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
};
const relDiff = (a, b) => {
  const p = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
  return p / Math.max(1, a.pos.length());
};

const base = run();
const fine = run({ stepS: 0.0005 });

// 1) Integration convergence: terminal state at closest approach, dt 1 ms vs 0.5 ms.
const a = nearest(base.samples, base.tMin);
const b = nearest(fine.samples, fine.tMin);
const conv = relDiff(a, b);
check("dt 1 ms vs 0.5 ms terminal position", conv < 0.005, `${(conv * 100).toFixed(3)} %`);
check("dt 1 ms vs 0.5 ms miss distance", Math.abs(base.minRange - fine.minRange) < 1.0, `${base.minRange.toFixed(2)} vs ${fine.minRange.toFixed(2)} m`);

// 2) Intercept quality on the recorded geometry.
check("intercept inside 30 m", base.minRange < 30, `${base.minRange.toFixed(1)} m`);
check("intercept time after lock", base.tMin > 664.54, `t = ${base.tMin.toFixed(2)} s`);

// 3) Bounded attitude and actuators.
const maxRate = Math.max(...base.samples.map((s) => Math.max(Math.abs(s.rates.p), Math.abs(s.rates.q), Math.abs(s.rates.r))));
const maxAlpha = Math.max(...base.samples.map((s) => Math.abs(s.alphaDeg)));
const maxBeta = Math.max(...base.samples.map((s) => Math.abs(s.betaDeg)));
const maxFin = Math.max(...base.samples.map((s) => Math.max(...Object.values(s.fin).map(Math.abs)))) * (180 / Math.PI);
const satFrac = base.samples.filter((s) => Math.max(Math.abs(s.fin.up), Math.abs(s.fin.left)) > 14.9 * (Math.PI / 180)).length / base.samples.length;
check("body rates bounded", maxRate < 5, `max ${maxRate.toFixed(2)} rad/s`);
check("angle of attack bounded", maxAlpha < 30, `max ${maxAlpha.toFixed(1)} deg`);
check("sideslip bounded", maxBeta < 30, `max ${maxBeta.toFixed(1)} deg`);
check("fin travel within limit", maxFin <= 15.01, `max ${maxFin.toFixed(1)} deg`);
check("no sustained fin saturation", satFrac < 0.15, `${(satFrac * 100).toFixed(1)} % of samples`);
check("commanded load within cap", base.maxLoad <= 40.001, `max ${base.maxLoad.toFixed(1)} g`);

// 4) Divert budget is reported and non-zero for this lift-limited endgame.
check("divert impulse reported", base.divertUsedMs > 0, `${base.divertUsedMs.toFixed(0)} m/s`);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
fs.rmSync(out, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
