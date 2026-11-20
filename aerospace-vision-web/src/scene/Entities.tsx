import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { simClock, useAppStore } from "../state/store";
import { KM, COLORS, EARTH_A_KM, WGS84_E2_KM } from "./constants";

/** Radial glow sprite texture, generated once on a canvas. */
function useGlowTexture(inner: string, outer: string) {
  return useMemo(() => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, outer);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [inner, outer]);
}

/** Procedural PBR interceptor, 6.5 m long, body +x forward, +z down. */
function MissileBody() {
  const plume = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const rt = useAppStore.getState().runtime;
    const boostEnd = rt?.manifest.phases.find((p) => p.phase === "boost")?.endT ?? 20;
    if (plume.current) plume.current.visible = simClock.time <= boostEnd;
  });
  return (
    <group>
      <mesh rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00042, 0.00055, 0.0046, 24]} />
        <meshStandardMaterial color="#dfe7f0" metalness={0.68} roughness={0.34} emissive="#24303d" emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[0.00305, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.00042, 0.0016, 24]} />
        <meshStandardMaterial color="#2b3138" metalness={0.85} roughness={0.25} />
      </mesh>
      <mesh position={[-0.0024, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.0006, 0.00046, 0.0005, 20]} />
        <meshStandardMaterial color="#4a4f57" metalness={0.9} roughness={0.3} />
      </mesh>
      <mesh position={[0.0007, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00047, 0.00047, 0.00022, 24]} />
        <meshStandardMaterial color={COLORS.accent} emissive={COLORS.accent} emissiveIntensity={0.35} metalness={0.5} roughness={0.35} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[-0.0019, 0, 0]} rotation={[0, 0, (i * Math.PI) / 2]}>
          <boxGeometry args={[0.00075, 0.0009, 0.00005]} />
          <meshStandardMaterial color="#8d97a3" metalness={0.65} roughness={0.4} />
        </mesh>
      ))}
      <mesh ref={plume} position={[-0.0032, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <coneGeometry args={[0.00035, 0.0014, 16, 1, true]} />
        <meshBasicMaterial color="#9fd9ff" transparent opacity={0.55} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Target silhouette, oriented by its velocity-derived attitude. */
function TargetBody() {
  return (
    <group>
      <mesh rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.00034, 0.002, 18]} />
        <meshStandardMaterial color="#59636f" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <boxGeometry args={[0.00012, 0.0018, 0.0012]} />
        <meshStandardMaterial color="#4d565f" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.00035, 12, 8]} />
        <meshStandardMaterial color={COLORS.cyan} emissive={COLORS.cyan} emissiveIntensity={0.8} />
      </mesh>
    </group>
  );
}

interface EntityProps {
  kind: "missile" | "target";
  label: string;
  color: string;
  showLabel?: boolean;
  modelScale?: number;
}

export function EntityVisual({ kind, label, color, showLabel = false, modelScale = 1 }: EntityProps) {
  const model = useRef<THREE.Group>(null);
  const marker = useRef<THREE.Sprite>(null);
  const labelAnchor = useRef<THREE.Group>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const glowTex = useGlowTexture(
    "rgba(255,255,255,1)",
    kind === "missile" ? "rgba(255,178,87,0.55)" : "rgba(99,230,255,0.55)",
  );

  useFrame(({ camera }) => {
    const rt = useAppStore.getState().runtime;
    if (!rt || !model.current) return;
    const sampler = kind === "missile" ? rt.missileSampler : rt.targetSampler;
    const s = sampler.sampleAt(simClock.time);
    const p = new THREE.Vector3(s.position.x, s.position.y, s.position.z).multiplyScalar(KM);
    model.current.position.copy(p);
    model.current.quaternion.set(s.attitude.x, s.attitude.y, s.attitude.z, s.attitude.w);
    model.current.scale.setScalar(modelScale);

    if (marker.current) {
      marker.current.position.copy(p);
      const d = camera.position.distanceTo(p);
      marker.current.scale.setScalar(Math.max(0.02, d * 0.013));
      const mat = marker.current.material as THREE.SpriteMaterial;
      // The marker is an orbital-scale locator: fade it out well before it can
      // swamp the real, physically sized vehicle at close range.
      mat.opacity = THREE.MathUtils.clamp((d - 0.5) / 3, 0, 0.85);
    }
    if (labelAnchor.current) {
      labelAnchor.current.position.copy(p);
      // Entity labels are useful at close range only; beacons carry the
      // geographic context when zoomed out.
      const near = camera.position.distanceTo(p) < 90;
      if (labelRef.current) labelRef.current.style.display = near ? "block" : "none";
    }
  });

  return (
    <>
      <group ref={model} name={`entity-${kind}`}>
        {kind === "missile" ? <MissileBody /> : <TargetBody />}
      </group>
      <sprite ref={marker} scale={0.01}>
        <spriteMaterial map={glowTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} color={color} />
      </sprite>
      {showLabel && (
        <group ref={labelAnchor}>
          <Html position={[0, 0.0004, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <div className={`entity-tag entity-tag--${kind}`} ref={labelRef} style={{ display: "none" }}>{label}</div>
          </Html>
        </group>
      )}
    </>
  );
}

/** Beacon at the launch/target datum (WGS84 ellipsoid surface). */
export function SurfaceBeacon({
  latDeg,
  lonDeg,
  altM,
  label,
  color,
  kind,
}: {
  latDeg: number;
  lonDeg: number;
  altM: number;
  label: string;
  color: string;
  kind: "launch" | "target";
}) {
  const group = useRef<THREE.Group>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const position = useMemo<[number, number, number]>(() => {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const s = Math.sin(lat);
    const n = EARTH_A_KM / Math.sqrt(1 - WGS84_E2_KM * s * s);
    const x = (n + altM * KM) * Math.cos(lat) * Math.cos(lon);
    const y = (n + altM * KM) * Math.cos(lat) * Math.sin(lon);
    const z = (n * (1 - WGS84_E2_KM) + altM * KM) * s;
    return [x, y, z];
  }, [latDeg, lonDeg, altM]);

  useFrame(({ clock, camera }) => {
    if (!group.current) return;
    group.current.scale.setScalar(1 + 0.18 * Math.sin(clock.elapsedTime * 2.2));
    // Datum labels belong to the orbital/plan view, not to a close chase pass.
    if (labelRef.current) {
      labelRef.current.style.display =
        camera.position.length() > EARTH_A_KM * 1.03 ? "flex" : "none";
    }
  });

  return (
    <group position={position} ref={group}>
      <mesh>
        <sphereGeometry args={[6, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} />
      </mesh>
      <mesh>
        <sphereGeometry args={[16, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <Html position={[0, kind === "target" ? -190 : 120, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        <div className={`surface-tag surface-tag--${kind}`} ref={labelRef}>
          <span className="surface-tag__dot" />
          {label}
        </div>
      </Html>
    </group>
  );
}
