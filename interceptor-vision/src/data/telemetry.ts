import { useApp } from "../state";
import { dataClock } from "./dataClock";

export { dataClock };

export type Phase = "boost" | "midcourse" | "terminal" | "coast";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

export interface FinDeflections {
  up: number;
  down: number;
  left: number;
  right: number;
}

export interface BodyRates {
  p: number;
  q: number;
  r: number;
}

export interface Sample {
  t: number;
  position: Vec3;
  velocity: Vec3;
  attitude: Quat;
  latDeg: number;
  lonDeg: number;
  altM: number;
  speedMS: number;
  mach: number;
  qPa: number;
  loadG: number;
  loadCmdG: number;
  massKg: number;
  fovDeg: number;
  rangeM: number;
  phase: Phase;
  seekerLock: boolean;
  handover: boolean;
  finDeflectionsRad?: FinDeflections;
  bodyRatesRadS?: BodyRates;
  /** Rigid-body (6-DoF) solve only. */
  alphaDeg?: number;
  betaDeg?: number;
  divertG?: number;
  /** Hypersonic aerothermal & dual-mode seeker observables (optional). */
  heatFluxMWm2?: number;
  wallTempK?: number;
  aspectDeg?: number;
  targetRcsM2?: number;
  radarSnrDb?: number;
  irSnrDb?: number;
  seekerAzDeg?: number;
  seekerElDeg?: number;
  /** Phase 1 & 2 extended physics & countermeasure observables (optional). */
  wallTempEqK?: number;
  unstartFlag?: number;
  stageSep?: number;
  cgPos?: number;
  cpPos?: number;
  bodyForceX?: number;
  bodyForceY?: number;
  bodyForceZ?: number;
  decoyActive?: number;
  decoyAzDeg?: number;
  decoyElDeg?: number;
  immPCv?: number;
  immPCa?: number;
  immPCt?: number;
  fuzePk?: number;
  /**
   * True when the roll between the neighbouring records is larger than the
   * 0.45 s cadence can resolve, i.e. the recorded roll channel is aliased.
   * The nose direction stays valid; only the roll about it is unusable.
   */
  attitudeAliased?: boolean;
}

export interface FlightEvent {
  id: string;
  t: number;
  label: string;
  description: string;
  kind: string;
  severity: string;
}

export interface PhaseSegment {
  phase: Phase;
  startT: number;
  endT: number;
  label: string;
}

export interface Telemetry {
  title: string;
  subtitle: string;
  start: number;
  end: number;
  samples: Sample[];
  events: FlightEvent[];
  phases: PhaseSegment[];
  metrics: Record<string, number | null>;
  demoUtc: string;
  entityLabel: string;
  targetSamples: Sample[];
  /** Full validated manifest, reused by the Earth-scale orbital scene. */
  manifest: unknown;
}

let cache: Telemetry | null = null;
let boosterSepT: number | null = null;

/**
 * First-stage burnout time, derived from the payload mass curve: the booster
 * burns hard for the first seconds, then the mass slope collapses to the
 * sustainer's. The payload has no discrete stage event, so this milestone is a
 * derived visual cue rather than a recorded state transition.
 */
export function boosterSeparationTime(): number | null {
  const tel = cache;
  if (!tel || tel.samples.length < 3) return null;
  if (boosterSepT !== null) return boosterSepT;
  const s = tel.samples;
  for (let i = 1; i < s.length - 1; i++) {
    const dtPrev = s[i].t - s[i - 1].t;
    const dtNext = s[i + 1].t - s[i].t;
    if (dtPrev <= 0 || dtNext <= 0 || s[i].t < 2) continue;
    const burnPrev = (s[i - 1].massKg - s[i].massKg) / dtPrev;
    const burnNext = (s[i].massKg - s[i + 1].massKg) / dtNext;
    if (burnPrev > 20 && burnNext < 5) {
      boosterSepT = s[i].t;
      break;
    }
  }
  return boosterSepT;
}

/** Linear / slerp sampler over the validated 1504-sample telemetry payload. */
export function sampleAt(time: number): Sample | null {
  const tel = cache;
  if (!tel || tel.samples.length === 0) return null;
  const t = Math.max(tel.start, Math.min(tel.end, time));
  const arr = tel.samples;
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = arr[lo];
  const b = arr[hi];
  const span = b.t - a.t || 1;
  const k = Math.max(0, Math.min(1, (t - a.t) / span));
  const lerp = (x: number, y: number) => x + (y - x) * k;
  const qa = a.attitude;
  const qb = b.attitude;
  const qdot = Math.abs(qa.w * qb.w + qa.x * qb.x + qa.y * qb.y + qa.z * qb.z);
  // 30 deg between neighbouring records: real manoeuvres stay well under this,
  // the fast-roll windows alias far above it.
  const attitudeAliased = 2 * Math.acos(Math.min(1, qdot)) > (30 * Math.PI) / 180;
  return {
    ...a,
    t,
    position: {
      x: lerp(a.position.x, b.position.x),
      y: lerp(a.position.y, b.position.y),
      z: lerp(a.position.z, b.position.z),
    },
    velocity: {
      x: lerp(a.velocity.x, b.velocity.x),
      y: lerp(a.velocity.y, b.velocity.y),
      z: lerp(a.velocity.z, b.velocity.z),
    },
    attitude: slerp(a.attitude, b.attitude, k),
    attitudeAliased,
    latDeg: lerp(a.latDeg, b.latDeg),
    lonDeg: lerp(a.lonDeg, b.lonDeg),
    altM: lerp(a.altM, b.altM),
    speedMS: lerp(a.speedMS, b.speedMS),
    mach: lerp(a.mach, b.mach),
    qPa: lerp(a.qPa, b.qPa),
    loadG: lerp(a.loadG, b.loadG),
    loadCmdG: lerp(a.loadCmdG, b.loadCmdG),
    massKg: lerp(a.massKg, b.massKg),
    fovDeg: lerp(a.fovDeg, b.fovDeg),
    rangeM: lerp(a.rangeM, b.rangeM),
    finDeflectionsRad: a.finDeflectionsRad && b.finDeflectionsRad
      ? {
          up: lerp(a.finDeflectionsRad.up, b.finDeflectionsRad.up),
          down: lerp(a.finDeflectionsRad.down, b.finDeflectionsRad.down),
          left: lerp(a.finDeflectionsRad.left, b.finDeflectionsRad.left),
          right: lerp(a.finDeflectionsRad.right, b.finDeflectionsRad.right),
        }
      : a.finDeflectionsRad,
    bodyRatesRadS: a.bodyRatesRadS && b.bodyRatesRadS
      ? {
          p: lerp(a.bodyRatesRadS.p, b.bodyRatesRadS.p),
          q: lerp(a.bodyRatesRadS.q, b.bodyRatesRadS.q),
          r: lerp(a.bodyRatesRadS.r, b.bodyRatesRadS.r),
        }
      : a.bodyRatesRadS,
    alphaDeg: a.alphaDeg !== undefined && b.alphaDeg !== undefined ? lerp(a.alphaDeg, b.alphaDeg) : a.alphaDeg,
    betaDeg: a.betaDeg !== undefined && b.betaDeg !== undefined ? lerp(a.betaDeg, b.betaDeg) : a.betaDeg,
    divertG: a.divertG !== undefined && b.divertG !== undefined ? lerp(a.divertG, b.divertG) : a.divertG,
    heatFluxMWm2: a.heatFluxMWm2 !== undefined && b.heatFluxMWm2 !== undefined ? lerp(a.heatFluxMWm2, b.heatFluxMWm2) : a.heatFluxMWm2,
    wallTempK: a.wallTempK !== undefined && b.wallTempK !== undefined ? lerp(a.wallTempK, b.wallTempK) : a.wallTempK,
    aspectDeg: a.aspectDeg !== undefined && b.aspectDeg !== undefined ? lerp(a.aspectDeg, b.aspectDeg) : a.aspectDeg,
    targetRcsM2: a.targetRcsM2 !== undefined && b.targetRcsM2 !== undefined ? lerp(a.targetRcsM2, b.targetRcsM2) : a.targetRcsM2,
    radarSnrDb: a.radarSnrDb !== undefined && b.radarSnrDb !== undefined ? lerp(a.radarSnrDb, b.radarSnrDb) : a.radarSnrDb,
    irSnrDb: a.irSnrDb !== undefined && b.irSnrDb !== undefined ? lerp(a.irSnrDb, b.irSnrDb) : a.irSnrDb,
    seekerAzDeg: a.seekerAzDeg !== undefined && b.seekerAzDeg !== undefined ? lerp(a.seekerAzDeg, b.seekerAzDeg) : a.seekerAzDeg,
    seekerElDeg: a.seekerElDeg !== undefined && b.seekerElDeg !== undefined ? lerp(a.seekerElDeg, b.seekerElDeg) : a.seekerElDeg,
    wallTempEqK: a.wallTempEqK !== undefined && b.wallTempEqK !== undefined ? lerp(a.wallTempEqK, b.wallTempEqK) : a.wallTempEqK,
    unstartFlag: k < 0.5 ? a.unstartFlag : b.unstartFlag,
    stageSep: k < 0.5 ? a.stageSep : b.stageSep,
    cgPos: a.cgPos !== undefined && b.cgPos !== undefined ? lerp(a.cgPos, b.cgPos) : a.cgPos,
    cpPos: a.cpPos !== undefined && b.cpPos !== undefined ? lerp(a.cpPos, b.cpPos) : a.cpPos,
    bodyForceX: a.bodyForceX !== undefined && b.bodyForceX !== undefined ? lerp(a.bodyForceX, b.bodyForceX) : a.bodyForceX,
    bodyForceY: a.bodyForceY !== undefined && b.bodyForceY !== undefined ? lerp(a.bodyForceY, b.bodyForceY) : a.bodyForceY,
    bodyForceZ: a.bodyForceZ !== undefined && b.bodyForceZ !== undefined ? lerp(a.bodyForceZ, b.bodyForceZ) : a.bodyForceZ,
    decoyActive: k < 0.5 ? a.decoyActive : b.decoyActive,
    decoyAzDeg: a.decoyAzDeg !== undefined && b.decoyAzDeg !== undefined ? lerp(a.decoyAzDeg, b.decoyAzDeg) : a.decoyAzDeg,
    decoyElDeg: a.decoyElDeg !== undefined && b.decoyElDeg !== undefined ? lerp(a.decoyElDeg, b.decoyElDeg) : a.decoyElDeg,
    immPCv: a.immPCv !== undefined && b.immPCv !== undefined ? lerp(a.immPCv, b.immPCv) : a.immPCv,
    immPCa: a.immPCa !== undefined && b.immPCa !== undefined ? lerp(a.immPCa, b.immPCa) : a.immPCa,
    immPCt: a.immPCt !== undefined && b.immPCt !== undefined ? lerp(a.immPCt, b.immPCt) : a.immPCt,
    fuzePk: a.fuzePk !== undefined && b.fuzePk !== undefined ? lerp(a.fuzePk, b.fuzePk) : a.fuzePk,
  };
}

/** Linear sampler over the target trajectory samples. */
export function targetSampleAt(time: number): Sample | null {
  const tel = cache;
  if (!tel || tel.targetSamples.length === 0) return null;
  const arr = tel.targetSamples;
  const t = Math.max(arr[0].t, Math.min(arr[arr.length - 1].t, time));
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = arr[lo];
  const b = arr[hi];
  const span = b.t - a.t || 1;
  const k = Math.max(0, Math.min(1, (t - a.t) / span));
  const lerp = (x: number, y: number) => x + (y - x) * k;
  return {
    ...a,
    t,
    position: {
      x: lerp(a.position.x, b.position.x),
      y: lerp(a.position.y, b.position.y),
      z: lerp(a.position.z, b.position.z),
    },
    velocity: {
      x: lerp(a.velocity.x, b.velocity.x),
      y: lerp(a.velocity.y, b.velocity.y),
      z: lerp(a.velocity.z, b.velocity.z),
    },
    attitude: slerp(a.attitude, b.attitude, k),
    latDeg: lerp(a.latDeg, b.latDeg),
    lonDeg: lerp(a.lonDeg, b.lonDeg),
    altM: lerp(a.altM, b.altM),
    speedMS: lerp(a.speedMS, b.speedMS),
    rangeM: lerp(a.rangeM, b.rangeM),
  };
}

export function getTelemetry(): Telemetry | null {
  return cache;
}

/**
 * Swap the active telemetry source (recorded payload <-> solved engagement).
 * `sampleAt` and friends read `cache`, so both the module cache and the store
 * have to be replaced together.
 */
export function replaceTelemetry(tel: Telemetry | null): void {
  cache = tel;
  boosterSepT = null;
  useApp.getState().setTelemetry(tel);
}

export function phaseAt(time: number): PhaseSegment | null {
  const tel = cache;
  if (!tel) return null;
  return tel.phases.find((p) => time >= p.startT && time <= p.endT) ?? tel.phases[tel.phases.length - 1] ?? null;
}

export async function loadTelemetry(): Promise<Telemetry> {
  if (cache) {
    useApp.getState().setTelemetry(cache);
    return cache;
  }
  const { setDataStatus, setTelemetry, setDataTime } = useApp.getState();
  setDataStatus("loading");
  try {
    const url = `${import.meta.env.BASE_URL}data/scenario.json?v=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`scenario ${res.status}`);
    const raw = await res.json();
    const missile = raw.entities.find((e: { kind: string }) => e.kind === "missile");
    const target = raw.entities.find((e: { kind: string }) => e.kind === "target");
    cache = null;
    boosterSepT = null;
    const tel: Telemetry = {
      title: raw.title,
      subtitle: raw.subtitle,
      start: raw.time.startS,
      end: raw.time.endS,
      demoUtc: raw.time.demoUtc,
      samples: missile.samples,
      targetSamples: target?.samples ?? [],
      events: raw.events,
      phases: raw.phases,
      metrics: raw.metrics,
      entityLabel: missile.id,
      manifest: raw,
    };
    cache = tel;
    // Surface the derived burnout as a first-stage separation milestone.
    const sepT = boosterSeparationTime();
    if (sepT !== null && !tel.events.some((e) => e.kind === "stage")) {
      tel.events = [
        ...tel.events,
        {
          id: "booster-sep",
          t: sepT,
          label: "BOOSTER SEP",
          description:
            "First-stage burnout and separation. Derived from the payload mass curve; the source does not record a discrete stage event.",
          kind: "stage",
          severity: "major",
        },
      ].sort((a, b) => a.t - b.t);
    }
    dataClock.t = tel.start;
    dataClock.playing = false;
    dataClock.rate = 20;
    setTelemetry(tel);
    setDataTime(tel.start);
    setDataStatus("ready");
    return tel;
  } catch (err) {
    setDataStatus("error");
    throw err;
  }
}

function slerp(a: Quat, b: Quat, k: number): Quat {
  let cos = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  let bb = b;
  if (cos < 0) {
    cos = -cos;
    bb = { w: -b.w, x: -b.x, y: -b.y, z: -b.z };
  }
  if (cos > 0.9995) {
    const w = a.w + (bb.w - a.w) * k;
    const x = a.x + (bb.x - a.x) * k;
    const y = a.y + (bb.y - a.y) * k;
    const z = a.z + (bb.z - a.z) * k;
    const n = Math.hypot(w, x, y, z) || 1;
    return { w: w / n, x: x / n, y: y / n, z: z / n };
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const s0 = Math.sin((1 - k) * theta) / sin;
  const s1 = Math.sin(k * theta) / sin;
  return {
    w: a.w * s0 + bb.w * s1,
    x: a.x * s0 + bb.x * s1,
    y: a.y * s0 + bb.y * s1,
    z: a.z * s0 + bb.z * s1,
  };
}

export function seekDataTime(value: number, pause = true): void {
  const tel = cache;
  const t = tel ? Math.max(tel.start, Math.min(tel.end, value)) : value;
  dataClock.t = t;
  if (pause) dataClock.playing = false;
  const state = useApp.getState();
  state.setDataTime(t);
  state.setDataPlaying(dataClock.playing);
}

export function toggleDataPlay(): void {
  const tel = cache;
  if (!tel) return;
  if (!dataClock.playing && dataClock.t >= tel.end - 0.01) dataClock.t = tel.start;
  dataClock.playing = !dataClock.playing;
  useApp.getState().setDataPlaying(dataClock.playing);
  if (dataClock.playing) useApp.getState().setDataTime(dataClock.t);
}

export function cycleDataRate(): number {
  const rates = [0.1, 1, 5, 20, 60];
  const idx = rates.indexOf(dataClock.rate);
  const next = rates[(idx + 1) % rates.length];
  dataClock.rate = next;
  useApp.getState().setDataRate(next);
  return next;
}

export function formatMissionTime(t: number): string {  const total = Math.max(0, Math.round(t));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `T+${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatClock(t: number): string {
  const total = Math.max(0, t);
  return `00:${String(Math.floor(total)).padStart(2, "0")}.${String(Math.floor((total % 1) * 10))}`;
}
