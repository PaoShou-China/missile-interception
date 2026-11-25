import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Detailed, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { LIVERY, MISSILE_LODS } from "./assets";
import { sampleAt } from "../data/telemetry";
import { attitudeToScene } from "./attitude";
import { dataClock } from "../data/dataClock";
import { useApp } from "../state";

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
          m.color.set(opts.paint).multiplyScalar(0.82);
          m.roughness = 0.34;
          m.envMapIntensity = 1.3;
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
    <group ref={group} position={[-3.34, 0, 0]}>
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

export function Missile() {
  const group = useRef<THREE.Group>(null);
  const ready = useApp((s) => s.ready);
  const quality = useApp((s) => s.quality);
  const [tiered, setTiered] = useState(false);
  const [warm, setWarm] = useState(false);
  const targetQuat = useMemo(() => new THREE.Quaternion(), []);

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
    group.current.quaternion.slerp(targetQuat, k);
  });

  return (
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
      <Plume />
    </group>
  );
}

useGLTF.preload(MISSILE_LODS[0]);
