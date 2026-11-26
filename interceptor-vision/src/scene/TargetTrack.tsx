import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useApp } from "../state";
import { dataClock, getTelemetry, sampleAt } from "../data/telemetry";
import { directionEcefToScene, levelFromNose } from "./attitude";
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

/**
 * Lofts an elliptical (superelliptic) fuselage through the given stations.
 * Stations are ordered nose -> tail; x is the body axis, y the height centre,
 * w/h the half width/height. Chined cross-sections are what give the F-35 its
 * faceted forebody rather than a tube with a cone on the front.
 */
function loftGeometry(
  stations: { x: number; w: number; h: number; y: number }[],
  seg = 20,
) {
  const pos: number[] = [];
  const idx: number[] = [];
  const e = 2 / 3.1;
  for (const st of stations) {
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const sx = Math.sign(c) * Math.pow(Math.abs(c), e);
      const sy = Math.sign(s) * Math.pow(Math.abs(s), e);
      pos.push(st.x, st.y + st.h * sy, st.w * sx);
    }
  }
  for (let r = 0; r < stations.length - 1; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * seg + i;
      const b = r * seg + ((i + 1) % seg);
      const c = (r + 1) * seg + i;
      const d = (r + 1) * seg + ((i + 1) % seg);
      idx.push(a, c, b, b, c, d);
    }
  }
  const tip = pos.length / 3;
  pos.push(stations[0].x - 0.03, stations[0].y, 0);
  for (let i = 0; i < seg; i++) idx.push(tip, i, (i + 1) % seg);
  const lastRing = (stations.length - 1) * seg;
  const last = stations[stations.length - 1];
  const end = pos.length / 3;
  pos.push(last.x + 0.02, last.y, 0);
  for (let i = 0; i < seg; i++) idx.push(end, lastRing + ((i + 1) % seg), lastRing + i);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Extrudes a planform defined in (x, span) into a thin lifting surface. */
function planeGeometry(points: [number, number][], thickness: number) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, thickness / 2, 0);
  return geo;
}

/** Extrudes a side profile (x, height) into a thin vertical surface. */
function plateGeometry(points: [number, number][], thickness: number) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.translate(0, 0, -thickness / 2);
  return geo;
}

/**
 * A ~15.7 m F-35A silhouette: blended chined fuselage, clipped delta wing,
 * canted twin vertical tails, all-moving horizontal stabs, DSI inlets and a
 * bubble canopy. Origin is the airframe centre, nose along +x, up +y.
 */
function buildVehicle() {
  const skin = new THREE.MeshStandardMaterial({
    color: 0x4e565e,
    metalness: 0.22,
    roughness: 0.78,
    envMapIntensity: 0.34,
    side: THREE.DoubleSide,
  });
  const panel = new THREE.MeshStandardMaterial({
    color: 0x474e56,
    metalness: 0.28,
    roughness: 0.7,
    envMapIntensity: 0.4,
    side: THREE.DoubleSide,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x3a4046,
    metalness: 0.45,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x1c252e,
    metalness: 0.85,
    roughness: 0.18,
    side: THREE.DoubleSide,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: 0xff9a4a,
    emissive: new THREE.Color("#ff6a1e"),
    emissiveIntensity: 0.9,
    side: THREE.DoubleSide,
  });

  const vehicle = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    vehicle.add(mesh);
    return mesh;
  };

  // Fuselage: radome, chined forebody, broad mid-body, boat-tail.
  add(
    loftGeometry([
      { x: 7.7, w: 0.05, h: 0.05, y: 0.02 },
      { x: 7.15, w: 0.26, h: 0.26, y: 0.02 },
      { x: 6.3, w: 0.45, h: 0.42, y: 0.03 },
      { x: 5.1, w: 0.62, h: 0.52, y: 0.05 },
      { x: 3.8, w: 0.78, h: 0.58, y: 0.06 },
      { x: 2.2, w: 0.92, h: 0.6, y: 0.06 },
      { x: 0.6, w: 0.98, h: 0.59, y: 0.05 },
      { x: -1.2, w: 0.97, h: 0.56, y: 0.03 },
      { x: -3.0, w: 0.88, h: 0.52, y: 0.01 },
      { x: -4.8, w: 0.76, h: 0.47, y: 0 },
      { x: -6.2, w: 0.6, h: 0.43, y: 0 },
      { x: -7.2, w: 0.48, h: 0.4, y: 0 },
      { x: -7.75, w: 0.44, h: 0.38, y: 0 },
    ]),
    skin,
  );

  // Radome: slightly darker cap over the first two stations.
  const radome = loftGeometry([
    { x: 7.7, w: 0.052, h: 0.052, y: 0.02 },
    { x: 7.15, w: 0.265, h: 0.265, y: 0.02 },
    { x: 6.45, w: 0.43, h: 0.4, y: 0.03 },
  ]);
  radome.scale(1, 1.015, 1.015);
  add(radome, dark);

  // Bubble canopy, set slightly forward of the wing root.
  const canopy = add(new THREE.SphereGeometry(1, 24, 16), glass, 3.6, 0.52, 0);
  canopy.scale.set(2.05, 0.5, 0.55);

  // Clipped delta wing: 35 deg leading edge, 10.7 m span.
  const wing = planeGeometry(
    [
      [1.8, 0.0],
      [-1.2, 5.3],
      [-2.4, 5.3],
      [-3.0, 0.0],
    ],
    0.32,
  );
  const wingR = add(wing, skin, 0, 0.03, 0);
  const wingL = add(wing.clone(), skin, 0, 0.03, 0);
  wingL.scale.z = -1;
  void wingR;

  // Leading-edge flaps and the darker wing root fairing.
  const flap = planeGeometry(
    [
      [0.4, 2.1],
      [-1.2, 5.26],
      [-1.75, 5.26],
      [-0.35, 2.1],
    ],
    0.06,
  );
  add(flap, panel, 0, 0.15, 0);
  const flapL = add(flap.clone(), panel, 0, 0.15, 0);
  flapL.scale.z = -1;

  // Canted twin vertical tails (25 deg outboard).
  const fin = plateGeometry(
    [
      [-2.4, 0.0],
      [-3.95, 2.15],
      [-4.85, 2.15],
      [-5.05, 0.0],
    ],
    0.12,
  );
  const finR = add(fin, skin, 0, 0.34, 1.15);
  finR.rotation.x = -0.6;
  const finL = add(fin.clone(), skin, 0, 0.34, -1.15);
  finL.rotation.x = 0.6;

  // All-moving horizontal stabilators.
  const stab = planeGeometry(
    [
      [-3.55, 0.0],
      [-4.75, 2.15],
      [-5.35, 2.15],
      [-5.5, 0.0],
    ],
    0.14,
  );
  add(stab, skin, 0, -0.02, 0.5);
  const stabL = add(stab.clone(), skin, 0, -0.02, -0.5);
  stabL.scale.z = -1;

  // DSI inlets and their bumps, plus the chin sensor fairing.
  for (const side of [1, -1]) {
    const inlet = add(new THREE.BoxGeometry(1.7, 0.5, 0.34), panel, 1.35, -0.3, side * 1.0);
    inlet.rotation.y = side * 0.06;
    const bump = add(new THREE.SphereGeometry(1, 12, 10), skin, 0.8, -0.2, side * 0.86);
    bump.scale.set(0.5, 0.24, 0.22);
  }
  const chin = add(new THREE.SphereGeometry(1, 12, 10), dark, 5.4, -0.34, 0);
  chin.scale.set(0.5, 0.18, 0.26);

  // Exhaust: nozzle ring and a dim afterburner disc, kept low-key so it does
  // not read as a toy rocket from the tracking shot.
  // Exhaust: a recessed nozzle with a dim burner disc, kept small so it does
  // not read as a rocket engine from the tracking shot.
  const nozzle = add(new THREE.CylinderGeometry(0.38, 0.44, 0.85, 20), panel, -7.6, 0, 0);
  nozzle.rotation.z = Math.PI / 2;
  const nozzleLip = add(new THREE.TorusGeometry(0.4, 0.05, 8, 22), dark, -8.02, 0, 0);
  nozzleLip.rotation.y = Math.PI / 2;
  const flame = add(new THREE.CircleGeometry(0.16, 18), glow, -8.0, 0, 0);
  flame.rotation.y = -Math.PI / 2;

  return { vehicle, materials: [skin, panel, dark, glass, glow] as THREE.Material[] };
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
  const nose = useMemo(() => new THREE.Vector3(), []);
  const local = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (dataStatus !== "ready") return;
    const tel = getTelemetry();
    if (!tel) return;
    const dist = targetLocalAt(dataClock.t, local);
    if (dist === null || !Number.isFinite(local.x) || !Number.isFinite(local.y) || !Number.isFinite(local.z)) {
      return;
    }

    objects.vehicle.position.copy(local);
    const target = sampleTarget(tel.targetSamples, dataClock.t);
    if (target) {
      // The payload's target attitude is derived from its velocity with an
      // Earth-fixed "up" reference, which leaves the wings tilted. Rebuild it
      // from the recorded velocity so the aircraft flies wings-level.
      directionEcefToScene(target.velocity, target.latDeg, target.lonDeg, nose);
      if (nose.lengthSq() > 1) {
        levelFromNose(nose, targetQuat);
        objects.vehicle.quaternion.copy(targetQuat);
      }
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
    spriteMat.color.set(sampleAt(dataClock.t)?.seekerLock ? 0xffc46a : 0x9ff3ff);

    const pos = objects.geo.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, 0, 0, 0);
    pos.setXYZ(1, local.x, local.y, local.z);
    pos.needsUpdate = true;
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
