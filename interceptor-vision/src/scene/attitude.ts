import * as THREE from "three";
import type { Quat } from "../data/telemetry";

/**
 * Recorded attitude is BODY -> ECEF. The scene lives in a local frame whose
 * x points east, y up and z south, so the quaternion is re-expressed as
 * BODY -> ENU -> scene. Shared by the interceptor and the target.
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

export function attitudeToScene(attitude: Quat, latDeg: number, lonDeg: number, out: THREE.Quaternion) {
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
  rot.premultiply(sceneFromEnu).multiply(body);
  out.setFromRotationMatrix(rot);
  return out;
}
