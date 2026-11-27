import * as THREE from "three";
import { aeroAt, aeroDerivatives, AERO_REF } from "./aero";

/**
 * Rigid-body (6-DoF) terminal integrator:
 *  - translation from body-axis aero forces + thrust + spherical gravity;
 *  - rotation from Euler's equations with aero moments (static + damping) and
 *    fin control moments;
 *  - fin servos with first-order lag, rate limit and travel limit;
 *  - skid-to-turn autopilot: AoA/sideslip are allocated to the fins up to their
 *    trim limit (set by the static margin) and the rest of the PN command goes
 *    to the DACS divert thrusters, with a finite impulse budget.
 *
 * Pitch and yaw moments are treated symmetrically: the static terms use the
 * tabulated moment (Cm) curve and the fin moments use |Cm_delta|. The table's
 * Cn_delta is a fin normal-force derivative, not a yawing moment, so it is not
 * used for the yaw moment. Hinge moments and servo backlash are not modelled
 * (see docs/6DOF-PARAMETERS.md).
 */
const R_EARTH = 6_371_000;
const MU = 3.986_004_418e14;
const RHO0 = 1.225;
const H_SCALE = 8_500;
const DEG = Math.PI / 180;

export interface SixDofSettings {
  /** Fin travel limit, deg. */
  finMaxDeg: number;
  /** Fin no-load rate, deg/s. */
  finRateDeg: number;
  /** Servo bandwidth, Hz (first-order). */
  finBandwidthHz: number;
  /** Autopilot attitude gain, 1/s. */
  attGain: number;
  /** Rate-loop gain, rad of fin per rad/s of rate error. */
  rateGain: number;
  /** Moment of inertia scale (1 = uniform slender body estimate). */
  inertiaScale: number;
  /** DACS divert limit, g (0 disables the thrusters, aero only). */
  divertMaxG: number;
  /** Usable divert impulse budget, m/s (0 = unlimited). */
  divertBudgetMs: number;
}

export const SIXDOF_DEFAULTS: SixDofSettings = {
  finMaxDeg: 15,
  finRateDeg: 200,
  finBandwidthHz: 10,
  attGain: 3.5,
  rateGain: 0.5,
  inertiaScale: 1,
  divertMaxG: 30,
  divertBudgetMs: 0,
};

export interface SixSample {
  t: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  att: THREE.Quaternion;
  mass: number;
  loadG: number;
  alphaDeg: number;
  betaDeg: number;
  fovDeg: number;
  fin: { up: number; down: number; left: number; right: number };
  rates: { p: number; q: number; r: number };
  divertG: number;
  range: number;
  locked: boolean;
}

export interface SixResult {
  samples: SixSample[];
  targets: { t: number; pos: THREE.Vector3; vel: THREE.Vector3 }[];
  minRange: number;
  tMin: number;
  maxLoad: number;
  divertUsedMs: number;
}

function atmosphere(altM: number) {
  const rho = RHO0 * Math.exp(-Math.max(0, altM) / H_SCALE);
  const a = Math.max(295, 340.3 - 0.0041 * Math.min(altM, 20_000));
  return { rho, a };
}

export function integrateSixDof(args: {
  t0: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  att: THREE.Quaternion;
  mass: number;
  targetPos: THREE.Vector3;
  targetVel: THREE.Vector3;
  navConst: number;
  maxLoadG: number;
  maneuver: "none" | "turn" | "weave";
  maneuverG: number;
  targetSpeed: number;
  /** Integration step, s (default 1 ms; use 0.5 ms for the convergence check). */
  stepS?: number;
  settings?: Partial<SixDofSettings>;
}): SixResult {
  const s: SixDofSettings = { ...SIXDOF_DEFAULTS, ...args.settings };
  const finMax = s.finMaxDeg * DEG;
  const rateMax = s.finRateDeg * DEG;
  const tau = 1 / (2 * Math.PI * s.finBandwidthHz);

  const mass = Math.max(300, args.mass);
  const R = AERO_REF.diameterM / 2;
  const L = AERO_REF.lengthM;
  const S = AERO_REF.referenceAreaM2;
  const d = AERO_REF.diameterM;
  const Ixx = 0.5 * mass * R * R * 1.2 * s.inertiaScale;
  const Iyy = ((mass * (L * L) / 12) * 0.9 + mass * R * R * 0.25) * s.inertiaScale;
  const inertia = new THREE.Vector3(Ixx, Iyy, Iyy);

  const pos = args.pos.clone();
  const vel = args.vel.clone();
  const q = args.att.clone().normalize();
  const w = new THREE.Vector3(); // body rates, rad/s
  const targetPos = args.targetPos.clone();
  const targetVel = args.targetVel.clone();

  const samples: SixSample[] = [];
  const targets: { t: number; pos: THREE.Vector3; vel: THREE.Vector3 }[] = [];
  const dt = args.stepS ?? 0.001;
  const outEvery = 0.05;
  let nextOut = args.t0 + outEvery;
  let t = args.t0;
  const tEnd = args.t0 + 90;
  let minRange = Infinity;
  let tMin = args.t0;
  let maxLoad = 0;
  let fin = { p: 0, y: 0, r: 0 };
  let weaveSign = 1;
  let lastWeave = args.t0;

  const finMaxRad = finMax;
  const ctrl = (err: number, gain: number) => THREE.MathUtils.clamp(err * gain, -finMaxRad, finMaxRad);

  const rRel = new THREE.Vector3();
  const vRel = new THREE.Vector3();
  const omega = new THREE.Vector3();
  const uLos = new THREE.Vector3();
  const aCmd = new THREE.Vector3();
  const upE = new THREE.Vector3();
  const zBody = new THREE.Vector3();
  const aB = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const qInv = new THREE.Quaternion();
  const Fb = new THREE.Vector3();
  const Fe = new THREE.Vector3();
  const M = new THREE.Vector3();
  const Iw = new THREE.Vector3();
  const gyro = new THREE.Vector3();
  const finCmd = { p: 0, y: 0, r: 0 };
  const divAcc = new THREE.Vector3(); // DACS divert acceleration, body frame
  let divertUsed = 0;

  // State derivative used by RK4.
  const state = {
    pos: pos.clone(),
    vel: vel.clone(),
    q: q.clone(),
    w: w.clone(),
  };
  const k1 = { dpos: new THREE.Vector3(), dvel: new THREE.Vector3(), dq: new THREE.Quaternion(), dw: new THREE.Vector3() };
  const k2 = { ...k1 };
  const k3 = { ...k1 };
  const k4 = { ...k1 };
  const tmp = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3() };

  const deriv = (
    st: { pos: THREE.Vector3; vel: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3 },
    out: { dpos: THREE.Vector3; dvel: THREE.Vector3; dq: THREE.Quaternion; dw: THREE.Vector3 },
  ) => {
    qInv.copy(st.q).invert();
    vb.copy(st.vel).applyQuaternion(qInv);
    const V = st.vel.length();
    const alt = st.pos.length() - R_EARTH;
    const { rho, a } = atmosphere(alt);
    const qbar = 0.5 * rho * V * V;
    const mach = V / a;
    const alpha = Math.atan2(vb.z, Math.max(1, vb.x));
    const beta = Math.asin(THREE.MathUtils.clamp(vb.y / Math.max(1, V), -1, 1));
    const coef = aeroAt(mach, (alpha * 180) / Math.PI);
    const der = aeroDerivatives(mach);
    const cnSlope = Math.max(1.2, aeroAt(mach, 5).cn / Math.sin(5 * DEG));

    // Body forces (x forward, y right, z down).
    const thrust = 4000; // sustainer, N
    Fb.set(thrust - coef.ca * qbar * S, -cnSlope * beta * qbar * S, -coef.cn * qbar * S);
    Fb.addScaledVector(divAcc, mass);
    Fe.copy(Fb).applyQuaternion(st.q);
    out.dvel.copy(Fe).divideScalar(mass);
    out.dvel.addScaledVector(st.pos.clone().normalize(), -MU / st.pos.lengthSq());

    // Aero moments: static + rate damping + fins.
    const qSd = qbar * S * d;
    const p = st.w.x;
    const qr = st.w.y;
    const r = st.w.z;
    M.set(
      (der.clp * ((p * d) / (2 * Math.max(1, V))) + der.clDelta * fin.r) * qSd,
      (coef.cm + der.cmq * ((qr * d) / (2 * Math.max(1, V))) - Math.abs(der.cmDelta) * fin.p) * qSd,
      // Yaw is modelled symmetrically with pitch: the static term uses the
      // moment table evaluated at beta, and the fin term uses the (diameter-
      // normalised) moment derivative. The table's cnDelta is a fin *force*
      // derivative and is ~8x too weak for a moment coefficient.
      (-aeroAt(mach, (beta * 180) / Math.PI).cm +
        der.cnr * ((r * d) / (2 * Math.max(1, V))) -
        Math.abs(der.cmDelta) * fin.y) * qSd,
    );
    // Damping fallback (the table values are small for a fin-controlled body).
    M.x += -0.8 * qSd * ((p * d) / (2 * Math.max(1, V)));
    M.y += -1.5 * qSd * ((qr * d) / (2 * Math.max(1, V)));
    M.z += -1.5 * qSd * ((r * d) / (2 * Math.max(1, V)));
    Iw.set(inertia.x * p, inertia.y * qr, inertia.z * r);
    gyro.crossVectors(st.w, Iw);
    out.dw.copy(M).sub(gyro).divide(inertia);

    out.dpos.copy(st.vel);
    const qw = st.q.w;
    const qx = st.q.x;
    const qy = st.q.y;
    const qz = st.q.z;
    out.dq.set(
      -0.5 * (qx * p + qy * qr + qz * r),
      0.5 * (qw * p + qy * r - qz * qr),
      0.5 * (qw * qr + qz * p - qx * r),
      0.5 * (qw * r + qx * qr - qy * p),
    );
  };

  while (t < tEnd) {
    // ---- target kinematics -------------------------------------------------
    if (args.maneuver === "turn" && args.maneuverG > 0.05) {
      upE.copy(targetPos).normalize();
      zBody.crossVectors(targetVel, upE).normalize();
      targetVel.addScaledVector(zBody, args.maneuverG * 9.81 * dt).setLength(args.targetSpeed);
    } else if (args.maneuver === "weave" && args.maneuverG > 0.05) {
      if (t - lastWeave > 2) {
        weaveSign = -weaveSign;
        lastWeave = t;
      }
      upE.copy(targetPos).normalize();
      zBody.crossVectors(targetVel, upE).normalize();
      targetVel.addScaledVector(zBody, weaveSign * args.maneuverG * 9.81 * dt).setLength(args.targetSpeed);
    }
    targetPos.addScaledVector(targetVel, dt);

    // ---- guidance ----------------------------------------------------------
    rRel.copy(targetPos).sub(state.pos);
    vRel.copy(targetVel).sub(state.vel);
    const range = Math.max(1, rRel.length());
    const closing = Math.max(0, -rRel.dot(vRel) / range);
    uLos.copy(rRel).divideScalar(range);
    omega.crossVectors(rRel, vRel).divideScalar(range * range);
    aCmd.crossVectors(omega, uLos).multiplyScalar(args.navConst * closing);
    const cap = args.maxLoadG * 9.81;
    if (aCmd.length() > cap) aCmd.setLength(cap);

    // ---- autopilot ---------------------------------------------------------
    const alt = state.pos.length() - R_EARTH;
    qInv.copy(state.q).invert();
    vb.copy(state.vel).applyQuaternion(qInv);
    const V = state.vel.length();
    const { rho, a } = atmosphere(alt);
    const qbar = 0.5 * rho * V * V;
    const mach = V / Math.max(1, a);
    const cnSlope = Math.max(1.2, aeroAt(mach, 5).cn / Math.sin(5 * DEG));

    // Skid-to-turn autopilot. The guidance command is split: the fins trim as
    // much AoA/sideslip as they physically can (limited by the static margin),
    // and the DACS divert thrusters supply the remainder so the total lateral
    // acceleration matches PN. Rate loops drive the fins; beta_dot ~ -r, so the
    // yaw rate command carries the opposite sign of the pitch one.
    aB.copy(aCmd).applyQuaternion(qInv);
    const derNow = aeroDerivatives(mach);
    const cmSlope = Math.abs(aeroAt(mach, 8).cm) / (8 * DEG); // per rad
    const alphaTrim = Math.min(14 * DEG, (Math.abs(derNow.cmDelta) * finMax) / Math.max(1, cmSlope));
    const betaTrim = Math.min(8 * DEG, (Math.abs(derNow.cmDelta) * finMax) / Math.max(1, cmSlope));
    const cnZmax = aeroAt(mach, (alphaTrim * 180) / Math.PI).cn;
    const aeroZcap = (cnZmax * qbar * S) / mass;
    const aeroYcap = (cnSlope * betaTrim * qbar * S) / mass;
    const cnAccZ = cnZmax * qbar * S;
    const cnAccY = cnSlope * qbar * S;
    const tgtZ = THREE.MathUtils.clamp(aB.z, -aeroZcap, aeroZcap);
    const tgtY = THREE.MathUtils.clamp(aB.y, -aeroYcap, aeroYcap);
    const alpha = Math.atan2(vb.z, Math.max(1, vb.x));
    const beta = Math.asin(THREE.MathUtils.clamp(vb.y / Math.max(1, V), -1, 1));
    const aDes = cnAccZ > 1 ? THREE.MathUtils.clamp((-tgtZ * mass) / cnAccZ, -alphaTrim, alphaTrim) : 0;
    const bDes = cnAccY > 1 ? THREE.MathUtils.clamp((-tgtY * mass) / cnAccY, -betaTrim, betaTrim) : 0;
    const qRate = s.attGain * (aDes - alpha) - 0.9 * state.w.y;
    const rRate = s.attGain * (beta - bDes) - 1.2 * state.w.z;

    finCmd.p = ctrl(state.w.y - qRate, s.rateGain);
    finCmd.y = ctrl(state.w.z - rRate, s.rateGain);

    // DACS divert: residual acceleration, clamped by the thruster limit and the
    // remaining impulse budget.
    if (s.divertMaxG > 0 && (s.divertBudgetMs <= 0 || divertUsed < s.divertBudgetMs)) {
      const dcap = s.divertMaxG * 9.81;
      divAcc.set(
        0,
        THREE.MathUtils.clamp(aB.y - tgtY, -dcap, dcap),
        THREE.MathUtils.clamp(aB.z - tgtZ, -dcap, dcap),
      );
      divertUsed += divAcc.length() * dt;
    } else {
      divAcc.set(0, 0, 0);
    }
    // Roll is left to aerodynamic damping: the tiny roll inertia and the weak
    // roll authority make a fast roll loop numerically stiff at 1 ms.
    finCmd.r = 0;
    // Servo: first-order lag, rate limit, travel limit.
    const k = 1 - Math.exp(-dt / tau);
    for (const ax of ["p", "y", "r"] as const) {
      const prev = fin[ax];
      const step = THREE.MathUtils.clamp((finCmd[ax] - prev) * k, -rateMax * dt, rateMax * dt);
      fin[ax] = THREE.MathUtils.clamp(prev + step, -finMaxRad, finMaxRad);
    }

    // ---- RK4 ---------------------------------------------------------------
    deriv(state, k1);
    tmp.pos.copy(state.pos).addScaledVector(k1.dpos, dt / 2);
    tmp.vel.copy(state.vel).addScaledVector(k1.dvel, dt / 2);
    tmp.q.set(
      state.q.x + (k1.dq.x * dt) / 2,
      state.q.y + (k1.dq.y * dt) / 2,
      state.q.z + (k1.dq.z * dt) / 2,
      state.q.w + (k1.dq.w * dt) / 2,
    ).normalize();
    tmp.w.copy(state.w).addScaledVector(k1.dw, dt / 2);
    deriv(tmp, k2);
    tmp.pos.copy(state.pos).addScaledVector(k2.dpos, dt / 2);
    tmp.vel.copy(state.vel).addScaledVector(k2.dvel, dt / 2);
    tmp.q.set(state.q.x + k2.dq.x * dt / 2, state.q.y + k2.dq.y * dt / 2, state.q.z + k2.dq.z * dt / 2, state.q.w + k2.dq.w * dt / 2).normalize();
    tmp.w.copy(state.w).addScaledVector(k2.dw, dt / 2);
    deriv(tmp, k3);
    tmp.pos.copy(state.pos).addScaledVector(k3.dpos, dt);
    tmp.vel.copy(state.vel).addScaledVector(k3.dvel, dt);
    tmp.q.set(state.q.x + k3.dq.x * dt, state.q.y + k3.dq.y * dt, state.q.z + k3.dq.z * dt, state.q.w + k3.dq.w * dt).normalize();
    tmp.w.copy(state.w).addScaledVector(k3.dw, dt);
    deriv(tmp, k4);

    state.pos.addScaledVector(k1.dpos, dt / 6).addScaledVector(k2.dpos, dt / 3).addScaledVector(k3.dpos, dt / 3).addScaledVector(k4.dpos, dt / 6);
    state.vel.addScaledVector(k1.dvel, dt / 6).addScaledVector(k2.dvel, dt / 3).addScaledVector(k3.dvel, dt / 3).addScaledVector(k4.dvel, dt / 6);
    state.q.set(
      state.q.x + (k1.dq.x + 2 * k2.dq.x + 2 * k3.dq.x + k4.dq.x) * dt / 6,
      state.q.y + (k1.dq.y + 2 * k2.dq.y + 2 * k3.dq.y + k4.dq.y) * dt / 6,
      state.q.z + (k1.dq.z + 2 * k2.dq.z + 2 * k3.dq.z + k4.dq.z) * dt / 6,
      state.q.w + (k1.dq.w + 2 * k2.dq.w + 2 * k3.dq.w + k4.dq.w) * dt / 6,
    ).normalize();
    state.w.addScaledVector(k1.dw, dt / 6).addScaledVector(k2.dw, dt / 3).addScaledVector(k3.dw, dt / 3).addScaledVector(k4.dw, dt / 6);

    t += dt;

    // ---- load / sampling ---------------------------------------------------
    qInv.copy(state.q).invert();
    vb.copy(state.vel).applyQuaternion(qInv);
    const alphaDeg = (Math.atan2(vb.z, Math.max(1, vb.x)) * 180) / Math.PI;
    const betaDeg = (Math.asin(THREE.MathUtils.clamp(vb.y / Math.max(1, state.vel.length()), -1, 1)) * 180) / Math.PI;
    const loadG = Math.abs(aCmd.length()) / 9.81;
    if (loadG > maxLoad) maxLoad = loadG;

    if (t >= nextOut) {
      nextOut += outEvery;
      const noseWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(state.q);
      samples.push({
        t,
        pos: state.pos.clone(),
        vel: state.vel.clone(),
        att: state.q.clone(),
        mass,
        loadG,
        alphaDeg,
        betaDeg,
        fovDeg: (Math.acos(THREE.MathUtils.clamp(noseWorld.dot(uLos), -1, 1)) * 180) / Math.PI,
        fin: { up: fin.p, down: -fin.p, left: fin.y, right: -fin.y },
        rates: { p: state.w.x, q: state.w.y, r: state.w.z },
        divertG: divAcc.length() / 9.81,
        range,
        locked: true,
      });
      targets.push({ t, pos: targetPos.clone(), vel: targetVel.clone() });
    }
    if (range < minRange) {
      minRange = range;
      tMin = t;
    }
    if (range > minRange + 30 && t > tMin + 0.3) break;
    if (state.pos.length() - R_EARTH < 0) break;
  }

  return { samples, targets, minRange, tMin, maxLoad, divertUsedMs: divertUsed };
}
