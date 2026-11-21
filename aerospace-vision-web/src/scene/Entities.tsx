import { useMemo, useRef, type RefObject } from "react";
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

/** Body-axis triad drawn in the vehicle body frame (x forward, y right, z down). */
function BodyAxes({ groupRef }: { groupRef: RefObject<THREE.Group | null> }) {
  const axes: { dir: [number, number, number]; rot: [number, number, number]; color: string }[] = [
    { dir: [1, 0, 0], rot: [0, 0, -Math.PI / 2], color: "#ff7a59" },
    { dir: [0, 1, 0], rot: [0, 0, 0], color: "#63e6ff" },
    { dir: [0, 0, 1], rot: [Math.PI / 2, 0, 0], color: "#7fe0a8" },
  ];
  const L = 0.0042;
  return (
    <group ref={groupRef} visible={false}>
      {axes.map((a) => (
        <group key={a.color}>
          <mesh position={[a.dir[0] * L * 0.5, a.dir[1] * L * 0.5, a.dir[2] * L * 0.5]} rotation={a.rot}>
            <cylinderGeometry args={[0.000007, 0.000007, L, 8]} />
            <meshBasicMaterial color={a.color} />
          </mesh>
          <mesh position={[a.dir[0] * L, a.dir[1] * L, a.dir[2] * L]} rotation={a.rot}>
            <coneGeometry args={[0.000022, 0.00010, 10]} />
            <meshBasicMaterial color={a.color} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Procedural high-fidelity interceptor, 6.5 m long, body +x forward, +z down. */
function MissileBody() {
  const plume = useRef<THREE.Group>(null);
  const nozzleGlow = useRef<THREE.Mesh>(null);
  const finUp = useRef<THREE.Group>(null);
  const finDown = useRef<THREE.Group>(null);
  const finLeft = useRef<THREE.Group>(null);
  const finRight = useRef<THREE.Group>(null);
  const axes = useRef<THREE.Group>(null);

  // Smooth ogive/boattail body produced by a lathe profile, plus a tapered
  // extruded fin shared by all four tail surfaces.
  const { bodyGeo, finGeo, strakeGeo } = useMemo(() => {
    const profile: [number, number][] = [
      [0.000105, -0.00300],
      [0.000145, -0.00286],
      [0.000170, -0.00240],
      [0.000170, 0.00160],
      [0.000168, 0.00200],
      [0.000160, 0.00230],
      [0.000138, 0.00265],
      [0.000104, 0.00295],
      [0.000060, 0.00325],
      [0.000018, 0.00350],
    ];
    const body = new THREE.LatheGeometry(
      profile.map(([r, y]) => new THREE.Vector2(r, y)),
      64,
    );
    body.rotateZ(-Math.PI / 2); // +Y -> +X
    body.computeVertexNormals();

    // Slender, tapered tail fin: ~0.48 m chord, ~0.30 m semi-span.
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(-0.00048, 0.000045);
    shape.lineTo(-0.00043, 0.00027);
    shape.lineTo(-0.00003, 0.00030);
    shape.closePath();
    const fin = new THREE.ExtrudeGeometry(shape, {
      depth: 0.000022,
      bevelEnabled: true,
      bevelThickness: 0.000004,
      bevelSize: 0.000004,
      bevelSegments: 2,
      curveSegments: 2,
    });
    fin.translate(0, 0, -0.000011);
    fin.computeVertexNormals();

    // Long, slender leading-edge strake wing (边条翼), blended into the body
    // and swept back from the forward fuselage to the wing root.
    const strake = new THREE.Shape();
    strake.moveTo(0.00235, 0.000155);
    strake.lineTo(-0.00195, 0.000155);
    strake.lineTo(-0.00135, 0.000305);
    strake.lineTo(0.00045, 0.000475);
    strake.closePath();
    const strakeGeo = new THREE.ExtrudeGeometry(strake, {
      depth: 0.000014,
      bevelEnabled: true,
      bevelThickness: 0.000003,
      bevelSize: 0.000003,
      bevelSegments: 1,
      curveSegments: 2,
    });
    strakeGeo.translate(0, 0, -0.000007);
    strakeGeo.computeVertexNormals();

    return { bodyGeo: body, finGeo: fin, strakeGeo };
  }, []);

  const finAngles: { key: string; angle: number; ref: RefObject<THREE.Group | null> }[] = [
    { key: "right", angle: 0, ref: finRight },
    { key: "up", angle: -Math.PI / 2, ref: finUp },
    { key: "left", angle: Math.PI, ref: finLeft },
    { key: "down", angle: Math.PI / 2, ref: finDown },
  ];

  useFrame(({ clock }) => {
    const rt = useAppStore.getState().runtime;
    const boostEnd = rt?.manifest.phases.find((p) => p.phase === "boost")?.endT ?? 20;
    const powered = simClock.time <= boostEnd;
    if (plume.current) {
      plume.current.visible = powered;
      const flicker = 1 + 0.07 * Math.sin(clock.elapsedTime * 47);
      plume.current.scale.set(flicker, flicker, flicker);
    }
    if (nozzleGlow.current) nozzleGlow.current.visible = powered;

    if (rt) {
      const s = rt.missileSampler.sampleAt(simClock.time);
      const f = s.finDeflectionsRad;
      const clamp = (v: number) => Math.max(-0.55, Math.min(0.55, v));
      if (finUp.current) finUp.current.rotation.y = clamp(f.up);
      if (finDown.current) finDown.current.rotation.y = clamp(f.down);
      if (finLeft.current) finLeft.current.rotation.y = clamp(f.left);
      if (finRight.current) finRight.current.rotation.y = clamp(f.right);
    }
    if (axes.current) {
      const mode = useAppStore.getState().cameraMode;
      axes.current.visible = mode === "attitude";
    }
  });

  return (
    <group>
      {/* Monocoque body with ogive radome and boat-tail. */}
      <mesh geometry={bodyGeo}>
        <meshPhysicalMaterial
          color="#e9eff6"
          metalness={0.42}
          roughness={0.34}
          clearcoat={0.65}
          clearcoatRoughness={0.28}
          emissive="#1a2733"
          emissiveIntensity={0.18}
        />
      </mesh>

      {/* Seeker radome window. */}
      <mesh position={[0.00334, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.000055, 0.00020, 24, 1, true]} />
        <meshPhysicalMaterial
          color="#10283d"
          metalness={0.25}
          roughness={0.12}
          clearcoat={1}
          emissive={COLORS.cyan}
          emissiveIntensity={0.55}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Panel rings / interfaces. */}
      {[0.00125, 0.00174, -0.00055].map((x) => (
        <mesh key={x} position={[x, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[0.000171, 0.000004, 8, 48]} />
          <meshStandardMaterial color="#8b99a8" metalness={0.75} roughness={0.35} />
        </mesh>
      ))}
      {/* Service band and accent stripe. */}
      <mesh position={[-0.00115, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.000173, 0.000173, 0.000035, 48]} />
        <meshStandardMaterial color="#26313d" metalness={0.6} roughness={0.45} />
      </mesh>
      <mesh position={[0.00195, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.000171, 0.000171, 0.000028, 48]} />
        <meshStandardMaterial color={COLORS.accent} emissive={COLORS.accent} emissiveIntensity={0.35} metalness={0.5} roughness={0.3} />
      </mesh>

      {/* Leading-edge strake wings, one per side. */}
      {[1, -1].map((side) => (
        <mesh key={`strake${side}`} geometry={strakeGeo} scale={[1, side, 1]}>
          <meshStandardMaterial color="#8a929c" metalness={0.62} roughness={0.42} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {/* Forward canards. */}
      {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((a) => (
        <group key={`c${a}`} position={[0.00164, 0, 0]} rotation={[a, 0, 0]}>
          <mesh geometry={finGeo} position={[0, 0.000165, 0]} scale={[0.36, 0.36, 0.36]}>
            <meshStandardMaterial color="#5d6874" metalness={0.65} roughness={0.42} />
          </mesh>
        </group>
      ))}

      {/* Cruciform tail fins. Inner group rotation is driven by recorded fin data. */}
      {finAngles.map(({ key, angle, ref }) => (
        <group key={key} position={[-0.00242, 0, 0]} rotation={[angle, 0, 0]}>
          <group ref={ref}>
            <mesh geometry={finGeo} position={[0, 0.000166, 0]}>
              <meshStandardMaterial color="#9aa6b2" metalness={0.7} roughness={0.38} side={THREE.DoubleSide} />
            </mesh>
          </group>
        </group>
      ))}

      {/* Nozzle bell and throat glow. */}
      <mesh position={[-0.00302, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00012, 0.00016, 0.00022, 32, 1, true]} />
        <meshStandardMaterial color="#3a3f47" metalness={0.92} roughness={0.28} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={nozzleGlow} position={[-0.00313, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <circleGeometry args={[0.000105, 28]} />
        <meshBasicMaterial color="#ffc078" transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>

      {/* Layered exhaust plume. */}
      <group ref={plume} position={[-0.00318, 0, 0]}>
        {[
          { len: 0.00055, r: 0.000085, color: "#fff6dc", opacity: 1 },
          { len: 0.00095, r: 0.000110, color: "#ffb35c", opacity: 0.6 },
          { len: 0.00145, r: 0.000150, color: "#6fd4ff", opacity: 0.26 },
        ].map((p) => (
          <mesh key={p.len} position={[0, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <coneGeometry args={[p.r, p.len, 20, 1, true]} />
            <meshBasicMaterial color={p.color} transparent opacity={p.opacity} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>

      <BodyAxes groupRef={axes} />
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
