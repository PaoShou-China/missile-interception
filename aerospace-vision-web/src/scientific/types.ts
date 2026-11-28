/**
 * Aerospace Vision Web — frozen public data contracts (G0 interface freeze).
 *
 * Conventions (do not change without a version bump in ScenarioManifest):
 * - Frames:  ECEF = WGS84 Earth-Centered Earth-Fixed, right-handed, metres.
 *            BODY = vehicle body frame, x forward, z down (aerospace convention).
 * - Time:    seconds since launch (t = 0 at launch), monotonic.
 * - Angles:  stored in degrees for display fields; rad where suffixed.
 * - Quats:   scalar-first [w, x, y, z], unit length, rotating BODY -> ECEF.
 * - Lengths: SI metres in the payload; renderer converts to kilometres.
 */

export const SCHEMA_VERSION = "1.1.0";

export type Phase = "boost" | "midcourse" | "terminal" | "coast";

export interface Vector3Tuple {
  x: number;
  y: number;
  z: number;
}

export interface QuaternionTuple {
  w: number;
  x: number;
  y: number;
  z: number;
}

/** Four independent control-surface deflections, radians, relative to trim. */
export interface FinDeflectionsRad {
  up: number;
  down: number;
  left: number;
  right: number;
}

/** Body angular rates about body x (p), y (q) and z (r), rad/s. */
export interface BodyRatesRadS {
  p: number;
  q: number;
  r: number;
}

/** One time-stamped state of a scene entity. All values are SI. */
export interface TrajectorySample {
  /** Simulation time, seconds since launch. */
  t: number;
  /** ECEF position, metres. */
  position: Vector3Tuple;
  /** ECEF velocity, m/s. */
  velocity: Vector3Tuple;
  /** Unit quaternion, scalar-first, BODY -> ECEF. */
  attitude: QuaternionTuple;
  /** Geodetic latitude, degrees (WGS84). */
  latDeg: number;
  /** Geodetic longitude, degrees east (WGS84). */
  lonDeg: number;
  /** Geodetic height above WGS84 ellipsoid, metres. */
  altM: number;
  /** Speed relative to ECEF, m/s. */
  speedMS: number;
  /** Mach number (dimensionless). */
  mach: number;
  /** Dynamic pressure, Pa. */
  qPa: number;
  /** Achieved body-axis load factor, g. */
  loadG: number;
  /** Commanded load factor, g. */
  loadCmdG: number;
  /** Vehicle mass, kg. */
  massKg: number;
  /** Seeker off-boresight angle, degrees. */
  fovDeg: number;
  /** Slant range to target, m. */
  rangeM: number;
  /** Mission phase at this sample. */
  phase: Phase;
  /** Seeker lock flag. */
  seekerLock: boolean;
  /** Terminal handover flag. */
  handover: boolean;
  /** Recorded fin deflections (rad). Absent on static target samples. */
  finDeflectionsRad?: FinDeflectionsRad;
  /** Recorded body angular rates (rad/s). Absent on static target samples. */
  bodyRatesRadS?: BodyRatesRadS;
  /** Sutton-Graves cold-wall stagnation heat flux (MW/m^2). */
  heatFluxMWm2?: number;
  /** Hot-wall radiative equilibrium nose temperature (K). */
  wallTempK?: number;
  /** Target aspect angle seen from missile (deg, 0=nose, 90=beam, 180=tail). */
  aspectDeg?: number;
  /** Aspect-dependent target monostatic X-band RCS (m^2). */
  targetRcsM2?: number;
  /** X-band pulse-Doppler radar SNR (dB). */
  radarSnrDb?: number;
  /** MWIR imaging-IR channel SNR (dB). */
  irSnrDb?: number;
  /** Seeker LOS azimuth in missile body frame (deg, +right). */
  seekerAzDeg?: number;
  /** Seeker LOS elevation in missile body frame (deg, +up). */
  seekerElDeg?: number;
  /** Steady-state radiative equilibrium wall temperature (K) for lag comparison. */
  wallTempEqK?: number;
  /** Scramjet inlet unstart hysteresis flag (0 or 1). */
  unstartFlag?: number;
  /** Stage-1 discrete separation flag (0 or 1). */
  stageSep?: number;
  /** Instantaneous CG station from nose (m). */
  cgPos?: number;
  /** Instantaneous aerodynamic centre CP station from nose (m). */
  cpPos?: number;
  /** Body-axis aerodynamic + thrust forces (N). */
  bodyForceX?: number;
  bodyForceY?: number;
  bodyForceZ?: number;
  /** Terminal countermeasure decoy active flag and seeker body angles. */
  decoyActive?: number;
  decoyAzDeg?: number;
  decoyElDeg?: number;
  /** IMM mode probabilities (CV, CA, 3D CT). */
  immPCv?: number;
  immPCa?: number;
  immPCt?: number;
  /** Directed fragmentation proximity-fuze lethality estimate. */
  fuzePk?: number;
}

/** Declared provenance of the experiment that produced the telemetry. */
export interface ExperimentManifest {
  /** This platform only replays simulations; never flight-test data. */
  kind: "simulation";
  name: string;
  purpose: string;
  engine: string;
  /** Source sampling step, seconds. */
  dtS: number;
  dispersion: {
    launchCepM: number | null;
    targetCepM: number | null;
    altitudeSigmaM: number | null;
    machSigma: number | null;
    maneuverSigmaG: number | null;
    note: string;
  };
  /** Whether the cited artifacts can be rebuilt from the current workspace. */
  reproducibility: "reproducible" | "unreproducible-current-artifacts";
  notes: string[];
}

export interface SceneEntity {
  id: string;
  label: string;
  /** Source of the entity state; "telemetry" = measured/validated data. */
  kind: "missile" | "target" | "payload";
  color: string;
  /** A single sample for static entities. */
  staticSample?: TrajectorySample;
  /** Time-series samples for dynamic entities. */
  samples?: TrajectorySample[];
}

export interface ScientificObservable {
  key: string;
  label: string;
  unit: string;
  /** Short scientific note shown in the UI. */
  description: string;
  precision: number;
}

export interface VisualizationEvent {
  id: string;
  t: number;
  label: string;
  description: string;
  kind: "launch" | "phase" | "lock" | "handover" | "intercept" | "peak" | "separation" | "anomaly" | "countermeasure" | "custom";
  severity: "info" | "major" | "critical";
}

export interface PhaseSegment {
  phase: Phase;
  startT: number;
  endT: number;
  label: string;
}

export interface ScenarioSource {
  title: string;
  repository: string;
  commit: string;
  telemetryFile: string;
  telemetryRows: number;
  /** SHA-256 of the source telemetry file. */
  sha256?: string;
  generatedAt: string;
  generator: string;
  license: string;
}

export interface ValidationCheck {
  id: string;
  description: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface ScenarioManifest {
  schemaVersion: string;
  id: string;
  title: string;
  subtitle: string;
  description: string;
  /** Reference ellipsoid constants used by the source simulation. */
  earth: {
    model: "wgs84" | "sphere";
    semiMajorAxisM: number;
    flattening: number;
    omegaRadS: number;
    muM3S2: number;
  };
  /** master time axis metadata. */
  time: {
    startS: number;
    endS: number;
    sampleCount: number;
    /** nominal decimation of the source telemetry (source rows per sample). */
    sourceRows: number;
    sourceStepS: number;
    /**
     * Declared demonstration epoch (ISO-8601 UTC) used only to place the sun
     * and moon. It is fixed so every viewer sees the same sky; it is not a
     * measured launch time.
     */
    demoUtc: string;
  };
  frames: {
    render: "ECEF";
    eciToEcef: string;
    quaternion: string;
    bodyAxes: string;
  };
  source: ScenarioSource;
  experiment: ExperimentManifest;
  metrics: {
    missDistanceM: number;
    interceptTimeS: number;
    maxSpeedMS: number;
    maxMach: number;
    maxDynamicPressurePa: number;
    maxLoadG: number;
    maxAltitudeM: number;
    downrangeKM: number;
    fuelUsedKg: number;
    handoverTimeS: number | null;
    flightDurationS: number;
    killProbability?: number;
    fuzePk?: number;
    maxHeatFluxMWm2?: number;
    maxWallTempK?: number;
    missBudget?: {
      source: string;
      nominal: Record<string, number>;
    };
  };
  launchSite: { latDeg: number; lonDeg: number; altM: number; label: string };
  targetSite: { latDeg: number; lonDeg: number; altM: number; label: string };
  phases: PhaseSegment[];
  events: VisualizationEvent[];
  observables: ScientificObservable[];
  entities: SceneEntity[];
  validation: {
    status: "PASS" | "FAIL" | "NOT RUN";
    checks: ValidationCheck[];
  };
}
