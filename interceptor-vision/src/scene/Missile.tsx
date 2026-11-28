import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Detailed, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { LIVERY, MISSILE_LODS } from "./assets";
import { boosterSeparationTime, sampleAt } from "../data/telemetry";
import { attitudeToScene, levelFromNose } from "./attitude";
import { dataClock } from "../data/dataClock";
import { useApp } from "../state";
import { AeroPhysicsOverlay } from "./AeroPhysicsOverlay";

/**
 * Body-axis cut used to drop the booster after burnout. The GLB is a single
 * merged mesh, so the first stage cannot simply be hidden; every airframe
 * material discards fragments aft of this station instead. -999 disables it.
 */
const BOOSTER_CUT_X = -2.285;
const bodyCut = { value: -999 };

function tuneMaterials(root: THREE.Object3D, opts: { accent: string; paint: string; night: boolean }) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const raw of materials) {
      const m = raw as THREE.MeshStandardMaterial;
      if (!m) continue;
      const phys = m as THREE.MeshPhysicalMaterial;
      switch (m.name) {
        case "MAT_Body":
          m.color.set(opts.paint);
          // The authored body ships fully rough, which flattens every highlight.
          // A semi-gloss lacquer plus a clearcoat gives it the read of painted
          // metal under the HDRI.
          m.roughness = opts.night ? 0.62 : 0.5;
          m.envMapIntensity = 1.5;
          if (phys.clearcoat !== undefined) {
            phys.clearcoat = 0.7;
            phys.clearcoatRoughness = 0.22;
          }
          break;
        case "MAT_Accent":
          m.color.set(opts.accent);
          m.emissive = new THREE.Color(opts.accent);
          m.emissiveIntensity = opts.night ? 0.9 : 0.3;
          m.envMapIntensity = 1.15;
          break;
        case "MAT_Fin":
          // Slightly darker than the body so both strakes read as a pair even
          // when one is washed out against the bright airframe.
          m.color.set(opts.paint).multiplyScalar(0.66);
          m.roughness = 0.38;
          m.envMapIntensity = 1.15;
          // The extruded strakes are single-surface plates and the mirrored one
          // is wound the other way, so FrontSide culling erased it and the
          // vehicle looked like it had a single wing. Draw both faces; three
          // flips the normal for back faces of a DoubleSide material.
          m.side = THREE.DoubleSide;
          if (phys.clearcoat !== undefined) {
            phys.clearcoat = 0.4;
            phys.clearcoatRoughness = 0.3;
          }
          break;
        case "MAT_Booster":
          m.roughness = 0.5;
          m.envMapIntensity = 1.15;
          break;
        case "MAT_Metal":
          m.roughness = 0.2;
          m.envMapIntensity = 1.5;
          break;
        case "MAT_Band":
          m.roughness = 0.36;
          m.envMapIntensity = 1.2;
          break;
        case "MAT_Lens":
          m.emissive = new THREE.Color("#3fd0ff");
          m.emissiveIntensity = opts.night ? 2.6 : 0.9;
          break;
        case "MAT_Glow":
          m.emissive = new THREE.Color("#ff8a3c");
          m.emissiveIntensity = opts.night ? 10 : 7;
          break;
        case "MAT_Nozzle":
          m.envMapIntensity = 1.6;
          break;
        default:
          break;
      }
      // Booster jettison: clip the merged mesh along the body axis once the
      // first stage has burned out.
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uCutX = bodyCut;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying float vBodyX;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBodyX = position.x;");
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            "#include <common>\nvarying float vBodyX;\nuniform float uCutX;",
          )
          .replace("void main() {", "void main() {\n  if (vBodyX < uCutX) discard;");
      };
      m.customProgramCacheKey = () => "iv-body-cut";
      m.needsUpdate = true;
    }
  });
}

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const livery = useApp((s) => s.livery);
  const timeOfDay = useApp((s) => s.timeOfDay);

  useEffect(() => {
    const { paint, accent } = LIVERY[livery];
    tuneMaterials(scene, { paint, accent, night: timeOfDay === "night" });
  }, [scene, livery, timeOfDay]);

  return <primitive object={scene} />;
}

const PLUME_VERT = /* glsl */ `
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

const PLUME_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uRegime;   // 0 = solid booster, 1 = scramjet cruise
  uniform float uPower;    // 0..1 overall intensity
  uniform float uUnstart;  // 0..1 unstart buzz flicker
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;

  void main() {
    // Cylinder / cone UV: vUv.y = 1 at nozzle exit, 0 at downstream tip.
    float axial = clamp(vUv.y, 0.0, 1.0);
    float dist = 1.0 - axial;
    float viewDot = abs(dot(normalize(vNormalView), normalize(vViewDir)));
    float core = pow(clamp(viewDot, 0.0, 1.0), 0.72);

    // Standing supersonic Mach shock diamonds along exhaust axis.
    float freq = mix(20.0, 34.0, uRegime);
    float speed = mix(26.0, 48.0, uRegime);
    float wave = 0.5 + 0.5 * sin(dist * freq - uTime * speed);
    float diamond = pow(wave, mix(3.2, 5.5, uRegime)) * smoothstep(0.05, 0.92, axial);

    // Booster = golden-orange-white incandescent plume; Scramjet = cyan-violet-amber jet.
    vec3 boostCore = vec3(1.0, 0.95, 0.80);
    vec3 boostMid  = vec3(1.0, 0.52, 0.14);
    vec3 boostTail = vec3(0.88, 0.24, 0.06);

    vec3 scramCore = vec3(0.88, 0.96, 1.0);
    vec3 scramMid  = vec3(0.36, 0.76, 1.0);
    vec3 scramTail = vec3(0.72, 0.44, 0.98);

    vec3 cCore = mix(boostCore, scramCore, uRegime);
    vec3 cMid  = mix(boostMid,  scramMid,  uRegime);
    vec3 cTail = mix(boostTail, scramTail, uRegime);

    vec3 col = mix(cTail, cMid, smoothstep(0.0, 0.6, axial));
    col = mix(col, cCore, smoothstep(0.55, 0.98, axial) * 0.75 + diamond * 0.65);

    // Unstart turns the scramjet exhaust sputtery orange-amber.
    float sputter = 1.0 - uUnstart * (0.55 + 0.35 * sin(uTime * 68.0));
    col = mix(col, vec3(1.0, 0.46, 0.12), uUnstart * 0.75);

    float fade = pow(axial, mix(1.25, 1.55, uRegime)) * smoothstep(0.0, 0.14, axial);
    float flicker = 0.92 + 0.08 * sin(uTime * 53.0 + dist * 12.0);
    float alpha = clamp((fade * (0.48 + 0.52 * core) + diamond * 0.42 * axial) * uPower * sputter * flicker, 0.0, 0.96);
    gl_FragColor = vec4(col * (1.1 + diamond * 0.7), alpha);
  }
`;

/** Sculpted twin 2D scramjet compression-ramp intakes + dorsal avionics spine. */
function ScramjetHardware() {
  const buzzMatRef = useRef<THREE.MeshStandardMaterial>(null);

  const { cowlGeo, rampGeo, lipGeo, spineGeo } = useMemo(() => {
    // Streamlined trapezoidal nacelle cowl (side profile in XY, extruded along Z).
    const cowl = new THREE.Shape();
    cowl.moveTo(0.88, -0.05);
    cowl.lineTo(0.45, -0.14);
    cowl.lineTo(-1.45, -0.13);
    cowl.lineTo(-1.72, -0.02);
    cowl.lineTo(-1.45, 0.06);
    cowl.lineTo(0.52, 0.05);
    cowl.closePath();
    const cowlG = new THREE.ExtrudeGeometry(cowl, {
      depth: 0.13,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.014,
      bevelSegments: 2,
      curveSegments: 2,
    });
    cowlG.translate(0, 0, -0.065);
    cowlG.computeVertexNormals();

    // Oblique-shock compression ramp extending forward of cowl lip.
    const ramp = new THREE.Shape();
    ramp.moveTo(1.28, 0.0);
    ramp.lineTo(0.82, -0.09);
    ramp.lineTo(0.82, 0.02);
    ramp.closePath();
    const rampG = new THREE.ExtrudeGeometry(ramp, {
      depth: 0.11,
      bevelEnabled: true,
      bevelThickness: 0.006,
      bevelSize: 0.006,
      bevelSegments: 1,
    });
    rampG.translate(0, 0, -0.055);
    rampG.computeVertexNormals();

    // Sharp metallic inlet cowl lip ring frame.
    const lipG = new THREE.BoxGeometry(0.08, 0.14, 0.155);

    // Dorsal cable & telemetry spine along top (+Y) of sustainer.
    const spine = new THREE.Shape();
    spine.moveTo(1.55, 0.0);
    spine.lineTo(1.22, 0.052);
    spine.lineTo(-1.82, 0.052);
    spine.lineTo(-2.06, 0.0);
    spine.closePath();
    const spineG = new THREE.ExtrudeGeometry(spine, {
      depth: 0.075,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.01,
      bevelSegments: 2,
    });
    spineG.translate(0, 0, -0.0375);
    spineG.computeVertexNormals();

    return { cowlGeo: cowlG, rampGeo: rampG, lipGeo: lipG, spineGeo: spineG };
  }, []);

  useEffect(
    () => () => {
      cowlGeo.dispose();
      rampGeo.dispose();
      lipGeo.dispose();
      spineGeo.dispose();
    },
    [cowlGeo, rampGeo, lipGeo, spineGeo],
  );

  useFrame(({ clock }) => {
    if (!buzzMatRef.current) return;
    const s = useApp.getState().dataStatus === "ready" ? sampleAt(dataClock.t) : null;
    const unstart = (s?.unstartFlag ?? 0) > 0.5;
    const buzz = unstart ? 1.8 + 1.2 * Math.sin(clock.elapsedTime * 55) : 0.0;
    buzzMatRef.current.emissiveIntensity = buzz;
  });

  return (
    <group name="scramjet-hardware">
      {/* Dorsal avionics raceway fairing */}
      <mesh geometry={spineGeo} position={[0, 0.168, 0]}>
        <meshStandardMaterial color="#cfd7e0" metalness={0.48} roughness={0.38} />
      </mesh>
      {/* Twin lateral-ventral 2D scramjet compression-ramp intakes */}
      {[1, -1].map((side) => (
        <group key={`intake-${side}`} position={[0, -0.035, side * 0.195]} rotation={[side * 0.18, 0, 0]}>
          <mesh geometry={cowlGeo}>
            <meshStandardMaterial color="#4e5864" metalness={0.68} roughness={0.34} />
          </mesh>
          <mesh geometry={rampGeo}>
            <meshStandardMaterial color="#737e8a" metalness={0.78} roughness={0.28} />
          </mesh>
          <mesh geometry={lipGeo} position={[0.78, -0.052, 0]}>
            <meshStandardMaterial color="#8f9aa6" metalness={0.86} roughness={0.22} />
          </mesh>
          {/* Dark inlet duct throat with live unstart shock-buzz glow */}
          <mesh position={[0.825, -0.052, 0]}>
            <boxGeometry args={[0.02, 0.105, 0.118]} />
            <meshStandardMaterial
              ref={side === 1 ? buzzMatRef : undefined}
              color="#0b1017"
              metalness={0.2}
              roughness={0.85}
              emissive="#ff5e14"
              emissiveIntensity={0}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Volumetric GLSL Mach-diamond exhaust plume reacting to boost/scramjet/unstart regimes. */
function Plume() {
  const group = useRef<THREE.Group>(null);
  const outerRef = useRef<THREE.Mesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const spriteInRef = useRef<THREE.Sprite>(null);
  const spriteOutRef = useRef<THREE.Sprite>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const timeOfDay = useApp((s) => s.timeOfDay);

  const glow = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.24, "rgba(255,255,255,0.62)");
    g.addColorStop(0.58, "rgba(255,255,255,0.16)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  const outerMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: PLUME_VERT,
        fragmentShader: PLUME_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uRegime: { value: 0 },
          uPower: { value: 1 },
          uUnstart: { value: 0 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  const coreMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: PLUME_VERT,
        fragmentShader: PLUME_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uRegime: { value: 0 },
          uPower: { value: 1 },
          uUnstart: { value: 0 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  useEffect(
    () => () => {
      glow.dispose();
      outerMat.dispose();
      coreMat.dispose();
    },
    [glow, outerMat, coreMat],
  );

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.elapsedTime;
    const state = useApp.getState();
    const s = state.dataStatus === "ready" ? sampleAt(dataClock.t) : null;
    const sepT = boosterSeparationTime() ?? 13.0;
    const separated = s?.stageSep !== undefined ? s.stageSep > 0.5 : dataClock.t >= sepT;
    const unstart = (s?.unstartFlag ?? 0) > 0.5 ? 1 : 0;

    // Powered during solid boost OR scramjet cruise/terminal envelope with fuel left.
    const scramOn =
      separated &&
      (s ? s.mach >= 1.55 && s.altM < 32200 && s.massKg > 1002 : true);
    const boostOn = !separated;
    const active = boostOn || scramOn;
    const power = !active
      ? 0
      : boostOn
        ? 1.0
        : THREE.MathUtils.clamp((s?.qPa ?? 90000) / 140000, 0.35, 1.0);
    const regime = separated ? 1.0 : 0.0;
    const nightBoost = timeOfDay === "night" ? 1.25 : 1.0;

    group.current.visible = power > 0.02;
    if (!group.current.visible) return;

    const lenScale = separated
      ? THREE.MathUtils.lerp(0.68, 1.08, power) * (unstart ? 0.45 : 1.0)
      : 1.28;
    const radScale = separated ? 0.72 : 1.18;
    const flick = 1 + 0.04 * Math.sin(t * 47) + 0.02 * Math.sin(t * 103);

    if (outerRef.current) {
      outerRef.current.scale.set(radScale * flick, lenScale, radScale * flick);
      outerRef.current.position.x = -1.75 * lenScale;
    }
    if (coreRef.current) {
      coreRef.current.scale.set(radScale * 0.56 * flick, lenScale * 0.78, radScale * 0.56 * flick);
      coreRef.current.position.x = -1.25 * lenScale;
    }

    outerMat.uniforms.uTime.value = t;
    outerMat.uniforms.uRegime.value = regime;
    outerMat.uniforms.uPower.value = power * 0.85 * nightBoost;
    outerMat.uniforms.uUnstart.value = unstart;

    coreMat.uniforms.uTime.value = t * 1.12;
    coreMat.uniforms.uRegime.value = regime;
    coreMat.uniforms.uPower.value = power * 1.0 * nightBoost;
    coreMat.uniforms.uUnstart.value = unstart;

    if (spriteInRef.current) {
      const m = spriteInRef.current.material as THREE.SpriteMaterial;
      m.color.set(separated && !unstart ? "#98dcff" : "#ffd29b");
      m.opacity = Math.min(1, 0.58 * power * nightBoost);
      spriteInRef.current.scale.setScalar(separated ? 1.75 : 2.5);
    }
    if (spriteOutRef.current) {
      const m = spriteOutRef.current.material as THREE.SpriteMaterial;
      m.color.set(separated && !unstart ? "#58b6ff" : "#ff8636");
      m.opacity = Math.min(0.45, 0.14 * power * nightBoost);
      spriteOutRef.current.scale.setScalar(separated ? 4.4 : 6.2);
    }
    if (lightRef.current) {
      lightRef.current.color.set(separated && !unstart ? "#78c8ff" : "#ff9b4a");
      lightRef.current.intensity = (separated ? 1.15 : 2.1) * power * nightBoost;
    }
  });

  return (
    <group ref={group}>
      {/* Outer supersonic shear cone (cylinder tapered to tip along -X) */}
      <mesh ref={outerRef} material={outerMat} position={[-1.75, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.175, 0.032, 3.5, 28, 24, true]} />
      </mesh>
      {/* Inner incandescent Mach-diamond shock core */}
      <mesh ref={coreRef} material={coreMat} position={[-1.25, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.115, 0.012, 2.5, 24, 24, true]} />
      </mesh>
      {/* Camera-facing engine bloom sprites */}
      <sprite ref={spriteInRef} scale={[2.1, 2.1, 1]}>
        <spriteMaterial
          map={glow}
          color="#ffd6a6"
          transparent
          opacity={0.55}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
      <sprite ref={spriteOutRef} scale={[5.6, 5.6, 1]}>
        <spriteMaterial
          map={glow}
          color="#61c8ff"
          transparent
          opacity={0.12}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
      <pointLight ref={lightRef} position={[-0.55, 0, 0]} color="#ffa45c" intensity={1.4} distance={6} decay={2} />
    </group>
  );
}

/** Fetches the far LODs in the background once the first frame is on screen. */
function LodsPreloader({ onReady }: { onReady: () => void }) {
  useGLTF(MISSILE_LODS[1]);
  useGLTF(MISSILE_LODS[2]);
  useEffect(() => {
    onReady();
  }, [onReady]);
  return null;
}

const BOOSTER_CENTER = -2.75;

/**
 * Procedural first stage (MK72-style): olive booster barrel with clamp bands,
 * separation ring and a nozzle bell. Geometry is laid out around its own centre
 * so it tumbles about itself once released.
 */
function BoosterStage({
  stageRef,
  flameRef,
}: {
  stageRef: RefObject<THREE.Group | null>;
  flameRef: RefObject<THREE.Mesh | null>;
}) {
  const olive = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x8a8766,
        metalness: 0.3,
        roughness: 0.52,
        envMapIntensity: 1.1,
      }),
    [],
  );
  const ring = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x8f959c,
        metalness: 0.75,
        roughness: 0.3,
        envMapIntensity: 1.4,
      }),
    [],
  );
  const band = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x3f444a,
        metalness: 0.35,
        roughness: 0.55,
      }),
    [],
  );
  const bell = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x4a4f55,
        metalness: 0.7,
        roughness: 0.35,
        envMapIntensity: 1.3,
      }),
    [],
  );
  const flame = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0xffb878,
        emissive: new THREE.Color("#ff8a3c"),
        emissiveIntensity: 7,
        side: THREE.DoubleSide,
      }),
    [],
  );

  useEffect(
    () => () => {
      olive.dispose();
      ring.dispose();
      band.dispose();
      bell.dispose();
      flame.dispose();
    },
    [olive, ring, band, bell, flame],
  );

  // Cylinders are authored along +y; rotating -90 deg about z puts +y along the
  // nose (+x). radiusTop is therefore the forward radius.
  const shell = (front: number, rear: number, len: number, x: number) => {
    const geo = new THREE.CylinderGeometry(front, rear, len, 32);
    geo.rotateZ(-Math.PI / 2);
    geo.translate(x, 0, 0);
    return geo;
  };

  const parts = useMemo(() => {
    // Chamfered booster stabilizer fin (swept trapezoidal profile)
    const finShape = new THREE.Shape();
    finShape.moveTo(0.18, 0.0);
    finShape.lineTo(-0.22, 0.0);
    finShape.lineTo(-0.26, 0.24);
    finShape.lineTo(-0.02, 0.24);
    finShape.closePath();
    const stabFin = new THREE.ExtrudeGeometry(finShape, {
      depth: 0.022,
      bevelEnabled: true,
      bevelThickness: 0.005,
      bevelSize: 0.005,
      bevelSegments: 1,
    });
    stabFin.translate(0, 0, -0.011);
    stabFin.computeVertexNormals();

    return {
      adapter: shell(0.17, 0.208, 0.12, 0.43),
      barrel: shell(0.208, 0.208, 0.7, 0.02),
      tail: shell(0.208, 0.172, 0.16, -0.41),
      nozzle: shell(0.176, 0.112, 0.19, -0.56),
      bandA: new THREE.TorusGeometry(0.21, 0.009, 8, 32),
      bandB: new THREE.TorusGeometry(0.21, 0.009, 8, 32),
      sepRing: new THREE.TorusGeometry(0.20, 0.013, 8, 32),
      latch: new THREE.BoxGeometry(0.055, 0.028, 0.028),
      stabFin,
      flame: new THREE.CircleGeometry(0.095, 20),
    };
  }, []);

  useEffect(
    () => () => {
      Object.values(parts).forEach((g) => g.dispose());
    },
    [parts],
  );

  return (
    <group ref={stageRef}>
      <mesh geometry={parts.adapter} material={olive} />
      <mesh geometry={parts.barrel} material={olive} />
      <mesh geometry={parts.tail} material={olive} />
      <mesh geometry={parts.nozzle} material={bell} />
      <mesh geometry={parts.bandA} material={band} position={[0.2, 0, 0]} rotation={[0, Math.PI / 2, 0]} />
      <mesh geometry={parts.bandB} material={band} position={[-0.17, 0, 0]} rotation={[0, Math.PI / 2, 0]} />
      <mesh geometry={parts.sepRing} material={ring} position={[0.45, 0, 0]} rotation={[0, Math.PI / 2, 0]} />
      {/* 4 titanium separation clamp latches + 4 chamfered booster stabilizer fins */}
      {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((ang) => (
        <group key={`bfin-${ang}`} rotation={[ang, 0, 0]}>
          <mesh geometry={parts.latch} material={ring} position={[0.44, 0.204, 0]} />
          <mesh geometry={parts.stabFin} material={band} position={[-0.24, 0.192, 0]} />
        </group>
      ))}
      <mesh ref={flameRef} geometry={parts.flame} material={flame} position={[-0.652, 0, 0]} rotation={[0, -Math.PI / 2, 0]} />
    </group>
  );
}

/** Aft hardware of the upper stage, exposed once the booster falls away. */
function UpperStageAft({ aftRef }: { aftRef: RefObject<THREE.Group | null> }) {
  const cap = useMemo(() => new THREE.CircleGeometry(0.172, 28), []);
  const bell = useMemo(() => {
    const geo = new THREE.CylinderGeometry(0.17, 0.125, 0.16, 28);
    geo.rotateZ(-Math.PI / 2);
    return geo;
  }, []);
  const metal = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x5a6067,
        metalness: 0.7,
        roughness: 0.36,
        side: THREE.DoubleSide,
      }),
    [],
  );
  useEffect(
    () => () => {
      cap.dispose();
      bell.dispose();
      metal.dispose();
    },
    [cap, bell, metal],
  );
  return (
    <group ref={aftRef} visible={false}>
      <mesh geometry={cap} material={metal} position={[-2.286, 0, 0]} rotation={[0, -Math.PI / 2, 0]} />
      <mesh geometry={bell} material={metal} position={[-2.37, 0, 0]} />
    </group>
  );
}

export function Missile() {
  const group = useRef<THREE.Group>(null);
  const plumeRef = useRef<THREE.Group>(null);
  const boosterRef = useRef<THREE.Group>(null);
  const boosterFlameRef = useRef<THREE.Mesh>(null);
  const aftRef = useRef<THREE.Group>(null);
  const mixRef = useRef(0);
  const ready = useApp((s) => s.ready);
  const quality = useApp((s) => s.quality);
  const [tiered, setTiered] = useState(false);
  const [warm, setWarm] = useState(false);
  const targetQuat = useMemo(() => new THREE.Quaternion(), []);
  const nose = useMemo(() => new THREE.Vector3(), []);
  const tmpV = useMemo(() => new THREE.Vector3(), []);
  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpE = useMemo(() => new THREE.Euler(), []);

  // Let the near LOD and the HDRI finish first, then upgrade to the full LOD
  // chain. The performance tier keeps the single near LOD on purpose.
  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => setWarm(true), quality === "performance" ? 6000 : 1200);
    return () => window.clearTimeout(id);
  }, [ready, quality]);

  useFrame((_, delta) => {
    if (!group.current) return;
    const state = useApp.getState();
    const sample = state.dataStatus === "ready" ? sampleAt(dataClock.t) : null;
    if (!sample) return;
    const k = 1 - Math.exp(-20 * Math.min(delta, 0.1));
    attitudeToScene(sample.attitude, sample.latDeg, sample.lonDeg, targetQuat);
    if (sample.attitudeAliased) {
      // The recording cadence cannot resolve the roll during the fast-roll
      // windows; replaying it verbatim spins the wings like a blender. Keep the
      // recorded nose and draw the airframe wings-level instead.
      nose.set(1, 0, 0).applyQuaternion(targetQuat);
      levelFromNose(nose, targetQuat);
    }
    group.current.quaternion.slerp(targetQuat, k);
  });

  // First-stage separation driven directly by telemetry stageSep flag (13 s),
  // falling back to boosterSeparationTime() for legacy payloads.
  useFrame((_, delta) => {
    if (!group.current) return;
    const state = useApp.getState();
    const sample = state.dataStatus === "ready" ? sampleAt(dataClock.t) : null;
    const sepT = boosterSeparationTime() ?? 13.0;
    const separated =
      sample?.stageSep !== undefined
        ? sample.stageSep > 0.5
        : dataClock.t >= sepT;
    const goal = separated ? 1 : 0;
    mixRef.current += (goal - mixRef.current) * (1 - Math.exp(-14 * Math.min(delta, 0.1)));
    const mix = mixRef.current;
    bodyCut.value = mix > 0.55 ? BOOSTER_CUT_X : -999;
    if (aftRef.current) aftRef.current.visible = mix > 0.55;
    if (plumeRef.current) {
      // The sustainer scramjet nozzle sits well forward of the Stage-1 booster bell.
      plumeRef.current.position.x = THREE.MathUtils.lerp(-3.34, -2.42, mix);
    }
    const booster = boosterRef.current;
    if (!booster) return;
    const q = group.current.quaternion;
    const flameMat = boosterFlameRef.current?.material as THREE.MeshStandardMaterial | undefined;
    if (flameMat) flameMat.emissiveIntensity = separated ? 0 : 7;
    if (!separated) {
      booster.visible = true;
      tmpV.set(BOOSTER_CENTER, 0, 0).applyQuaternion(q);
      booster.position.copy(tmpV);
      booster.quaternion.copy(q);
      return;
    }
    const tau = Math.max(0, dataClock.t - Math.min(sepT, 13.0));
    booster.visible = tau < 9;
    if (!booster.visible) return;
    // Relative motion: the spent stage decelerates away and drops slightly.
    const back = 9 * tau + 1.1 * tau * tau;
    const down = 2.2 * tau + 2.6 * tau * tau;
    tmpV.set(BOOSTER_CENTER - back, -down, 0).applyQuaternion(q);
    booster.position.copy(tmpV);
    tmpE.set(0.45 * tau, 0.1 * tau, 0.75 * tau);
    tmpQ.setFromEuler(tmpE);
    booster.quaternion.copy(q).multiply(tmpQ);
  });

  return (
    <>
      <group ref={group}>
        {tiered ? (
          <Detailed distances={[0, 26, 160]}>
            <Model url={MISSILE_LODS[0]} />
            <Model url={MISSILE_LODS[1]} />
            <Model url={MISSILE_LODS[2]} />
          </Detailed>
        ) : (
          <Model url={MISSILE_LODS[0]} />
        )}
        {warm && !tiered && (
          <Suspense fallback={null}>
            <LodsPreloader onReady={() => setTiered(true)} />
          </Suspense>
        )}
        <ScramjetHardware />
        <UpperStageAft aftRef={aftRef} />
        <AeroPhysicsOverlay />
        <group ref={plumeRef} position={[-3.34, 0, 0]}>
          <Plume />
        </group>
      </group>
      <BoosterStage stageRef={boosterRef} flameRef={boosterFlameRef} />
    </>
  );
}

useGLTF.preload(MISSILE_LODS[0]);
