import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Detailed, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { LIVERY, MISSILE_LODS } from "./assets";
import { boosterSeparationTime, sampleAt } from "../data/telemetry";
import { attitudeToScene, levelFromNose } from "./attitude";
import { dataClock } from "../data/dataClock";
import { useApp } from "../state";

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

/** Layered, camera-oriented exhaust glow built from soft gradient planes. */
function Plume() {
  const group = useRef<THREE.Group>(null);
  const timeOfDay = useApp((s) => s.timeOfDay);

  const texture = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.save();
    ctx.translate(128, 32);
    ctx.scale(4.2, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.3, "rgba(255,255,255,0.85)");
    g.addColorStop(0.7, "rgba(255,255,255,0.25)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(-64, -34, 128, 68);
    ctx.restore();
    const fade = ctx.createLinearGradient(0, 0, 256, 0);
    fade.addColorStop(0, "rgba(255,255,255,0)");
    fade.addColorStop(0.45, "rgba(255,255,255,0.28)");
    fade.addColorStop(1, "rgba(255,255,255,1)");
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, 256, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  const glow = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.22, "rgba(255,255,255,0.6)");
    g.addColorStop(0.55, "rgba(255,255,255,0.16)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.elapsedTime;
    const flicker = 1 + 0.05 * Math.sin(t * 41) + 0.025 * Math.sin(t * 97);
    group.current.scale.set(1, flicker, 1 + 0.06 * Math.sin(t * 33));
  });

  const boost = timeOfDay === "night" ? 1.25 : 1;
  const layers = [
    { len: 1.3, width: 0.22, color: "#fff4d8", opacity: 0.85 },
    { len: 2.3, width: 0.4, color: "#ffae5c", opacity: 0.4 },
    { len: 3.6, width: 0.62, color: "#6fd4ff", opacity: 0.16 },
  ];

  return (
    <group ref={group}>
      {layers.map((l) => (
        <group key={l.len} position={[-l.len / 2, 0, 0]}>
          {[0, Math.PI / 2].map((rot) => (
            <mesh key={rot} rotation={[rot, 0, 0]}>
              <planeGeometry args={[l.len, l.width]} />
              <meshBasicMaterial
                map={texture}
                color={l.color}
                transparent
                opacity={Math.min(1, l.opacity * boost)}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                side={THREE.DoubleSide}
                toneMapped={false}
              />
            </mesh>
          ))}
        </group>
      ))}
      {/* Camera-facing engine bloom: at 60-120 m the additive planes are a few
          pixels wide, so a pair of soft sprites carries the glow instead. */}
      <sprite scale={[2.1, 2.1, 1]}>
        <spriteMaterial
          map={glow}
          color="#ffd6a6"
          transparent
          opacity={Math.min(1, 0.52 * boost)}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
      <sprite scale={[5.6, 5.6, 1]}>
        <spriteMaterial
          map={glow}
          color="#61c8ff"
          transparent
          opacity={0.1 * boost}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
      <pointLight position={[-0.5, 0, 0]} color="#ffa45c" intensity={1.2 * boost} distance={5} decay={2} />
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

  const parts = useMemo(
    () => ({
      adapter: shell(0.17, 0.205, 0.12, 0.43),
      barrel: shell(0.205, 0.205, 0.7, 0.02),
      tail: shell(0.205, 0.17, 0.16, -0.41),
      nozzle: shell(0.176, 0.11, 0.18, -0.56),
      bandA: new THREE.TorusGeometry(0.207, 0.008, 8, 32),
      bandB: new THREE.TorusGeometry(0.207, 0.008, 8, 32),
      sepRing: new THREE.TorusGeometry(0.198, 0.012, 8, 32),
      flame: new THREE.CircleGeometry(0.085, 20),
    }),
    [],
  );

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
      <mesh ref={flameRef} geometry={parts.flame} material={flame} position={[-0.648, 0, 0]} rotation={[0, -Math.PI / 2, 0]} />
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

  // First-stage separation. The payload has no discrete stage state, so burnout
  // is derived from the mass curve; the released booster is a visual cue that
  // tumbles away from the sustainer.
  useFrame((_, delta) => {
    if (!group.current) return;
    const sepT = boosterSeparationTime();
    const separated = sepT !== null && dataClock.t >= sepT;
    const goal = separated ? 1 : 0;
    mixRef.current += (goal - mixRef.current) * (1 - Math.exp(-14 * Math.min(delta, 0.1)));
    const mix = mixRef.current;
    bodyCut.value = mix > 0.55 ? BOOSTER_CUT_X : -999;
    if (aftRef.current) aftRef.current.visible = mix > 0.55;
    if (plumeRef.current) {
      // The sustainer nozzle sits well forward of the booster bell.
      plumeRef.current.position.x = THREE.MathUtils.lerp(-3.34, -2.37, mix);
      plumeRef.current.scale.setScalar(THREE.MathUtils.lerp(1, 0.64, mix));
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
    const tau = Math.max(0, dataClock.t - (sepT ?? 0));
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
        <UpperStageAft aftRef={aftRef} />
        <group ref={plumeRef} position={[-3.34, 0, 0]}>
          <Plume />
        </group>
      </group>
      <BoosterStage stageRef={boosterRef} flameRef={boosterFlameRef} />
    </>
  );
}

useGLTF.preload(MISSILE_LODS[0]);
