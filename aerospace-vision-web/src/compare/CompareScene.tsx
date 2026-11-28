import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, useTexture } from "@react-three/drei";
import * as THREE from "three";
import type { LoadedRun } from "./types";
import type { CameraPreset } from "./types";
import type { CampaignStat } from "./registry";
import { KM, ASSET_BASE } from "../scene/constants";
import { compareClock } from "./clock";
import { TrajectorySampler } from "../scientific/interpolate";
import { skyStateAt } from "../scientific/astronomy";
import { useAppStore } from "../state/store";

export interface CompareRunView {
  run: LoadedRun & { sampler: TrajectorySampler; targetSampler: TrajectorySampler };
  color: string;
  tag: "A" | "B";
  timeKey: "A" | "B";
  offset: number;
  mcStat?: CampaignStat | null;
}

function sampleFor(view: CompareRunView) {
  const t = (view.timeKey === "A" ? compareClock.timeA : compareClock.timeB) + view.offset;
  return view.run.sampler.sampleAt(t);
}

/** Minimal Earth + shared sun for both comparison canvases. */
function CompareEnvironment() {
  const tex = useTexture(`${ASSET_BASE}earth_day_2048.jpg`);
  useMemo(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
  }, [tex]);
  const light = useRef<THREE.DirectionalLight>(null);
  const sun = useRef(new THREE.Vector3(1, 0, 0));
  const acc = useRef(0);
  const runtime = useAppStore((s) => s.runtime);

  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.5) return;
    acc.current = 0;
    const demo = runtime?.manifest.time.demoUtc ?? "2026-11-20T02:00:00Z";
    const sky = skyStateAt(demo, compareClock.timeA);
    sun.current.set(sky.sun.x, sky.sun.y, sky.sun.z);
    light.current?.position.copy(sun.current).multiplyScalar(60000);
  });

  return (
    <>
      <color attach="background" args={["#02050b"]} />
      <ambientLight intensity={0.42} />
      <hemisphereLight args={["#7fb2ff", "#0a0f1c", 0.3]} />
      <directionalLight ref={light} position={[30000, 0, 0]} intensity={2.6} color="#fff4e0" />
      <mesh scale={[6378, 6378, 6357]}>
        <sphereGeometry args={[1, 72, 48]} />
        <meshStandardMaterial map={tex} roughness={0.95} metalness={0.01} />
      </mesh>
      <mesh scale={6387}>
        <sphereGeometry args={[1, 48, 32]} />
        <meshBasicMaterial color="#2f7fd0" transparent opacity={0.07} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.BackSide} />
      </mesh>
    </>
  );
}

function CompareTrajectory({ run, color }: { run: LoadedRun; color: string }) {
  const line = useMemo(() => {
    const pts = run.missile.map((s) => new THREE.Vector3(s.position.x, s.position.y, s.position.z).multiplyScalar(KM));
    const geometry = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.78 }));
  }, [run, color]);
  return <primitive object={line} />;
}

/** Deterministic PRNG for reproducible Monte-Carlo dispersion visualization. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 3D Monte-Carlo dispersion bundle (24-48 trajectories + semi-transparent envelope
 * tube + InstancedMesh handover point cloud) parameterised by campaign.json stats.
 */
function MonteCarloBundle({ view }: { view: CompareRunView }) {
  const cloudRef = useRef<THREE.InstancedMesh>(null);
  const stat = view.mcStat;
  const count = Math.max(24, Math.min(48, stat?.n_valid ?? 24));

  const { bundleLines, tubeGeo, handoverPts } = useMemo(() => {
    const src = view.run.missile;
    const step = Math.max(1, Math.floor(src.length / 72));
    const base: THREE.Vector3[] = [];
    for (let i = 0; i < src.length; i += step) {
      base.push(new THREE.Vector3(src[i].position.x, src[i].position.y, src[i].position.z).multiplyScalar(KM));
    }
    const last = src[src.length - 1];
    base.push(new THREE.Vector3(last.position.x, last.position.y, last.position.z).multiplyScalar(KM));

    const leadDeg = stat?.handover_lead_deg ?? (view.tag === "A" ? 8.5 : 5.2);
    const missStd = stat?.miss_std ?? (view.tag === "A" ? 7.5 : 3.5);
    const latSpreadKm = Math.max(1.5, Math.min(18, leadDeg * 1.15 + missStd * 0.45));
    const vertSpreadKm = Math.max(0.8, Math.min(8, latSpreadKm * 0.42));

    const rng = mulberry32(view.tag === "A" ? 202601 : 202602);
    const segs: number[] = [];
    const hoPts: THREE.Vector3[] = [];
    const hoIdx = Math.max(2, base.length - 5);

    for (let k = 0; k < count; k++) {
      const u1 = Math.max(1e-6, rng());
      const u2 = rng();
      const zLat = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const zVert = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
      const phase = rng() * Math.PI * 2;
      let prev: THREE.Vector3 | null = null;
      for (let i = 0; i < base.length; i++) {
        const frac = i / Math.max(1, base.length - 1);
        const p = base[i];
        const up = p.clone().normalize();
        const tang =
          i < base.length - 1
            ? base[i + 1].clone().sub(p).normalize()
            : p.clone().sub(base[i - 1]).normalize();
        const side = new THREE.Vector3().crossVectors(tang, up).normalize();
        const env = Math.sin(frac * Math.PI) * 0.82 + frac * 0.32;
        const wave = 1 + 0.14 * Math.sin(frac * 9 + phase);
        const pt = p
          .clone()
          .addScaledVector(side, zLat * latSpreadKm * env * wave)
          .addScaledVector(up, zVert * vertSpreadKm * env);
        if (prev) segs.push(prev.x, prev.y, prev.z, pt.x, pt.y, pt.z);
        if (i === hoIdx) hoPts.push(pt.clone());
        prev = pt;
      }
    }

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
    const lineObj = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({ color: view.color, transparent: true, opacity: 0.24, depthWrite: false }),
    );
    const curve = new THREE.CatmullRomCurve3(base);
    const tube = new THREE.TubeGeometry(curve, 64, Math.max(1.2, latSpreadKm * 0.45), 10, false);
    return { bundleLines: lineObj, tubeGeo: tube, handoverPts: hoPts };
  }, [view.run, view.color, view.tag, stat, count]);

  useEffect(() => {
    const mesh = cloudRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < handoverPts.length; i++) {
      dummy.position.copy(handoverPts[i]);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [handoverPts]);

  return (
    <group name={`mc-bundle-${view.tag}`}>
      <primitive object={bundleLines} />
      <mesh geometry={tubeGeo}>
        <meshBasicMaterial
          color={view.color}
          transparent
          opacity={0.07}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <instancedMesh ref={cloudRef} args={[undefined, undefined, handoverPts.length]}>
        <sphereGeometry args={[2.6, 10, 8]} />
        <meshBasicMaterial color={view.color} transparent opacity={0.85} />
      </instancedMesh>
    </group>
  );
}

function CompareVehicle({
  view,
  showAxes,
  modelScale,
}: {
  view: CompareRunView;
  showAxes: boolean;
  modelScale: number;
}) {
  const group = useRef<THREE.Group>(null);
  const fins = useRef<(THREE.Group | null)[]>([null, null, null, null]);
  const plumeRef = useRef<THREE.Mesh>(null);
  const axes = useRef<THREE.Group>(null);
  const label = useRef<HTMLDivElement>(null);

  const geo = useMemo(() => {
    // Sleek 8.11 m scramjet lifting-body silhouette (ogive + strakes + beveled tail fins)
    const profile: [number, number][] = [
      [0.000175, -0.00310],
      [0.000255, -0.00275],
      [0.000275, -0.00220],
      [0.000275, 0.00175],
      [0.000245, 0.00245],
      [0.000180, 0.00305],
      [0.000090, 0.00365],
      [0.000012, 0.00405],
    ];
    const body = new THREE.LatheGeometry(
      profile.map(([r, y]) => new THREE.Vector2(r, y)),
      36,
    );
    body.rotateZ(-Math.PI / 2);
    body.computeVertexNormals();

    const fShape = new THREE.Shape();
    fShape.moveTo(0.00010, 0);
    fShape.lineTo(-0.00046, 0.00005);
    fShape.lineTo(-0.00042, 0.00034);
    fShape.lineTo(-0.00004, 0.00035);
    fShape.closePath();
    const fin = new THREE.ExtrudeGeometry(fShape, {
      depth: 0.000024,
      bevelEnabled: true,
      bevelThickness: 0.000006,
      bevelSize: 0.000006,
      bevelSegments: 1,
    });
    fin.translate(0, 0, -0.000012);
    fin.computeVertexNormals();

    const sShape = new THREE.Shape();
    sShape.moveTo(0.00175, 0.000255);
    sShape.lineTo(-0.00190, 0.000255);
    sShape.lineTo(-0.00160, 0.000610);
    sShape.lineTo(-0.00005, 0.000610);
    sShape.closePath();
    const strake = new THREE.ExtrudeGeometry(sShape, {
      depth: 0.000018,
      bevelEnabled: true,
      bevelThickness: 0.000005,
      bevelSize: 0.000005,
      bevelSegments: 1,
    });
    strake.translate(0, 0, -0.000009);
    strake.computeVertexNormals();

    return { body, fin, strake };
  }, []);

  useFrame(({ clock }) => {
    const s = sampleFor(view);
    const t = (view.timeKey === "A" ? compareClock.timeA : compareClock.timeB) + view.offset;
    const ended = t < view.run.meta.time_start || t > view.run.meta.time_end;
    if (group.current) {
      group.current.visible = !ended;
      group.current.position.set(s.position.x, s.position.y, s.position.z).multiplyScalar(KM);
      group.current.quaternion.set(s.attitude.x, s.attitude.y, s.attitude.z, s.attitude.w);
    }
    if (plumeRef.current) {
      const powered = !ended && (t < 13.5 || (s.mach >= 1.55 && s.altM < 32200 && s.massKg > 1002));
      plumeRef.current.visible = powered;
      if (powered) {
        const flick = 0.92 + 0.12 * Math.sin(clock.elapsedTime * 48);
        plumeRef.current.scale.set(1, (t < 13.5 ? 1.35 : 0.92) * flick, 1);
      }
    }
    if (label.current) {
      label.current.style.opacity = ended ? "0" : "1";
      label.current.textContent = ended ? `${view.tag} · ENDED` : view.tag;
    }
    const f = s.finDeflectionsRad;
    if (f) {
      const clamp = (v: number) => Math.max(-0.55, Math.min(0.55, v));
      fins.current[0]?.rotation.set(0, clamp(f.up), 0);
      fins.current[1]?.rotation.set(0, clamp(f.down), 0);
      fins.current[2]?.rotation.set(0, clamp(f.left), 0);
      fins.current[3]?.rotation.set(0, clamp(f.right), 0);
    }
    if (axes.current) axes.current.visible = showAxes;
  });

  const hullMat = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: "#dce5ef",
        metalness: 0.45,
        roughness: 0.32,
        clearcoat: 0.65,
      }),
    [],
  );
  const accentMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: view.color,
        emissive: view.color,
        emissiveIntensity: 0.42,
        metalness: 0.52,
        roughness: 0.34,
      }),
    [view.color],
  );

  return (
    <group ref={group} name={`compare-run-${view.tag}`} scale={modelScale}>
      {/* Ogive fuselage + C-SiC tip + algorithm identity stripe */}
      <mesh geometry={geo.body} material={hullMat} />
      <mesh position={[0.00205, 0, 0]} rotation={[0, 0, -Math.PI / 2]} material={accentMat}>
        <cylinderGeometry args={[0.000278, 0.000278, 0.00038, 28]} />
      </mesh>
      {/* Twin scramjet intake nacelles */}
      {[1, -1].map((side) => (
        <mesh key={`ci-${side}`} position={[-0.00025, side * 0.000275, 0.00009]}>
          <boxGeometry args={[0.0024, 0.00015, 0.00018]} />
          <meshStandardMaterial color="#4e5864" metalness={0.68} roughness={0.36} />
        </mesh>
      ))}
      {/* Swept lifting strakes */}
      {[1, -1].map((side) => (
        <mesh key={`cs-${side}`} geometry={geo.strake} scale={[1, side, 1]}>
          <meshStandardMaterial color="#7b8692" metalness={0.62} roughness={0.38} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* Beveled cruciform tail fins */}
      {[0, 1, 2, 3].map((i) => (
        <group key={i} position={[-0.00242, 0, 0]} rotation={[(i * Math.PI) / 2, 0, 0]}>
          <group ref={(el) => { fins.current[i] = el; }}>
            <mesh geometry={geo.fin} position={[0, 0.000265, 0]} material={accentMat} />
          </group>
        </group>
      ))}
      {/* Nozzle & glowing exhaust jet */}
      <mesh position={[-0.00318, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00018, 0.00023, 0.00026, 20, 1, true]} />
        <meshStandardMaterial color="#383e46" metalness={0.9} roughness={0.28} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={plumeRef} position={[-0.00455, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00018, 0.00002, 0.0025, 16, 1, true]} />
        <meshBasicMaterial
          color={view.color}
          transparent
          opacity={0.78}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {showAxes && (
        <group ref={axes}>
          {[
            { dir: [1, 0, 0], rot: [0, 0, -Math.PI / 2], color: "#ff7a59" },
            { dir: [0, 1, 0], rot: [0, 0, 0], color: "#63e6ff" },
            { dir: [0, 0, 1], rot: [Math.PI / 2, 0, 0], color: "#7fe0a8" },
          ].map((a) => (
            <mesh key={a.color} position={[a.dir[0] * 0.0022, a.dir[1] * 0.0022, a.dir[2] * 0.0022]} rotation={a.rot as [number, number, number]}>
              <cylinderGeometry args={[0.000006, 0.000006, 0.0044, 6]} />
              <meshBasicMaterial color={a.color} />
            </mesh>
          ))}
        </group>
      )}
      <Html position={[0, 0.0008, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        <div ref={label} className={`compare-entity-tag compare-entity-tag--${view.tag}`}>{view.tag}</div>
      </Html>
    </group>
  );
}

function CompareTargets({ runs }: { runs: CompareRunView[] }) {
  return (
    <>
      {runs.map((v) => (
        <TargetMarker key={`t-${v.tag}`} view={v} />
      ))}
    </>
  );
}

function TargetMarker({ view }: { view: CompareRunView }) {
  const ref = useRef<THREE.Group>(null);
  const velDir = useMemo(() => new THREE.Vector3(), []);
  const unitX = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);

  const wingGeo = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(3.2, 0);
    s.lineTo(-1.8, 5.2);
    s.lineTo(-3.4, 5.2);
    s.lineTo(-4.2, 0);
    s.lineTo(-3.4, -5.2);
    s.lineTo(-1.8, -5.2);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.4, bevelEnabled: false });
    g.translate(0, 0, -0.2);
    return g;
  }, []);

  useFrame(() => {
    const t = (view.timeKey === "A" ? compareClock.timeA : compareClock.timeB) + view.offset;
    const ended = t < view.run.meta.time_start || t > view.run.meta.time_end;
    const s = view.run.targetSampler.sampleAt(t);
    if (ref.current) {
      ref.current.visible = !ended;
      ref.current.position.set(s.position.x, s.position.y, s.position.z).multiplyScalar(KM);
      velDir.set(s.velocity.x, s.velocity.y, s.velocity.z);
      if (velDir.lengthSq() > 1e-6) {
        velDir.normalize();
        quat.setFromUnitVectors(unitX, velDir);
        ref.current.quaternion.copy(quat);
      }
    }
  });
  const col = view.tag === "A" ? "#ffcf7a" : "#37b9d8";
  return (
    <group ref={ref} scale={0.75}>
      <mesh rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[1.35, 11, 10]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.45} metalness={0.5} roughness={0.35} />
      </mesh>
      <mesh geometry={wingGeo}>
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.35} metalness={0.45} roughness={0.4} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Deterministic camera rule shared by both side-by-side canvases. */
function CompareCamera({ reference, preset }: { reference: CompareRunView; preset: CameraPreset }) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3());
  const initialized = useRef(false);

  useFrame((_, dt) => {
    const s = sampleFor(reference);
    const t = (reference.timeKey === "A" ? compareClock.timeA : compareClock.timeB) + reference.offset;
    const ended = t < reference.run.meta.time_start || t > reference.run.meta.time_end;
    const pos = new THREE.Vector3(s.position.x, s.position.y, s.position.z).multiplyScalar(KM);
    const vel = new THREE.Vector3(s.velocity.x, s.velocity.y, s.velocity.z).normalize();
    const up = pos.clone().normalize();
    const desiredPos = new THREE.Vector3();
    const desiredLook = new THREE.Vector3();
    let camUp = up;

    if (preset === "global") {
      const anchor = new THREE.Vector3(
        reference.run.missile[0].position.x,
        reference.run.missile[0].position.y,
        reference.run.missile[0].position.z,
      ).multiplyScalar(KM);
      const dir = anchor.clone().normalize();
      desiredPos.copy(dir).multiplyScalar(13500).applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.62);
      desiredLook.copy(anchor);
    } else if (preset === "flight") {
      const side = new THREE.Vector3().crossVectors(vel, up).normalize();
      desiredPos.copy(pos).addScaledVector(vel, -0.06).addScaledVector(up, 0.014).addScaledVector(side, 0.006);
      desiredLook.copy(pos).addScaledVector(vel, 0.02);
    } else {
      const q = new THREE.Quaternion(s.attitude.x, s.attitude.y, s.attitude.z, s.attitude.w);
      camUp = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      if (preset === "attitude") {
        desiredPos.copy(pos).add(new THREE.Vector3(0.0007, 0.0060, -0.0050).applyQuaternion(q));
        desiredLook.copy(pos);
      } else {
        desiredPos.copy(pos).add(new THREE.Vector3(-0.0028, 0.0013, -0.0015).applyQuaternion(q));
        desiredLook.copy(pos).add(new THREE.Vector3(-0.0023, 0, 0).applyQuaternion(q));
      }
    }

    if (ended) {
      // Keep the last valid frame but do not pretend the run continues.
      if (!initialized.current) return;
    }
    const k = initialized.current ? 1 - Math.exp(-4 * Math.min(dt, 0.1)) : 1;
    camera.position.lerp(desiredPos, k);
    look.current.lerp(desiredLook, k);
    camera.up.copy(camUp);
    camera.lookAt(look.current);
    camera.updateProjectionMatrix();
    initialized.current = true;
  });

  return null;
}

export function CompareScene({
  runs,
  reference,
  cameraPreset,
  quality = "low",
  modelScale = 1,
  showMcBundle = false,
}: {
  runs: CompareRunView[];
  reference: CompareRunView;
  cameraPreset: CameraPreset;
  quality?: "low" | "medium";
  modelScale?: number;
  showMcBundle?: boolean;
}) {
  return (
    <Canvas
      dpr={quality === "low" ? [1, 1.25] : [1, 1.6]}
      camera={{ fov: 42, near: 0.0008, far: 250000, position: [12000, 7000, 9000] }}
      gl={{ antialias: false, powerPreference: "high-performance", logarithmicDepthBuffer: true }}
      className="compare-canvas"
    >
      <Suspense fallback={null}>
        <CompareEnvironment />
        {runs.map((v) => (
          <CompareTrajectory key={`line-${v.tag}`} run={v.run} color={v.color} />
        ))}
        {showMcBundle && runs.map((v) => (
          <MonteCarloBundle key={`mc-${v.tag}`} view={v} />
        ))}
        {runs.map((v) => (
          <CompareVehicle key={`veh-${v.tag}`} view={v} modelScale={modelScale} showAxes={cameraPreset === "attitude" || cameraPreset === "structure"} />
        ))}
        <CompareTargets runs={runs} />
      </Suspense>
      <CompareCamera reference={reference} preset={cameraPreset} />
    </Canvas>
  );
}

/** Attach samplers once per loaded run. */
export function withSamplers(run: LoadedRun): CompareRunView["run"] {
  return {
    ...run,
    sampler: new TrajectorySampler(run.missile),
    targetSampler: new TrajectorySampler(run.target),
  };
}

export type { LoadedRun };
