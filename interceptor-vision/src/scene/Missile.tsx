import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Detailed, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { LIVERY, MISSILE_LODS } from "./assets";
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
      switch (m.name) {
        case "MAT_Body":
          m.color.set(opts.paint);
          m.envMapIntensity = 1.15;
          break;
        case "MAT_Accent":
          m.color.set(opts.accent);
          m.emissive = new THREE.Color(opts.accent);
          m.emissiveIntensity = opts.night ? 0.6 : 0.22;
          break;
        case "MAT_Fin":
          m.color.set(opts.paint).multiplyScalar(0.82);
          m.envMapIntensity = 1.0;
          break;
        case "MAT_Lens":
          m.emissive = new THREE.Color("#3fd0ff");
          m.emissiveIntensity = opts.night ? 2.4 : 0.7;
          break;
        case "MAT_Glow":
          m.emissive = new THREE.Color("#ff8a3c");
          m.emissiveIntensity = opts.night ? 9 : 6;
          break;
        case "MAT_Nozzle":
          m.envMapIntensity = 1.4;
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
    <group ref={group} position={[-3.12, 0, 0]}>
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
      <pointLight position={[-0.5, 0, 0]} color="#ffa45c" intensity={1.2 * boost} distance={5} decay={2} />
    </group>
  );
}

export function Missile() {
  const group = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (!group.current) return;
    group.current.rotation.x = Math.sin(t * 0.24) * 0.045;
    group.current.rotation.y = Math.sin(t * 0.17 + 0.8) * 0.012;
    group.current.rotation.z = Math.sin(t * 0.19 + 2.1) * 0.018;
    group.current.position.y = Math.sin(t * 0.5) * 0.12;
  });

  return (
    <group ref={group}>
      <Detailed distances={[0, 26, 160]}>
        <Model url={MISSILE_LODS[0]} />
        <Model url={MISSILE_LODS[1]} />
        <Model url={MISSILE_LODS[2]} />
      </Detailed>
      <Plume />
    </group>
  );
}

MISSILE_LODS.forEach((url) => useGLTF.preload(url));
