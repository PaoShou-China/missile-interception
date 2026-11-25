import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useApp } from "../state";
import { dataClock, getTelemetry, sampleAt } from "../data/telemetry";
import { attitudeToScene } from "./attitude";
import { sampleTarget, targetLocalAt } from "./intercept";

/**
 * The validated payload carries a target entity (lat/lon/alt and attitude), so
 * the intercept is drawn as a real airframe with a tracking reticle and a line
 * of sight. The reticle is a sensor cue that stays visible even when the target
 * is beyond the horizon; the 3D body takes over in the closing kilometres.
 */
function markerTexture(): THREE.CanvasTexture {
  const size = 160;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  // Four corner brackets read as a sensor track box.
  const arm = 34;
  const inset = 46;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const x = c + sx * inset;
    const y = c + sy * inset;
    ctx.beginPath();
    ctx.moveTo(x - sx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y - sy * arm);
    ctx.stroke();
  }
  // Centre pip.
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(c, c, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(c, c - 14);
  ctx.lineTo(c, c - 8);
  ctx.moveTo(c, c + 8);
  ctx.lineTo(c, c + 14);
  ctx.moveTo(c - 14, c);
  ctx.lineTo(c - 8, c);
  ctx.moveTo(c + 8, c);
  ctx.lineTo(c + 14, c);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A 7 m target airframe: wing kit, twin tail and a lit nose for visibility. */
function buildVehicle() {
  const skin = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.4, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3d454e, metalness: 0.4, roughness: 0.55 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xffb25c, emissive: new THREE.Color("#ff7a2a"), emissiveIntensity: 2.2 });
  const vehicle = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    vehicle.add(mesh);
    return mesh;
  };
  // Fuselage (nose along +x).
  const body = new THREE.CylinderGeometry(0.44, 0.44, 5.2, 16);
  body.rotateZ(-Math.PI / 2);
  add(body, skin, -0.3, 0, 0);
  const nose = new THREE.ConeGeometry(0.44, 1.7, 16);
  nose.rotateZ(-Math.PI / 2);
  add(nose, skin, 3.15, 0, 0);
  const tail = new THREE.CylinderGeometry(0.44, 0.32, 0.9, 16);
  tail.rotateZ(-Math.PI / 2);
  add(tail, dark, -3.35, 0, 0);
  // Main wings (6.6 m span) and tailplane.
  add(new THREE.BoxGeometry(1.15, 0.07, 6.6), skin, 0.35, 0.02, 0);
  add(new THREE.BoxGeometry(0.7, 0.05, 2.6), dark, -2.65, 0, 0);
  // Twin canted fins.
  const finL = new THREE.BoxGeometry(0.75, 1.05, 0.06);
  const finR = finL.clone();
  const a = add(finL, dark, -2.6, 0.5, 0.32);
  a.rotation.x = -0.28;
  const b = add(finR, dark, -2.6, 0.5, -0.32);
  b.rotation.x = 0.28;
  // Nav light at the nose so a distant target still reads as an object.
  add(new THREE.SphereGeometry(0.12, 10, 8), glow, 3.9, 0, 0);
  return { vehicle, materials: [skin, dark, glow] as THREE.Material[] };
}

export function TargetTrack() {
  const telemetry = useApp((s) => s.telemetry);
  const dataStatus = useApp((s) => s.dataStatus);

  const objects = useMemo(() => {
    const tex = markerTexture();
    const spriteMat = new THREE.SpriteMaterial({
      map: tex,
      color: 0x9ff3ff,
      transparent: true,
      depthWrite: false,
      // The target is often beyond the horizon; a sensor cue still tracks it.
      depthTest: false,
    });
    const spriteObj = new THREE.Sprite(spriteMat);
    spriteObj.frustumCulled = false;
    spriteObj.renderOrder = 8;

    const { vehicle, materials } = buildVehicle();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const losMat = new THREE.LineDashedMaterial({
      color: 0x8ff3ff,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      dashSize: 1,
      gapSize: 0.6,
    });
    const losObj = new THREE.Line(geo, losMat);
    losObj.frustumCulled = false;
    losObj.renderOrder = 2;
    return { tex, spriteObj, losObj, geo, losMat, vehicle, materials };
  }, []);

  useEffect(
    () => () => {
      objects.tex.dispose();
      objects.geo.dispose();
      objects.losMat.dispose();
      for (const m of objects.materials) m.dispose();
      objects.vehicle.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      (objects.spriteObj.material as THREE.SpriteMaterial).dispose();
    },
    [objects],
  );

  const targetQuat = useMemo(() => new THREE.Quaternion(), []);
  const local = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (dataStatus !== "ready") return;
    const tel = getTelemetry();
    if (!tel) return;
    const dist = targetLocalAt(dataClock.t, local);
    if (dist === null) return;

    objects.vehicle.position.copy(local);
    const target = sampleTarget(tel.targetSamples, dataClock.t);
    const cur = sampleAt(dataClock.t);
    if (target && cur) {
      attitudeToScene(target.attitude, target.latDeg, target.lonDeg, targetQuat);
      objects.vehicle.quaternion.copy(targetQuat);
    }

    objects.spriteObj.position.copy(local);
    // Constant apparent size so the track box is readable at any range.
    const scale = Math.max(1, dist) * 0.045;
    objects.spriteObj.scale.set(scale, scale, 1);
    const spriteMat = objects.spriteObj.material as THREE.SpriteMaterial;
    // Hand over from the reticle to the airframe in the closing metres, and keep
    // the cue visible while the seeker has lock.
    spriteMat.opacity = THREE.MathUtils.clamp((dist - 220) / 520, 0, 1);
    // The reticle is sized for the missile-anchored cameras; in the target
    // tracking shot the camera sits ~25 m away, where a 0.045*dist quad would
    // swallow the whole frame. The airframe itself is already in close-up.
    const camMode = useApp.getState().cameraMode;
    objects.spriteObj.visible = camMode !== "target" && spriteMat.opacity > 0.02;
    spriteMat.color.set(cur?.seekerLock ? 0xffc46a : 0x9ff3ff);

    const pos = objects.geo.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, 0, 0, 0);
    pos.setXYZ(1, local.x, local.y, local.z);
    pos.needsUpdate = true;
    objects.geo.computeBoundingSphere();
    objects.losObj.computeLineDistances();
    objects.losMat.dashSize = Math.max(400, dist * 0.006);
    objects.losMat.gapSize = Math.max(260, dist * 0.004);
    objects.losObj.visible = useApp.getState().showTrajectory;
  });

  if (!telemetry || telemetry.targetSamples.length === 0) return null;

  return (
    <group>
      <primitive object={objects.vehicle} />
      <primitive object={objects.spriteObj} />
      <primitive object={objects.losObj} />
    </group>
  );
}
