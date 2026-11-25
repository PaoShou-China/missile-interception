import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Html, useGLTF } from "@react-three/drei";
import { simClock, useAppStore } from "../state/store";
import { MISSILE_LODS } from "../../scene/assets";
import { KM, EARTH_A_KM, WGS84_E2_KM } from "./constants";

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

/** Same SM-3-style GLB used by the live scene, placed in the ECEF kilometre frame. */
function MissileBody() {
  const { scene } = useGLTF(MISSILE_LODS[0]);
  const plume = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (!plume.current) return;
    const f = 1 + 0.06 * Math.sin(clock.elapsedTime * 47);
    plume.current.scale.set(f, f, f);
  });

  return (
    <group>
      {/* glTF is +X nose / +Y up; the body frame is +X forward / +Z down. */}
      <group rotation={[-Math.PI / 2, 0, 0]} scale={0.001}>
        <primitive object={scene} />
      </group>
      <group ref={plume} position={[-0.00340, 0, 0]}>
        {[
          { len: 0.00055, r: 0.000085, color: "#fff6dc", opacity: 1 },
          { len: 0.00095, r: 0.000110, color: "#ffb35c", opacity: 0.6 },
          { len: 0.00145, r: 0.000150, color: "#6fd4ff", opacity: 0.26 },
        ].map((p) => (
          <mesh key={p.len} rotation={[0, 0, Math.PI / 2]}>
            <coneGeometry args={[p.r, p.len, 20, 1, true]} />
            <meshBasicMaterial
              color={p.color}
              transparent
              opacity={p.opacity}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** F-35-style target: blended octagonal fuselage, swept wings, canted tails. */
function TargetBody() {
  const geo = useMemo(() => {
    const ring = [
      [1, 0], [0.72, 0.72], [0, 1], [-0.72, 0.72],
      [-1, 0], [-0.72, -0.72], [0, -1], [0.72, -0.72],
    ];
    const stations = [
      { x: 0.00840, w: 0.00004, h: 0.00003, z: 0 },
      { x: 0.00700, w: 0.00022, h: 0.00018, z: -0.00002 },
      { x: 0.00500, w: 0.00042, h: 0.00034, z: -0.00004 },
      { x: 0.00300, w: 0.00062, h: 0.00046, z: -0.00006 },
      { x: 0.00000, w: 0.00080, h: 0.00050, z: -0.00005 },
      { x: -0.00300, w: 0.00078, h: 0.00048, z: -0.00003 },
      { x: -0.00540, w: 0.00064, h: 0.00042, z: 0 },
      { x: -0.00720, w: 0.00046, h: 0.00034, z: 0 },
    ];
    const positions: number[] = [];
    const indices: number[] = [];
    for (const s of stations) {
      for (const [rx, rz] of ring) {
        positions.push(s.x, s.w * rx, s.z + s.h * rz);
      }
    }
    for (let i = 0; i < stations.length - 1; i++) {
      for (let j = 0; j < ring.length; j++) {
        const a = i * ring.length + j;
        const b = i * ring.length + ((j + 1) % ring.length);
        const c = (i + 1) * ring.length + ((j + 1) % ring.length);
        const d = (i + 1) * ring.length + j;
        indices.push(a, b, d, b, c, d);
      }
    }
    const fuselage = new THREE.BufferGeometry();
    fuselage.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    fuselage.setIndex(indices);
    fuselage.computeVertexNormals();

    const extrude = (build: (s: THREE.Shape) => void, depth: number) => {
      const shape = new THREE.Shape();
      build(shape);
      const g = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: depth * 0.25,
        bevelSize: depth * 0.25,
        bevelSegments: 1,
        curveSegments: 2,
      });
      g.translate(0, 0, -depth / 2);
      g.computeVertexNormals();
      return g;
    };

    const wing = extrude((s) => {
      s.moveTo(0.00275, 0.00072);
      s.lineTo(-0.00285, 0.00532);
      s.lineTo(-0.00455, 0.00532);
      s.lineTo(-0.00415, 0.00072);
      s.closePath();
    }, 0.000030);

    const stab = extrude((s) => {
      s.moveTo(-0.00490, 0.00060);
      s.lineTo(-0.00680, 0.00245);
      s.lineTo(-0.00810, 0.00245);
      s.lineTo(-0.00790, 0.00060);
      s.closePath();
    }, 0.000022);

    const tail = extrude((s) => {
      s.moveTo(-0.00320, 0.00000);
      s.lineTo(-0.00740, 0.00200);
      s.lineTo(-0.00800, 0.00200);
      s.lineTo(-0.00770, 0.00000);
      s.closePath();
    }, 0.000022);
    tail.rotateX(-Math.PI / 2);

    return { fuselage, wing, stab, tail };
  }, []);

  return (
    <group>
      <mesh geometry={geo.fuselage}>
        <meshStandardMaterial color="#68737f" metalness={0.58} roughness={0.46} side={THREE.DoubleSide} />
      </mesh>

      {/* Bubble canopy. */}
      <mesh position={[0.00355, 0, -0.00034]} rotation={[0, 0, -Math.PI / 2]} scale={[1, 1.1, 0.72]}>
        <capsuleGeometry args={[0.00020, 0.00145, 8, 18]} />
        <meshPhysicalMaterial
          color="#15252f"
          metalness={0.35}
          roughness={0.08}
          clearcoat={1}
          clearcoatRoughness={0.05}
          emissive="#0a1a24"
          emissiveIntensity={0.5}
        />
      </mesh>

      {/* Intakes and inlet faces. */}
      {[1, -1].map((side) => (
        <group key={`intake${side}`} position={[0.00105, side * 0.00058, 0.00020]}>
          <mesh>
            <boxGeometry args={[0.00265, 0.00024, 0.00040]} />
            <meshStandardMaterial color="#5a646f" metalness={0.6} roughness={0.5} />
          </mesh>
          <mesh position={[0.00134, 0, 0]}>
            <boxGeometry args={[0.00003, 0.00018, 0.00030]} />
            <meshStandardMaterial color="#141a20" metalness={0.4} roughness={0.7} />
          </mesh>
        </group>
      ))}

      {/* Wings, horizontal stabilisers and canted vertical tails. */}
      {[1, -1].map((side) => (
        <mesh key={`wing${side}`} geometry={geo.wing} scale={[1, side, 1]}>
          <meshStandardMaterial color="#737e8a" metalness={0.55} roughness={0.5} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {[1, -1].map((side) => (
        <mesh key={`stab${side}`} geometry={geo.stab} scale={[1, side, 1]}>
          <meshStandardMaterial color="#6b7682" metalness={0.55} roughness={0.5} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {[1, -1].map((side) => (
        <group key={`tail${side}`} position={[-0.00555, side * 0.00032, 0]} rotation={[side * 0.42, 0, 0]}>
          <mesh geometry={geo.tail}>
            <meshStandardMaterial color="#6e7985" metalness={0.55} roughness={0.5} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}

      {/* Engine nozzle and faint heat glow. */}
      <mesh position={[-0.00734, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00034, 0.00042, 0.00024, 28, 1, true]} />
        <meshStandardMaterial color="#3a4047" metalness={0.9} roughness={0.3} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-0.00744, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <circleGeometry args={[0.00030, 24]} />
        <meshBasicMaterial color="#ff9a52" transparent opacity={0.28} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      {/* EOTS turret under the nose. */}
      <mesh position={[0.00455, 0, 0.00030]}>
        <sphereGeometry args={[0.00013, 16, 12]} />
        <meshStandardMaterial color="#1e2a35" metalness={0.5} roughness={0.15} />
      </mesh>

      {/* Wingtip navigation lights: red left, green right. */}
      <mesh position={[-0.00120, 0.00532, -0.00002]}>
        <sphereGeometry args={[0.000030, 8, 8]} />
        <meshBasicMaterial color="#ff4d4d" />
      </mesh>
      <mesh position={[-0.00120, -0.00532, -0.00002]}>
        <sphereGeometry args={[0.000030, 8, 8]} />
        <meshBasicMaterial color="#4dff9a" />
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
