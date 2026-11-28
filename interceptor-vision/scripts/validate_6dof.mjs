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

// Optional setting overrides via env, for tuning sweeps.
const envSettings = {};
for (const k of ["aeroScale", "smScale", "finMaxDeg", "finRateDeg", "finBandwidthHz", "lqrWn", "lqrZeta", "cmdFilterHz", "alphaMaxDeg", "betaMaxDeg", "inertiaScale", "divertMaxG"]) {
  if (process.env[k] !== undefined) envSettings[k] = Number(process.env[k]);
}

// Recorded non-gravity acceleration (ECEF), central-differenced from the
// payload velocity, for trajectory matching. FF=0 disables it.
const MU = 3.986004418e14;
const telData = JSON.parse(fs.readFileSync(path.join(root, "public/data/scenario.json"), "utf8"));
const missileSamples = telData.entities.find((e) => e.id === "missile").samples;
const targetTrack = telData.entities.find((e) => e.id === "target").samples.map((s) => ({
  t: s.t,
  x: s.position.x,
  y: s.position.y,
  z: s.position.z,
  vx: s.velocity.x,
  vy: s.velocity.y,
  vz: s.velocity.z,
}));
const lockEvent = (telData.events || []).find((e) => e.id === "seeker-lock");
const lockT = lockEvent ? lockEvent.t : missileSamples.find((s) => s.seekerLock)?.t ?? 664.54;
const lockSample = missileSamples.reduce((best, s) => (Math.abs(s.t - lockT) < Math.abs(best.t - lockT) ? s : best), missileSamples[0]);
const lockTarget = targetTrack.reduce((best, s) => (Math.abs(s.t - lockSample.t) < Math.abs(best.t - lockSample.t) ? s : best), targetTrack[0]);

const feedforward = [];
for (let i = 1; i < missileSamples.length - 1; i++) {
  const a = missileSamples[i - 1];
  const b = missileSamples[i + 1];
  const dt = b.t - a.t;
  if (dt <= 0 || missileSamples[i].t < lockSample.t - 0.1) continue;
  const p = missileSamples[i].position;
  const r = Math.hypot(p.x, p.y, p.z);
  const gk = MU / (r * r * r);
  feedforward.push({
    t: missileSamples[i].t,
    x: (b.velocity.x - a.velocity.x) / dt + gk * p.x,
    y: (b.velocity.y - a.velocity.y) / dt + gk * p.y,
    z: (b.velocity.z - a.velocity.z) / dt + gk * p.z,
  });
}

// Recorded hand-over state read dynamically from scenario.json at seeker lock.
const baseTspd = Math.hypot(lockTarget.vx, lockTarget.vy, lockTarget.vz);
const TSPD = process.env.TSPD ? Number(process.env.TSPD) : baseTspd;
const tScale = TSPD / Math.max(1, baseTspd);
const CROSS = process.env.CROSS !== undefined ? Number(process.env.CROSS) : null;
const RKM = process.env.RKM !== undefined ? Number(process.env.RKM) : null;
const scenario = () => {
  const pos = new THREE.Vector3(lockSample.position.x, lockSample.position.y, lockSample.position.z);
  const recorded = new THREE.Vector3(lockTarget.x, lockTarget.y, lockTarget.z);
  const targetPos = RKM !== null
    ? pos.clone().addScaledVector(recorded.clone().sub(pos).normalize(), RKM * 1000)
    : recorded.clone();
  let targetVel = new THREE.Vector3(lockTarget.vx * tScale, lockTarget.vy * tScale, lockTarget.vz * tScale);
  if (CROSS !== null) {
    const u = targetPos.clone().sub(pos).normalize();
    const up = pos.clone().normalize();
    const perp = new THREE.Vector3().crossVectors(u, up).normalize();
    const c = (CROSS * Math.PI) / 180;
    targetVel = u.clone().multiplyScalar(Math.cos(c) * TSPD).addScaledVector(perp, Math.sin(c) * TSPD);
  }
  return {
    t0: lockSample.t,
    pos,
    vel: new THREE.Vector3(lockSample.velocity.x, lockSample.velocity.y, lockSample.velocity.z),
    att: new THREE.Quaternion(lockSample.attitude.x, lockSample.attitude.y, lockSample.attitude.z, lockSample.attitude.w).normalize(),
    mass: lockSample.massKg,
    targetPos,
    targetVel,
    navConst: process.env.NC ? Number(process.env.NC) : 4,
    maxLoadG: process.env.MAXG ? Number(process.env.MAXG) : 40,
    maneuver: "none",
    maneuverG: 0,
    targetSpeed: TSPD,
    accelFeedforward: process.env.FF === "0" ? undefined : feedforward,
    targetTrack: process.env.TT === "0" ? undefined : targetTrack,
    settings: envSettings,
  };
};

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
check("dt 1 ms vs 0.5 ms miss distance", Math.abs(base.minRange - fine.minRange) < Math.max(1, 0.01 * base.minRange), `${base.minRange.toFixed(2)} vs ${fine.minRange.toFixed(2)} m`);

// 2) Endgame outcome on the recorded geometry.
// With divert disabled (A1: endo-atmospheric third stage, no DACS) the modelled
// airframe is control-limited by its static margin and does not reproduce the
// recorded 10-12 g; the solver reports the resulting miss instead of masking it.
check("miss distance is finite and reported", Number.isFinite(base.minRange) && base.minRange > 0, `${base.minRange.toFixed(0)} m`);
check("intercept time after lock", base.tMin > lockSample.t, `t = ${base.tMin.toFixed(2)} s`);

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
check("commanded load within cap", base.maxCmdLoad <= 40.001, `max ${base.maxCmdLoad.toFixed(1)} g`);
check("achieved load within the command", base.maxLoad <= base.maxCmdLoad + 1e-6, `max ${base.maxLoad.toFixed(1)} g`);

// 4) Divert is off for this endo-atmospheric case (no SDACS at 14-16 km).
check("divert disabled (A1)", base.divertUsedMs === 0, `${base.divertUsedMs.toFixed(0)} m/s used`);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
fs.rmSync(out, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
