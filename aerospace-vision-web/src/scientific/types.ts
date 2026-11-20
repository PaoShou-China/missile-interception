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

export const SCHEMA_VERSION = "1.0.0";

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
  kind: "launch" | "phase" | "lock" | "handover" | "intercept" | "peak" | "custom";
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
  };
  frames: {
    render: "ECEF";
    eciToEcef: string;
    quaternion: string;
    bodyAxes: string;
  };
  source: ScenarioSource;
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
