import * as THREE from "three";
import type { Quat, Vec3 } from "../data/telemetry";

/**
 * Recorded attitude is BODY -> ECEF. The scene lives in a local frame whose
 * x points east, y up and z south, so the quaternion is re-expressed as
 * BODY -> ENU -> scene. Shared by the interceptor and the target.
 *
 * The two vehicles do NOT share a body convention:
 *  - the interceptor telemetry uses the standard body frame (x forward,
 *    y right, z down), while
 *  - the target attitude is derived from velocity by the data adapter with
 *    z as the "up" reference (x forward, y left, z up).
 * The exported GLB is x forward, y up, z right, so each needs its own fixed
 * roll offset before the recorded quaternion can drive the model. Missing this
 * is what made the strakes stand vertical in level flight.
 */
const DEG = Math.PI / 180;
const enu = new THREE.Matrix4();
const sceneFromEnu = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 1, 0),
);
const rot = new THREE.Matrix4();
const body = new THREE.Matrix4();
const bodyQuat = new THREE.Quaternion();

/** NED body (y right, z down) -> glTF body (y up, z right). */
const MODEL_TO_BODY_NED = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
/** z-up body (y left, z up) -> glTF body (y up, z right). */
const MODEL_TO_BODY_ZUP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

export type AttitudeFrame = "ned" | "zup";

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const ALT_UP = new THREE.Vector3(0, 0, 1);
const tmpX = new THREE.Vector3();
const tmpY = new THREE.Vector3();
const tmpZ = new THREE.Vector3();
const basis = new THREE.Matrix4();

export function attitudeToScene(
  attitude: Quat,
  latDeg: number,
  lonDeg: number,
  out: THREE.Quaternion,
  frame: AttitudeFrame = "ned",
) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const so = Math.sin(lon), co = Math.cos(lon);
  enu.makeBasis(
    new THREE.Vector3(-so, co, 0),
    new THREE.Vector3(-sl * co, -sl * so, cl),
    new THREE.Vector3(cl * co, cl * so, sl),
  );
  rot.copy(enu).transpose(); // ECEF -> ENU
  body.makeRotationFromQuaternion(bodyQuat.set(attitude.x, attitude.y, attitude.z, attitude.w));
  rot
    .premultiply(sceneFromEnu)
    .multiply(body)
    .multiply(frame === "ned" ? MODEL_TO_BODY_NED : MODEL_TO_BODY_ZUP);
  out.setFromRotationMatrix(rot);
  return out;
}

/**
 * Wings-level attitude with the body x axis along ``nose``. Used when the
 * recorded roll channel is not usable (see `Sample.attitudeAliased`).
 */
export function levelFromNose(nose: THREE.Vector3, out: THREE.Quaternion) {
  tmpX.copy(nose).normalize();
  const ref = Math.abs(tmpX.dot(UP_AXIS)) > 0.97 ? ALT_UP : UP_AXIS;
  tmpY.copy(ref).addScaledVector(tmpX, -ref.dot(tmpX)).normalize();
  tmpZ.crossVectors(tmpX, tmpY);
  basis.makeBasis(tmpX, tmpY, tmpZ);
  out.setFromRotationMatrix(basis);
  return out;
}

/** ECEF direction -> the scene frame (x east, y up, z south). */
export function directionEcefToScene(v: Vec3, latDeg: number, lonDeg: number, out: THREE.Vector3) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const so = Math.sin(lon), co = Math.cos(lon);
  const east = v.x * -so + v.y * co;
  const north = v.x * -sl * co + v.y * -sl * so + v.z * cl;
  const up = v.x * cl * co + v.y * cl * so + v.z * sl;
  out.set(east, up, -north);
  return out;
}
