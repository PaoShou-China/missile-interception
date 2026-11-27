import * as THREE from "three";
import type { PhaseSegment, Sample, Telemetry } from "../data/telemetry";
import { aeroAt, AERO_REF } from "./aero";

/**
 * Terminal-phase engagement solver.
 *
 * The validated payload stops being authoritative once the user starts moving
 * the target, so this module re-solves the last leg (seeker lock -> closest
 * approach) with a representative model:
 *
 *  - translation: thrust + quadratic drag + spherical gravity + proportional
 *    navigation, with an acceleration cap (max load) and a simple aero limit;
 *  - attitude: body axes are steered towards the velocity vector with a finite
 *    turn rate and a bank angle derived from the commanded lateral load, then
 *    integrated as a BODY->ECEF quaternion (NED body, matching the payload);
 *  - target: constant speed with optional constant-turn or weave manoeuvre.
 *
 * No validated aero tables exist for this airframe, so the coefficients are
 * representative rather than ident. The UI labels the result as a solve, not
 * as recorded telemetry.
 */
export interface SimParams {
  /** Slant range to the target at the hand-over instant, km. */
  rangeKm: number;
  /** Bearing of the target from the missile, deg from north. */
  bearingDeg: number;
  /** Target altitude, km. */
  altKm: number;
  /** Target speed, m/s. */
  speedMS: number;
  /** Target heading relative to the line of sight, deg (90 = crossing). */
  headingDeg: number;
  maneuver: "none" | "turn" | "weave";
  maneuverG: number;
  navConst: number;
  maxLoadG: number;
  lockRangeKm: number;
}

const R_EARTH = 6_371_000;
const MU = 3.986_004_418e14;
const RHO0 = 1.225;
const H_SCALE = 8_500;
const S_REF = AERO_REF.referenceAreaM2;
const SUSTAIN_N = 4_000;
const SLOT = 0.05;

const latRad = (d: number) => (d * Math.PI) / 180;

function ecefToLla(v: THREE.Vector3) {
  const r = v.length() || 1;
  const latDeg = (Math.asin(Math.max(-1, Math.min(1, v.z / r))) * 180) / Math.PI;
  const lonDeg = (Math.atan2(v.y, v.x) * 180) / Math.PI;
  return { latDeg, lonDeg, altM: r - R_EARTH };
}

function enuBasis(latDeg: number, lonDeg: number) {
  const lat = latRad(latDeg);
  const lon = latRad(lonDeg);
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return {
    e: new THREE.Vector3(-so, co, 0),
    n: new THREE.Vector3(-sl * co, -sl * so, cl),
    u: new THREE.Vector3(cl * co, cl * so, sl),
  };
}

function atmosphere(altM: number) {
  const rho = RHO0 * Math.exp(-Math.max(0, altM) / H_SCALE);
  const speedOfSound = Math.max(295, 340.3 - 0.0041 * Math.min(altM, 20_000));
  return { rho, speedOfSound };
}

function nearestTargetSample(samples: Sample[], t: number) {
  if (!samples.length) return null;
  let best = samples[0];
  let bestD = Math.abs(best.t - t);
  for (const s of samples) {
    const d = Math.abs(s.t - t);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

function nearestSample(samples: Sample[], t: number) {
  if (!samples.length) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(samples[lo].t - t) <= Math.abs(samples[hi].t - t) ? samples[lo] : samples[hi];
}

/** Defaults derived from the recorded hand-over state. */
export function defaultSimParams(base: Telemetry | null): SimParams {
  const fallback: SimParams = {
    rangeKm: 25,
    bearingDeg: 0,
    altKm: 14,
    speedMS: 900,
    headingDeg: 90,
    maneuver: "none",
    maneuverG: 0,
    navConst: 4,
    maxLoadG: 40,
    lockRangeKm: 25,
  };
  if (!base) return fallback;
  const lock = base.events.find((e) => e.kind === "lock");
  const t = lock?.t ?? base.end * 0.94;
  const m = nearestSample(base.samples, t);
  const tg = nearestTargetSample(base.targetSamples, t);
  if (!m || !tg) return fallback;
  const mPos = new THREE.Vector3(m.position.x, m.position.y, m.position.z);
  const tPos = new THREE.Vector3(tg.position.x, tg.position.y, tg.position.z);
  const rel = tPos.clone().sub(mPos);
  const { e, n } = enuBasis(m.latDeg, m.lonDeg);
  const rangeKm = rel.length() / 1000;
  const bearing = (Math.atan2(rel.dot(e), rel.dot(n)) * 180) / Math.PI;
  const vEast = tg.velocity.x * e.x + tg.velocity.y * e.y + tg.velocity.z * e.z;
  const vNorth = tg.velocity.x * n.x + tg.velocity.y * n.y + tg.velocity.z * n.z;
  const heading = (Math.atan2(vEast, vNorth) * 180) / Math.PI - bearing;
  return {
    ...fallback,
    rangeKm: +rangeKm.toFixed(1),
    bearingDeg: +bearing.toFixed(1),
    altKm: +(tg.altM / 1000).toFixed(1),
    speedMS: +Math.hypot(tg.velocity.x, tg.velocity.y, tg.velocity.z).toFixed(0),
    headingDeg: +(((heading + 540) % 360) - 180).toFixed(0),
    lockRangeKm: Math.max(5, Math.round(rangeKm / 5) * 5),
  };
}

interface SolverSample {
  t: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  att: THREE.Quaternion;
  mass: number;
  loadG: number;
  fovDeg: number;
  range: number;
  locked: boolean;
}

/** Re-solves the terminal leg and returns a merged telemetry object. */
export function solveTerminal(base: Telemetry, p: SimParams): Telemetry {
  const lock = base.events.find((e) => e.kind === "lock");
  const t0 = lock?.t ?? base.end * 0.94;
  const m0 = nearestSample(base.samples, t0);
  if (!m0) return base;

  const pos = new THREE.Vector3(m0.position.x, m0.position.y, m0.position.z);
  const vel = new THREE.Vector3(m0.velocity.x, m0.velocity.y, m0.velocity.z);
  const lat0 = m0.latDeg;
  const lon0 = m0.lonDeg;
  const basis = enuBasis(lat0, lon0);
  const bearing = latRad(p.bearingDeg);

  // Target starts on the requested bearing/range/altitude.
  const targetPos = pos
    .clone()
    .addScaledVector(basis.e, Math.sin(bearing) * p.rangeKm * 1000)
    .addScaledVector(basis.n, Math.cos(bearing) * p.rangeKm * 1000)
    .addScaledVector(basis.u, p.altKm * 1000 - m0.altM);

  const targetHeading = bearing + latRad(p.headingDeg);
  const targetVel = new THREE.Vector3()
    .addScaledVector(basis.e, Math.sin(targetHeading) * p.speedMS)
    .addScaledVector(basis.n, Math.cos(targetHeading) * p.speedMS);

  // Missile attitude: nose along the velocity, wings level about the local up.
  let nose = vel.clone().normalize();
  if (nose.lengthSq() < 0.5) nose.copy(basis.n);
  let mass = m0.massKg;
  const att = new THREE.Quaternion();

  const out: SolverSample[] = [];
  const targetOut: { t: number; pos: THREE.Vector3; vel: THREE.Vector3 }[] = [];
  const dt = 0.01;
  const tEnd = t0 + 90;
  let t = t0;
  let minRange = Infinity;
  let tMin = t0;
  let maxLoad = 0;

  const rRel = new THREE.Vector3();
  const vRel = new THREE.Vector3();
  const omega = new THREE.Vector3();
  const uLos = new THREE.Vector3();
  const accel = new THREE.Vector3();
  const grav = new THREE.Vector3();
  const drag = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const down = new THREE.Vector3();
  const body = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const qRate = new THREE.Quaternion();
  let weaveSign = 1;
  let lastWeave = t0;

  let nextOut = t0;

  while (t < tEnd) {
    rRel.copy(targetPos).sub(pos);
    vRel.copy(targetVel).sub(vel);
    const range = Math.max(1, rRel.length());
    const closing = Math.max(0, -rRel.dot(vRel) / range);
    uLos.copy(rRel).divideScalar(range);
    omega.crossVectors(rRel, vRel).divideScalar(range * range);

    // Proportional navigation. The structural/divert limit caps the command;
    // the aero table supplies drag at the implied angle of attack (an exo-
    // atmospheric kill vehicle manoeuvres with divert thrusters, not fins, so
    // aerodynamic lift is not the binding constraint here).
    accel.crossVectors(omega, uLos).multiplyScalar(p.navConst * closing);
    const altM = pos.length() - R_EARTH;
    const atm = atmosphere(altM);
    const speed = vel.length();
    const qbar = 0.5 * atm.rho * speed * speed;
    const mach = speed / atm.speedOfSound;
    const cap = p.maxLoadG * 9.81;
    if (accel.length() > cap) accel.setLength(cap);
    const loadG = accel.length() / 9.81;
    // Angle of attack needed for the command, then drag from the table.
    const cnSlope = Math.max(1.4, aeroAt(mach, 5).cn / Math.sin((5 * Math.PI) / 180));
    const alphaDeg =
      qbar > 1
        ? THREE.MathUtils.clamp(((accel.length() * mass) / (qbar * S_REF * cnSlope)) * (180 / Math.PI), 0, 18)
        : 0;
    const ca = aeroAt(mach, alphaDeg).ca;

    // Spherical gravity, drag and the sustainer.
    grav.copy(pos).normalize().multiplyScalar(-MU / pos.lengthSq());
    drag
      .copy(vel)
      .normalize()
      .multiplyScalar((-qbar * ca * S_REF) / Math.max(1, mass));
    const thrust = SUSTAIN_N / Math.max(1, mass);
    tmp.copy(nose).multiplyScalar(thrust);

    tmp.add(accel).add(grav).add(drag);
    vel.addScaledVector(tmp, dt);
    pos.addScaledVector(vel, dt);
    mass = Math.max(900, mass - 0.0045 * dt * 1000);

    // --- target kinematics -------------------------------------------------
    if (p.maneuver === "turn" && p.maneuverG > 0.05) {
      up.copy(targetPos).normalize();
      right.crossVectors(targetVel, up).normalize();
      if (right.lengthSq() < 0.1) right.set(1, 0, 0);
      targetVel.addScaledVector(right, p.maneuverG * 9.81 * dt);
      targetVel.setLength(p.speedMS);
    } else if (p.maneuver === "weave" && p.maneuverG > 0.05) {
      if (t - lastWeave > 2) {
        weaveSign = -weaveSign;
        lastWeave = t;
      }
      up.copy(targetPos).normalize();
      right.crossVectors(targetVel, up).normalize();
      targetVel.addScaledVector(right, weaveSign * p.maneuverG * 9.81 * dt);
      targetVel.setLength(p.speedMS);
    }
    targetPos.addScaledVector(targetVel, dt);

    // --- attitude ----------------------------------------------------------
    up.copy(pos).normalize();
    // Nose leads the velocity by the commanded load (visual angle of attack).
    const lead = Math.min(0.35, loadG * 0.012);
    const desired = tmp.copy(vel).normalize().addScaledVector(up, lead).normalize();
    const maxTurn = 0.7 * dt; // ~40 deg/s
    const angle = nose.angleTo(desired);
    if (angle > 1e-5) {
      qRate.setFromUnitVectors(nose, desired);
      const n = THREE.MathUtils.clamp(maxTurn / angle, 0, 1);
      nose.applyQuaternion(new THREE.Quaternion().slerp(qRate, n)).normalize();
    }
    right.crossVectors(nose, up).normalize();
    down.crossVectors(nose, right).normalize();
    // Bank into the turn: project the command onto the lift axis.
    const bank = THREE.MathUtils.clamp(accel.dot(right) / 9.81, -1.1, 1.1);
    body.makeBasis(nose, right, down);
    body.multiply(new THREE.Matrix4().makeRotationX(bank * 0.6));
    att.setFromRotationMatrix(body);

    // --- sampling ----------------------------------------------------------
    if (t >= nextOut - 1e-9) {
      out.push({
        t,
        pos: pos.clone(),
        vel: vel.clone(),
        att: att.clone(),
        mass,
        loadG,
        fovDeg: Math.min(90, (Math.acos(Math.max(-1, Math.min(1, uLos.dot(nose)))) * 180) / Math.PI),
        range,
        locked: range <= p.lockRangeKm * 1000,
      });
      nextOut += SLOT;
      targetOut.push({ t, pos: targetPos.clone(), vel: targetVel.clone() });
    }
    if (range < minRange) {
      minRange = range;
      tMin = t;
    }
    maxLoad = Math.max(maxLoad, loadG);

    // Stop shortly after closest approach.
    if (range > minRange + 30 && t > tMin + 0.2) break;
    if (pos.length() - R_EARTH < 0) break;
    t += dt;
  }

  if (!out.length) return base;

  const solveEnd = out[out.length - 1].t;

  // Merge prefix (recorded) + suffix (solved).
  const prefix = base.samples.filter((s) => s.t <= t0 + 1e-6);
  const solvedSamples: Sample[] = out.map((s) => {
    const lla = ecefToLla(s.pos);
    const speed = s.vel.length();
    const { rho, speedOfSound } = atmosphere(lla.altM);
    const q = 0.5 * rho * speed * speed;
    return {
      t: s.t,
      position: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      velocity: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
      attitude: { w: s.att.w, x: s.att.x, y: s.att.y, z: s.att.z },
      latDeg: lla.latDeg,
      lonDeg: lla.lonDeg,
      altM: lla.altM,
      speedMS: speed,
      mach: speed / speedOfSound,
      qPa: q,
      loadG: s.loadG,
      loadCmdG: s.loadG * 0.85,
      massKg: s.mass,
      fovDeg: s.fovDeg,
      rangeM: s.range,
      phase: "terminal",
      seekerLock: s.locked,
      handover: true,
      finDeflectionsRad: {
        up: Math.sin(s.loadG * 0.4) * 0.09,
        down: Math.sin(s.loadG * 0.4) * 0.09,
        left: Math.cos(s.loadG * 0.3) * 0.07,
        right: Math.cos(s.loadG * 0.3) * 0.07,
      },
      bodyRatesRadS: { p: 0.05, q: 0.02, r: -0.03 },
      attitudeAliased: false,
    };
  });

  // Target samples over the same window.
  const targetPrefix = base.targetSamples.filter((s) => s.t <= t0 + 1e-6);
  const targetSuffix: Sample[] = [];
  {
    let next = t0;
    let cursor = 0;
    for (const s of targetOut) {
      if (s.t < next - 1e-9) continue;
      next += 0.45;
      cursor = Math.min(cursor, solvedSamples.length - 1);
      const lla = ecefToLla(s.pos);
      const speed = s.vel.length();
      const { rho } = atmosphere(lla.altM);
      targetSuffix.push({
        ...solvedSamples[Math.min(cursor, solvedSamples.length - 1)],
        t: s.t,
        position: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
        velocity: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
        latDeg: lla.latDeg,
        lonDeg: lla.lonDeg,
        altM: lla.altM,
        speedMS: speed,
        mach: speed / 300,
        qPa: 0.5 * rho * speed * speed,
        rangeM: 0,
        attitude: { w: 1, x: 0, y: 0, z: 0 },
        loadG: 0,
        phase: "coast",
        seekerLock: false,
        handover: false,
      });
    }
  }

  const phases: PhaseSegment[] = [
    ...base.phases.filter((s) => s.endT <= t0 + 0.01),
    { phase: "terminal", startT: t0, endT: solveEnd, label: "Terminal" },
  ];

  const events = base.events.filter((e) => e.t <= t0 + 0.01 && e.kind !== "intercept");
  events.push({
    id: "intercept",
    t: tMin,
    label: "INTERCEPT",
    description: "Closest approach of the re-solved terminal engagement.",
    kind: "intercept",
    severity: "major",
  });
  events.sort((a, b) => a.t - b.t);

  const maxAlt = Math.max(...solvedSamples.map((s) => s.altM), base.metrics.maxAltitudeM ?? 0);
  const maxSpeed = Math.max(...solvedSamples.map((s) => s.speedMS), base.metrics.maxSpeedMS ?? 0);
  const last = solvedSamples[solvedSamples.length - 1];
  const first = base.samples[0];
  const downrangeKm =
    (Math.acos(
      Math.min(
        1,
        Math.max(
          -1,
          Math.sin(latRad(first.latDeg)) * Math.sin(latRad(last.latDeg)) +
            Math.cos(latRad(first.latDeg)) * Math.cos(latRad(last.latDeg)) *
              Math.cos(latRad(last.lonDeg - first.lonDeg)),
        ),
      ),
    ) *
      R_EARTH) /
    1000;

  const tel: Telemetry = {
    ...base,
    end: solveEnd,
    samples: [...prefix, ...solvedSamples],
    targetSamples: [...targetPrefix, ...targetSuffix],
    events,
    phases,
    metrics: {
      ...base.metrics,
      missDistanceM: +minRange.toFixed(2),
      interceptTimeS: +tMin.toFixed(2),
      maxAltitudeM: +maxAlt.toFixed(1),
      maxSpeedMS: +maxSpeed.toFixed(1),
      maxLoadG: +maxLoad.toFixed(2),
      downrangeKM: +downrangeKm.toFixed(1),
      flightDurationS: +solveEnd.toFixed(2),
      handoverTimeS: +t0.toFixed(2),
    },
    title: `${base.title} · 解算`,
  };
  return tel;
}
