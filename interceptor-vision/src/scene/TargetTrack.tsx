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

const AB_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const AB_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    float axial = clamp(vUv.y, 0.0, 1.0);
    float dist = 1.0 - axial;
    float core = pow(abs(dot(normalize(vNormalView), normalize(vViewDir))), 0.65);
    float shock = pow(0.5 + 0.5 * sin(dist * 24.0 - uTime * 36.0), 4.0) * axial;
    vec3 cOuter = vec3(0.95, 0.36, 0.08);
    vec3 cInner = vec3(1.0, 0.86, 0.56);
    vec3 cShock = vec3(0.68, 0.85, 1.0);
    vec3 col = mix(cOuter, cInner, smoothstep(0.15, 0.92, axial));
    col = mix(col, cShock, shock * 0.55);
    float alpha = clamp((pow(axial, 1.5) * (0.42 + 0.58 * core) + shock * 0.38) * uIntensity, 0.0, 0.92);
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * A ~15.7 m F-35A Lightning II silhouette: chined blended Have-Glass V fuselage,
 * gold-tinted ITO frameless stealth canopy, swept caret DSI inlets, faceted EOTS
 * sapphire chin prism, clipped trapezoidal wing, canted twin vertical tails,
 * serrated 15-petal F135 nozzle + Mach-diamond afterburner and live IR flares.
 * Origin is the airframe centre, nose along +x, up +y.
 */
function buildVehicle() {
  const skin = new THREE.MeshStandardMaterial({
    color: 0x626b75,
    metalness: 0.36,
    roughness: 0.56,
    envMapIntensity: 0.72,
    side: THREE.DoubleSide,
  });
  const panel = new THREE.MeshStandardMaterial({
    color: 0x4b535c,
    metalness: 0.42,
    roughness: 0.52,
    envMapIntensity: 0.68,
    side: THREE.DoubleSide,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x2d333a,
    metalness: 0.62,
    roughness: 0.42,
    envMapIntensity: 0.9,
    side: THREE.DoubleSide,
  });
  // Gold-tinted ITO stealth radar-reflective frameless canopy glass
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x3b311d,
    metalness: 0.72,
    roughness: 0.08,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    emissive: new THREE.Color("#634616"),
    emissiveIntensity: 0.32,
    envMapIntensity: 1.75,
    side: THREE.DoubleSide,
  });
  const eotsGlass = new THREE.MeshPhysicalMaterial({
    color: 0x0d2133,
    metalness: 0.55,
    roughness: 0.08,
    clearcoat: 1.0,
    emissive: new THREE.Color("#1c6088"),
    emissiveIntensity: 0.35,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: 0xffa654,
    emissive: new THREE.Color("#ff6a1a"),
    emissiveIntensity: 1.8,
    side: THREE.DoubleSide,
  });
  const abMat = new THREE.ShaderMaterial({
    vertexShader: AB_VERT,
    fragmentShader: AB_FRAG,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 0.72 } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const navRed = new THREE.MeshBasicMaterial({ color: 0xff4646 });
  const navGreen = new THREE.MeshBasicMaterial({ color: 0x46ff9a });
  const flareMat = new THREE.MeshBasicMaterial({
    color: 0xfff0c2,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const flareHaloMat = new THREE.MeshBasicMaterial({
    color: 0xff7c24,
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
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

  // Fuselage: radome, chined forebody, broad mid-body, twin aft tail booms.
  add(
    loftGeometry(
      [
        { x: 7.75, w: 0.05, h: 0.04, y: 0.01 },
        { x: 7.15, w: 0.28, h: 0.24, y: 0.02 },
        { x: 6.3, w: 0.49, h: 0.42, y: 0.03 },
        { x: 5.1, w: 0.69, h: 0.52, y: 0.05 },
        { x: 3.8, w: 0.88, h: 0.61, y: 0.06 },
        { x: 2.2, w: 1.06, h: 0.67, y: 0.06 },
        { x: 0.6, w: 1.12, h: 0.67, y: 0.05 },
        { x: -1.2, w: 1.1, h: 0.64, y: 0.03 },
        { x: -3.0, w: 1.0, h: 0.59, y: 0.01 },
        { x: -4.8, w: 0.84, h: 0.53, y: 0 },
        { x: -6.2, w: 0.66, h: 0.48, y: 0 },
        { x: -7.2, w: 0.52, h: 0.44, y: 0 },
        { x: -7.75, w: 0.48, h: 0.43, y: 0 },
      ],
      24,
    ),
    skin,
  );

  // AN/APG-81 RAM radome cap with sawtooth seam tone.
  const radome = loftGeometry(
    [
      { x: 7.76, w: 0.052, h: 0.044, y: 0.01 },
      { x: 7.15, w: 0.285, h: 0.245, y: 0.02 },
      { x: 6.45, w: 0.46, h: 0.405, y: 0.03 },
    ],
    24,
  );
  radome.scale(1, 1.015, 1.015);
  add(radome, dark);

  // Gold-tinted ITO bubble canopy + dark titanium sill frame.
  const canopy = add(new THREE.SphereGeometry(1, 28, 18), glass, 3.55, 0.56, 0);
  canopy.scale.set(2.15, 0.52, 0.58);
  const sill = add(new THREE.TorusGeometry(1, 0.06, 8, 28), dark, 3.52, 0.48, 0);
  sill.rotation.x = Math.PI / 2;
  sill.scale.set(2.12, 0.60, 0.55);

  // Clipped trapezoidal stealth wing: 35 deg leading edge, 10.7 m span.
  const wing = planeGeometry(
    [
      [1.95, 0.0],
      [-1.35, 5.35],
      [-3.1, 5.35],
      [-4.0, 0.0],
    ],
    0.3,
  );
  add(wing, skin, 0, 0.03, 0);
  const wingL = add(wing.clone(), skin, 0, 0.03, 0);
  wingL.scale.z = -1;

  // Leading-edge RAM flaps & trailing-edge flaperon panels.
  const flap = planeGeometry(
    [
      [0.55, 2.05],
      [-1.32, 5.32],
      [-1.87, 5.32],
      [-0.02, 2.05],
    ],
    0.05,
  );
  add(flap, panel, 0, 0.165, 0);
  const flapL = add(flap.clone(), panel, 0, 0.165, 0);
  flapL.scale.z = -1;

  // Canted twin vertical tails (~31 deg outboard: +rotX tilts +y toward +z).
  const fin = plateGeometry(
    [
      [-3.1, 0.0],
      [-4.65, 2.55],
      [-5.55, 2.55],
      [-5.75, 0.0],
    ],
    0.11,
  );
  const finR = add(fin, skin, 0, 0.30, 0.92);
  finR.rotation.x = 0.54;
  const finL = add(fin.clone(), skin, 0, 0.30, -0.92);
  finL.rotation.x = -0.54;

  // All-moving horizontal stabilators.
  const stab = planeGeometry(
    [
      [-4.15, 0.0],
      [-5.35, 2.35],
      [-6.0, 2.35],
      [-6.15, 0.0],
    ],
    0.13,
  );
  add(stab, skin, 0, -0.04, 0.55);
  const stabL = add(stab.clone(), skin, 0, -0.04, -0.55);
  stabL.scale.z = -1;

  // Sculpted forward-swept DSI caret inlets + smooth compression bumps.
  const dsiShape = new THREE.Shape();
  dsiShape.moveTo(2.45, 0.14);
  dsiShape.lineTo(1.98, -0.34);
  dsiShape.lineTo(-0.35, -0.34);
  dsiShape.lineTo(-0.55, 0.18);
  dsiShape.closePath();
  const dsiCowlGeo = new THREE.ExtrudeGeometry(dsiShape, {
    depth: 0.42,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 2,
  });
  dsiCowlGeo.translate(0, 0, -0.21);
  dsiCowlGeo.computeVertexNormals();

  for (const side of [1, -1]) {
    const cowl = add(dsiCowlGeo.clone(), panel, 0.1, -0.14, side * 1.06);
    cowl.rotation.y = side * 0.07;
    // Recessed dark S-duct inlet face
    const duct = add(new THREE.BoxGeometry(0.05, 0.36, 0.30), dark, 2.28, -0.22, side * 1.12);
    duct.rotation.y = side * 0.07;
    duct.rotation.z = -0.32;
    // Smooth diverterless supersonic compression bump
    const bump = add(new THREE.SphereGeometry(1, 14, 10), skin, 1.98, -0.16, side * 0.94);
    bump.scale.set(0.56, 0.24, 0.22);
  }

  // Faceted sapphire EOTS chin prism under the forebody.
  const eotsBody = add(new THREE.OctahedronGeometry(0.28, 0), dark, 5.45, -0.36, 0);
  eotsBody.scale.set(1.65, 0.62, 0.88);
  const eotsWin = add(new THREE.OctahedronGeometry(0.18, 0), eotsGlass, 5.62, -0.40, 0);
  eotsWin.scale.set(1.25, 0.56, 0.72);

  // Wingtip navigation lights (port red -Z, starboard green +Z).
  add(new THREE.SphereGeometry(0.08, 8, 8), navGreen, -2.0, 0.04, 5.36);
  add(new THREE.SphereGeometry(0.08, 8, 8), navRed, -2.0, 0.04, -5.36);

  // 15-petal serrated F135 stealth exhaust nozzle + Mach-diamond afterburner.
  const nozzle = add(new THREE.CylinderGeometry(0.44, 0.48, 0.88, 24), dark, -7.56, 0, 0);
  nozzle.rotation.z = Math.PI / 2;
  const petalGeo = new THREE.ConeGeometry(0.095, 0.34, 4);
  petalGeo.rotateZ(Math.PI / 2);
  for (let i = 0; i < 15; i++) {
    const ang = (i / 15) * Math.PI * 2;
    const petal = add(
      petalGeo.clone(),
      i % 2 === 0 ? panel : dark,
      -8.04,
      Math.sin(ang) * 0.41,
      Math.cos(ang) * 0.41,
    );
    petal.rotation.x = ang;
  }
  const flameDisc = add(new THREE.CircleGeometry(0.32, 22), glow, -7.96, 0, 0);
  flameDisc.rotation.y = -Math.PI / 2;
  const abPlume = add(new THREE.CylinderGeometry(0.31, 0.05, 3.6, 22, 16, true), abMat, -9.85, 0, 0);
  abPlume.rotation.z = -Math.PI / 2;

  // Live 3D IR countermeasure flare orbs (activated when decoyActive > 0.5).
  const flaresGroup = new THREE.Group();
  flaresGroup.name = "f35-ir-flares";
  flaresGroup.visible = false;
  const flareNodes: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const f = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), flareMat);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.68, 10, 8), flareHaloMat);
    core.frustumCulled = false;
    halo.frustumCulled = false;
    f.add(core, halo);
    flaresGroup.add(f);
    flareNodes.push(f);
  }
  vehicle.add(flaresGroup);

  return {
    vehicle,
    abMat,
    abPlume,
    flaresGroup,
    flareNodes,
    materials: [
      skin,
      panel,
      dark,
      glass,
      eotsGlass,
      glow,
      abMat,
      navRed,
      navGreen,
      flareMat,
      flareHaloMat,
    ] as THREE.Material[],
  };
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

    const { vehicle, abMat, abPlume, flaresGroup, flareNodes, materials } = buildVehicle();

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
    return {
      tex,
      spriteObj,
      losObj,
      geo,
      losMat,
      vehicle,
      abMat,
      abPlume,
      flaresGroup,
      flareNodes,
      materials,
    };
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

  useFrame(({ clock }) => {
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

    // Animate F135 afterburner & terminal 3D IR countermeasure flare ejection.
    const missileSample = sampleAt(dataClock.t);
    const evading = dist < 16000;
    const tAnim = clock.elapsedTime;
    objects.abMat.uniforms.uTime.value = tAnim;
    objects.abMat.uniforms.uIntensity.value = evading ? 0.95 : 0.52;
    const abLen = (evading ? 1.28 : 0.72) * (1 + 0.04 * Math.sin(tAnim * 43));
    objects.abPlume.scale.set(1, abLen, 1);
    objects.abPlume.position.x = -8.02 - 1.8 * abLen;

    const decoyOn = (missileSample?.decoyActive ?? 0) > 0.5;
    objects.flaresGroup.visible = decoyOn;
    if (decoyOn) {
      for (let i = 0; i < objects.flareNodes.length; i++) {
        const node = objects.flareNodes[i];
        const age = ((dataClock.t * 1.45 + i * 0.31) % 1.8);
        const side = i % 2 === 0 ? 1 : -1;
        const back = 2.8 + 16.0 * age + 4.5 * age * age;
        const drop = 1.1 + 5.2 * age + 3.4 * age * age;
        const lat = side * (1.2 + 4.6 * age + 0.6 * Math.sin(age * 5 + i));
        node.position.set(-4.0 - back, -0.8 - drop, lat);
        const fade = THREE.MathUtils.clamp(1.25 - age / 1.8, 0.22, 1.15);
        node.scale.setScalar(fade * (0.9 + 0.15 * Math.sin(tAnim * 38 + i * 2)));
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
    spriteMat.color.set(missileSample?.seekerLock ? 0xffc46a : 0x9ff3ff);

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
