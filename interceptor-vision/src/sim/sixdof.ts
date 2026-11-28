import * as THREE from "three";
import { aeroAt, aeroDerivatives, AERO_REF } from "./aero";

/**
 * Rigid-body (6-DoF) terminal integrator:
 *  - translation from body-axis aero forces + thrust + spherical gravity;
 *  - rotation from Euler's equations with aero moments (static + damping) and
 *    fin control moments;
 *  - fin servos with first-order lag, rate limit and travel limit;
 *  - skid-to-turn autopilot: an AoA/sideslip demand (limited by the trim
 *    authority set by the static margin) is tracked by two decoupled 2x2 LQR
 *    loops; DACS divert thrusters take the residual only when enabled.
 *
 * Pitch and yaw moments are treated symmetrically: the static terms use the
 * tabulated moment (Cm) curve and the fin moments use |Cm_delta|. The table's
 * Cn_delta is a fin normal-force derivative, not a yawing moment, so it is not
 * used for the yaw moment. Hinge moments and servo backlash are not modelled
 * (see docs/6DOF-PARAMETERS.md). CN/CM are treated as odd in the flow angle and
 * CA as even, because the table spans -8..+20 deg but the airframe is symmetric.
 */
const WGS84_A = 6_378_137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
const J2 = 1.082_626_68e-3;
const OMEGA_EARTH = 7.292_115_0e-5;
const MU = 3.986_004_418e14;
const G0 = 9.80665;
const R_AIR = 287.05287;
const GAMMA_AIR = 1.4;
const DEG = Math.PI / 180;

// USSA1976 8-layer standard atmosphere (aligned with Python missile_intercept/vehicle/atmosphere.py)
const ATM_H = [0, 11_000, 20_000, 32_000, 47_000, 51_000, 71_000, 84_852];
const ATM_T = [288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65, 186.946];
const ATM_L = [-0.0065, 0.0, 0.001, 0.0028, 0.0, -0.0028, -0.002, 0.0];
const ATM_P: number[] = (() => {
  const arr = [101_325.0];
  for (let i = 0; i < ATM_H.length - 1; i++) {
    const dh = ATM_H[i + 1] - ATM_H[i];
    const t0 = ATM_T[i];
    const l = ATM_L[i];
    arr.push(
      Math.abs(l) < 1e-12
        ? arr[i] * Math.exp((-G0 * dh) / (R_AIR * t0))
        : arr[i] * Math.pow((t0 + l * dh) / t0, -G0 / (R_AIR * l)),
    );
  }
  return arr;
})();

function geodeticAltitude(pos: THREE.Vector3): number {
  const p = Math.hypot(pos.x, pos.y);
  if (p < 1e-6) return Math.abs(pos.z) - WGS84_B;
  const th = Math.atan2(pos.z * WGS84_A, p * WGS84_B);
  const st = Math.sin(th);
  const ct = Math.cos(th);
  const lat = Math.atan2(pos.z + WGS84_EP2 * WGS84_B * st * st * st, p - WGS84_E2 * WGS84_A * ct * ct * ct);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return Math.abs(cosLat) > 1e-6 ? p / cosLat - N : Math.abs(pos.z) - WGS84_B;
}

function addGravityAndCoriolisEcef(pos: THREE.Vector3, vel: THREE.Vector3, out: THREE.Vector3): void {
  const r2 = pos.lengthSq();
  const r = Math.sqrt(Math.max(r2, 1));
  const r3 = r2 * r;
  const r5 = r3 * r2;
  const z2r2 = (pos.z * pos.z) / Math.max(r2, 1);
  const cJ2 = (-1.5 * J2 * MU * WGS84_A * WGS84_A) / Math.max(r5, 1);
  out.x += (-MU / r3) * pos.x + cJ2 * pos.x * (1 - 5 * z2r2);
  out.y += (-MU / r3) * pos.y + cJ2 * pos.y * (1 - 5 * z2r2);
  out.z += (-MU / r3) * pos.z + cJ2 * pos.z * (3 - 5 * z2r2);
  // Rotating ECEF frame inertial accelerations: -2 (w x v) - w x (w x r)
  const w2 = OMEGA_EARTH * OMEGA_EARTH;
  out.x += 2 * OMEGA_EARTH * vel.y + w2 * pos.x;
  out.y += -2 * OMEGA_EARTH * vel.x + w2 * pos.y;
}

export interface SixDofSettings {
  /** Fin travel limit, deg. */
  finMaxDeg: number;
  /** Fin no-load rate, deg/s. */
  finRateDeg: number;
  /** Servo bandwidth, Hz (first-order). */
  finBandwidthHz: number;
  /** Moment of inertia scale (1 = uniform slender body estimate). */
  inertiaScale: number;
  /**
   * Coherent aero scale applied to CN, CM and their derivatives. The engineering
   * table under-predicts lift by ~1.7x against public missile wind-tunnel data
   * (CN(14 deg) ~= 1.05 at M9 vs the ~1.6-1.9 needed for the recorded 10-12 g).
   * Scaling CN and CM together preserves the static margin and trim angle.
   */
  aeroScale: number;
  /**
   * Static-margin scale on the pitching/yawing moment only (1 = table's 0.78 m).
   * The engineering cg/cp estimate gives an unusually large margin, which forces
   * ~14 deg of fin to trim 10 deg AoA; typical guided missiles run 3-6% of length.
   */
  smScale: number;
  /** Allocation sign switches for diagnosing the aero force direction. */
  allocP: number;
  allocY: number;
  /**
   * Decoupled LQR closed-loop natural frequency, rad/s. Must stay above the
   * airframe's open-loop pitch frequency sqrt(|dCm/dalpha|*qSd/Iyy) (~6 rad/s
   * here); at 5 rad/s the loop detuned the airframe by pole-zero cancellation
   * and departed past 60 deg AoA at the endgame boundary. The 10 Hz fin servo
   * sets the usable upper bound.
   */
  lqrWn: number;
  /** Decoupled LQR closed-loop damping ratio. */
  lqrZeta: number;
  /** First-order command filter on the AoA/sideslip demand, Hz. */
  cmdFilterHz: number;
  /** Hard AoA / sideslip allocation limits, deg. */
  alphaMaxDeg: number;
  betaMaxDeg: number;
  /** DACS divert limit, g (0 disables the thrusters, aero only). */
  divertMaxG: number;
  /** Usable divert impulse budget, m/s (0 = unlimited). */
  divertBudgetMs: number;
}

export const SIXDOF_DEFAULTS: SixDofSettings = {
  finMaxDeg: 15,
  finRateDeg: 200,
  finBandwidthHz: 10,
  inertiaScale: 1,
  aeroScale: 1,
  smScale: 0.6,
  allocP: 1,
  allocY: 1,
  lqrWn: 10,
  lqrZeta: 0.9,
  cmdFilterHz: 2,
  alphaMaxDeg: 18,
  betaMaxDeg: 14,
  divertMaxG: 0,
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
  alphaDesDeg: number;
  betaDesDeg: number;
  cmdG: number;
  cmdE: { x: number; y: number; z: number };
  accE: { x: number; y: number; z: number };
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
  /** Peak achieved lateral load factor, g. */
  maxLoad: number;
  /** Peak commanded lateral load factor, g (may sit at the cap). */
  maxCmdLoad: number;
  divertUsedMs: number;
}

function atmosphere(altM: number) {
  const h = Math.max(0, altM);
  if (h >= ATM_H[ATM_H.length - 1]) {
    const t = ATM_T[ATM_T.length - 1];
    const p = ATM_P[ATM_P.length - 1] * Math.exp((-G0 * (h - ATM_H[ATM_H.length - 1])) / (R_AIR * t));
    return { rho: p / (R_AIR * t), a: Math.sqrt(GAMMA_AIR * R_AIR * t) };
  }
  let idx = 0;
  for (let i = ATM_H.length - 2; i >= 0; i--) {
    if (h >= ATM_H[i]) {
      idx = i;
      break;
    }
  }
  const dh = h - ATM_H[idx];
  const t0 = ATM_T[idx];
  const l = ATM_L[idx];
  const t = t0 + l * dh;
  const p =
    Math.abs(l) < 1e-12
      ? ATM_P[idx] * Math.exp((-G0 * dh) / (R_AIR * t0))
      : ATM_P[idx] * Math.pow(t / t0, -G0 / (R_AIR * l));
  return { rho: p / (R_AIR * t), a: Math.sqrt(GAMMA_AIR * R_AIR * t) };
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
  /** Recorded body rates at hand-over, rad/s (defaults to zero). */
  initialRates?: { p: number; q: number; r: number };
  /** Recorded non-gravity acceleration (ECEF) to follow instead of PN. */
  accelFeedforward?: { t: number; x: number; y: number; z: number }[];
  /** Recorded target track (ECEF), replayed instead of a constant-velocity target. */
  targetTrack?: { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }[];
  /** Integration step, s (default 1 ms; use 0.5 ms for the convergence check). */
  stepS?: number;
  settings?: Partial<SixDofSettings>;
}): SixResult {
  const s: SixDofSettings = { ...SIXDOF_DEFAULTS, ...args.settings };
  // Coherent lift/moment scaling (keeps the static margin and trim angle fixed).
  const sc = s.aeroScale;
  /**
   * CN and CM are odd in the flow angle, CA is even; the table only spans
   * -8..+20 deg. Evaluate |angle| and re-apply the sign, so -18 deg AoA keeps
   * the same restoring moment as +18 deg instead of clamping at the -8 deg
   * column (which lets a pull-down departure run away).
   */
  const aeroS = (m: number, aDeg: number) => {
    const p = aeroAt(m, Math.abs(aDeg));
    const sgn = aDeg < 0 ? -1 : 1;
    return { ca: p.ca, cn: p.cn * sc * sgn, cm: p.cm * sc * sgn };
  };
  const derS = (m: number) => {
    const d = aeroDerivatives(m);
    return {
      cnDelta: d.cnDelta * sc,
      cmDelta: d.cmDelta * sc,
      cmq: d.cmq * sc,
      cnr: d.cnr * sc,
      clp: d.clp,
      clDelta: d.clDelta,
    };
  };
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
  if (args.initialRates) w.set(args.initialRates.p, args.initialRates.q, args.initialRates.r);
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
  let maxCmdLoad = 0;
  let fin = { p: 0, y: 0, r: 0 };
  let aDesF = 0;
  let bDesF = 0;
  let weaveSign = 1;
  let lastWeave = args.t0;

  const finMaxRad = finMax;

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
  // Each RK4 stage needs its own buffers: spreading k1 would copy the
  // references, so every deriv() call would overwrite the same vectors and the
  // weighted sum would collapse onto the last stage (explicit Euler).
  const stage = () => ({
    dpos: new THREE.Vector3(),
    dvel: new THREE.Vector3(),
    dq: new THREE.Quaternion(),
    dw: new THREE.Vector3(),
  });
  const k1 = stage();
  const k2 = stage();
  const k3 = stage();
  const k4 = stage();
  const tmp = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3() };

  const deriv = (
    st: { pos: THREE.Vector3; vel: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3 },
    out: { dpos: THREE.Vector3; dvel: THREE.Vector3; dq: THREE.Quaternion; dw: THREE.Vector3 },
  ) => {
    qInv.copy(st.q).invert();
    vb.copy(st.vel).applyQuaternion(qInv);
    const V = st.vel.length();
    const alt = geodeticAltitude(st.pos);
    const { rho, a } = atmosphere(alt);
    const qbar = 0.5 * rho * V * V;
    const mach = V / a;
    const alpha = Math.atan2(vb.z, Math.max(1, vb.x));
    const beta = Math.asin(THREE.MathUtils.clamp(vb.y / Math.max(1, V), -1, 1));
    const coef = aeroS(mach, (alpha * 180) / Math.PI);
    const der = derS(mach);

    // Body forces (x forward, y right, z down).
    const thrust = 4000; // sustainer, N
    // The side force uses the same symmetric CN curve as the normal force, so
    // large sideslip saturates exactly as large AoA does. A linear cnSlope*beta
    // extrapolated to 30 deg would fabricate ~17 g of unphysical side force.
    const cnBeta = aeroS(mach, (beta * 180) / Math.PI).cn;
    Fb.set(thrust - coef.ca * qbar * S, -cnBeta * qbar * S, -coef.cn * qbar * S);
    Fb.addScaledVector(divAcc, mass);
    Fe.copy(Fb).applyQuaternion(st.q);
    out.dvel.copy(Fe).divideScalar(mass);
    addGravityAndCoriolisEcef(st.pos, st.vel, out.dvel);

    // Aero moments: static + rate damping + fins.
    const qSd = qbar * S * d;
    const p = st.w.x;
    const qr = st.w.y;
    const r = st.w.z;
    M.set(
      (der.clp * ((p * d) / (2 * Math.max(1, V))) + der.clDelta * fin.r) * qSd,
      (s.smScale * coef.cm + der.cmq * ((qr * d) / (2 * Math.max(1, V))) - Math.abs(der.cmDelta) * fin.p) * qSd,
      // Yaw is modelled symmetrically with pitch: the static term uses the
      // moment table evaluated at beta, and the fin term uses the (diameter-
      // normalised) moment derivative. The table's cnDelta is a fin *force*
      // derivative and is ~8x too weak for a moment coefficient.
      (s.smScale * -aeroS(mach, (beta * 180) / Math.PI).cm +
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
    // q_dot = 0.5 * q (x) omega. THREE.Quaternion.set takes (x, y, z, w), so
    // the scalar part goes last; a (w, x, y, z) ordering here makes the
    // attitude rotate about a permuted axis.
    out.dq.set(
      0.5 * (qw * p + qy * r - qz * qr),
      0.5 * (qw * qr + qz * p - qx * r),
      0.5 * (qw * r + qx * qr - qy * p),
      -0.5 * (qx * p + qy * qr + qz * r),
    );
  };

  while (t < tEnd) {
    // ---- target kinematics -------------------------------------------------
    if (args.targetTrack && args.targetTrack.length > 1) {
      // Replay the recorded target (it decelerates and turns; a constant-
      // velocity reconstruction diverges from it by kilometres).
      const tr = args.targetTrack;
      let ti = 0;
      while (ti < tr.length - 2 && tr[ti + 1].t < t) ti++;
      const p0 = tr[ti];
      const p1 = tr[ti + 1];
      const span = p1.t - p0.t || 1;
      const k = THREE.MathUtils.clamp((t - p0.t) / span, 0, 1);
      targetPos.set(p0.x + (p1.x - p0.x) * k, p0.y + (p1.y - p0.y) * k, p0.z + (p1.z - p0.z) * k);
      targetVel.set(
        p0.vx + (p1.vx - p0.vx) * k,
        p0.vy + (p1.vy - p0.vy) * k,
        p0.vz + (p1.vz - p0.vz) * k,
      );
    } else {
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
    }

    // ---- guidance ----------------------------------------------------------
    rRel.copy(targetPos).sub(state.pos);
    vRel.copy(targetVel).sub(state.vel);
    const range = Math.max(1, rRel.length());
    const closing = Math.max(0, -rRel.dot(vRel) / range);
    uLos.copy(rRel).divideScalar(range);
    omega.crossVectors(rRel, vRel).divideScalar(range * range);
    aCmd.crossVectors(omega, uLos).multiplyScalar(args.navConst * closing);
    // Recorded-acceleration feed-forward: when supplied, follow the payload's
    // own non-gravity acceleration instead of PN. This reproduces the recorded
    // engagement (whose guidance is clearly not pure PN).
    if (args.accelFeedforward && args.accelFeedforward.length > 1) {
      const ff = args.accelFeedforward;
      let fi = 0;
      while (fi < ff.length - 2 && ff[fi + 1].t < t) fi++;
      const f0 = ff[fi];
      const f1 = ff[fi + 1];
      const span = f1.t - f0.t || 1;
      const k = THREE.MathUtils.clamp((t - f0.t) / span, 0, 1);
      aCmd.set(
        f0.x + (f1.x - f0.x) * k,
        f0.y + (f1.y - f0.y) * k,
        f0.z + (f1.z - f0.z) * k,
      );
    }
    const cap = args.maxLoadG * 9.81;
    if (aCmd.length() > cap) aCmd.setLength(cap);

    // ---- autopilot ---------------------------------------------------------
    const alt = geodeticAltitude(state.pos);
    qInv.copy(state.q).invert();
    vb.copy(state.vel).applyQuaternion(qInv);
    const V = state.vel.length();
    const { rho, a } = atmosphere(alt);
    const qbar = 0.5 * rho * V * V;
    const mach = V / Math.max(1, a);
    const cnSlope = Math.max(1.2, aeroS(mach, 5).cn / Math.sin(5 * DEG));

    // Skid-to-turn autopilot. The guidance command is split: the fins trim as
    // much AoA/sideslip as they physically can (limited by the static margin),
    // and the DACS divert thrusters supply the remainder so the total lateral
    // acceleration matches PN. Rate loops drive the fins; beta_dot ~ -r, so the
    // yaw rate command carries the opposite sign of the pitch one.
    aB.copy(aCmd).applyQuaternion(qInv);
    const derNow = derS(mach);
    const cmSlope = (s.smScale * Math.abs(aeroS(mach, 8).cm)) / (8 * DEG); // per rad
    const alphaTrim = Math.min(s.alphaMaxDeg * DEG, (Math.abs(derNow.cmDelta) * finMax) / Math.max(1, cmSlope));
    const betaTrim = Math.min(s.betaMaxDeg * DEG, (Math.abs(derNow.cmDelta) * finMax) / Math.max(1, cmSlope));
    const cnZmax = aeroS(mach, (alphaTrim * 180) / Math.PI).cn;
    const aeroZcap = (cnZmax * qbar * S) / mass;
    const aeroYcap = (cnSlope * betaTrim * qbar * S) / mass;
    const cnAccZ = (cnZmax / Math.max(1e-3, alphaTrim)) * qbar * S;
    const cnAccY = cnSlope * qbar * S;
    const tgtZ = THREE.MathUtils.clamp(aB.z, -aeroZcap, aeroZcap);
    const tgtY = THREE.MathUtils.clamp(aB.y, -aeroYcap, aeroYcap);
    const alpha = Math.atan2(vb.z, Math.max(1, vb.x));
    const beta = Math.asin(THREE.MathUtils.clamp(vb.y / Math.max(1, V), -1, 1));
    // Alpha/sideslip allocation with projection compensation. The normal force
    // acts along body -z, which is inclined by alpha to the velocity-normal, so
    // matching the body component alone under-delivers by cos(alpha) - the
    // source of the constant ~4 deg aim bias (miss proportional to range).
    // Solve F*cos(alpha) = m*a by fixed-point iteration on alpha.
    const alloc = (tgt: number, denom: number, lim: number, sign: number) => {
      if (denom <= 1) return 0;
      let d = THREE.MathUtils.clamp((-tgt * mass) / denom, -lim, lim);
      for (let i = 0; i < 4; i++) {
        const c = Math.max(0.5, Math.cos(d));
        d = THREE.MathUtils.clamp((-tgt * mass) / (denom * c), -lim, lim);
      }
      return sign * d;
    };
    const aDes = alloc(tgtZ, cnAccZ, alphaTrim, s.allocP);
    const bDes = alloc(tgtY, cnAccY, betaTrim, s.allocY);
    // First-order command filter: the guidance can jump to a large demand, and
    // an unfiltered step makes the LQR overshoot into stall.
    const kf = 1 - Math.exp(-dt * 2 * Math.PI * s.cmdFilterHz);
    aDesF += (aDes - aDesF) * kf;
    bDesF += (bDes - bDesF) * kf;
    // Normal-acceleration autopilot: drive the measured body-axis aero
    // acceleration to the (capped) PN command. This is sign-consistent with the
    // aero force model and avoids the open-loop AoA/sideslip mapping.
    // ---- decoupled LQR: pitch (alpha,q) and yaw (beta,r) ----------------
    // Linear short-period models about the current condition:
    //   alpha_dot = -c*alpha + q,        q_dot = aA*alpha + aQ*q + bP*delta
    //   beta_dot  = -c*beta  - r,        r_dot = aB*beta  + aR*r + bY*delta_y
    // Each 2x2 is controllable through the fin; K is obtained by placing the
    // closed-loop poles at (wn, zeta), i.e. the 2x2 LQR equivalent. This gives a
    // well-damped, fast AoA/sideslip response without a fragile cascade.
    const qSd = qbar * S * d;
    const c = (cnSlope * qbar * S) / (mass * Math.max(1, V)); // 1/s
    const cmAlpha = (aeroS(mach, 6).cm - aeroS(mach, 4).cm) / (2 * DEG); // dCm/dalpha, per rad (<0)
    const aA = (s.smScale * cmAlpha * qSd) / inertia.y;
    const aQ = (derNow.cmq * (d / (2 * Math.max(1, V))) * qSd) / inertia.y;
    const aYaw = (s.smScale * -cmAlpha * qSd) / inertia.z;
    const aR = (derNow.cnr * (d / (2 * Math.max(1, V))) * qSd) / inertia.z;
    const bP = (-Math.abs(derNow.cmDelta) * qSd) / inertia.y;
    const bY = (-Math.abs(derNow.cmDelta) * qSd) / inertia.z;
    const wn = s.lqrWn;
    const zeta = s.lqrZeta;
    const place = (a11: number, a12: number, a21: number, a22: number, b: number): [number, number] => {
      if (Math.abs(b) < 1e-9) return [0, 0];
      const k2 = (a11 + a22 + 2 * zeta * wn) / b;
      const k1 = (wn * wn + a12 * a21 + a11 * b * k2 - a11 * a22) / (a12 * b);
      return [k1, k2];
    };
    const [k1p, k2p] = place(-c, 1, aA, aQ, bP);
    const [k1y, k2y] = place(-c, -1, aYaw, aR, bY);
    // Steady-turn reference: alpha_dot=0 -> q_ref=c*alpha_des; beta_dot=0 -> r_ref=-c*beta_des.
    const qRef = c * aDesF;
    const rRef = -c * bDesF;
    const uffP = Math.abs(bP) > 1e-9 ? -(aA * aDesF + aQ * qRef) / bP : 0;
    const uffY = Math.abs(bY) > 1e-9 ? -(aYaw * bDesF + aR * rRef) / bY : 0;
    finCmd.p = THREE.MathUtils.clamp(-k1p * (alpha - aDesF) - k2p * (state.w.y - qRef) + uffP, -finMaxRad, finMaxRad);
    finCmd.y = THREE.MathUtils.clamp(-k1y * (beta - bDesF) - k2y * (state.w.z - rRef) + uffY, -finMaxRad, finMaxRad);


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
    const Vn = Math.max(1, state.vel.length());
    const alphaDeg = (Math.atan2(vb.z, Math.max(1, vb.x)) * 180) / Math.PI;
    const betaDeg = (Math.asin(THREE.MathUtils.clamp(vb.y / Vn, -1, 1)) * 180) / Math.PI;
    // Achieved lateral load factor, from the aero force the airframe actually
    // generates. The guidance demand (cmdG) may sit at its cap while the fins
    // cannot deliver it; reporting the demand as "load" overstates the vehicle.
    const atmN = atmosphere(geodeticAltitude(state.pos));
    const qbarN = 0.5 * atmN.rho * Vn * Vn;
    const machN = Vn / Math.max(1, atmN.a);
    const cnA = aeroS(machN, alphaDeg).cn;
    const cnBetaA = aeroS(machN, betaDeg).cn;
    const ayB = (-cnBetaA * qbarN * S) / mass + divAcc.y;
    const azB = (-cnA * qbarN * S) / mass + divAcc.z;
    const loadG = Math.hypot(ayB, azB) / 9.81;
    if (loadG > maxLoad) maxLoad = loadG;
    const cmdG = aCmd.length() / 9.81;
    if (cmdG > maxCmdLoad) maxCmdLoad = cmdG;

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
        alphaDesDeg: (aDes * 180) / Math.PI,
        betaDesDeg: (bDes * 180) / Math.PI,
        cmdG,
        cmdE: { x: aCmd.x, y: aCmd.y, z: aCmd.z },
        accE: (() => {
          const v = new THREE.Vector3(0, ayB, azB).applyQuaternion(state.q);
          return { x: v.x, y: v.y, z: v.z };
        })(),
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
    if (geodeticAltitude(state.pos) < 0) break;
  }

  return { samples, targets, minRange, tMin, maxLoad, maxCmdLoad, divertUsedMs: divertUsed };
}
