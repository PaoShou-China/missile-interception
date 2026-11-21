import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, useTexture } from "@react-three/drei";
import * as THREE from "three";
import type { LoadedRun } from "./types";
import type { CameraPreset } from "./types";
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

function CompareVehicle({
  view,
  showAxes,
}: {
  view: CompareRunView;
  showAxes: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const fins = useRef<(THREE.Group | null)[]>([null, null, null, null]);
  const axes = useRef<THREE.Group>(null);
  const label = useRef<HTMLDivElement>(null);

  useFrame(() => {
    const s = sampleFor(view);
    const t = (view.timeKey === "A" ? compareClock.timeA : compareClock.timeB) + view.offset;
    const ended = t < view.run.meta.time_start || t > view.run.meta.time_end;
    if (group.current) {
      group.current.visible = !ended;
      group.current.position.set(s.position.x, s.position.y, s.position.z).multiplyScalar(KM);
      group.current.quaternion.set(s.attitude.x, s.attitude.y, s.attitude.z, s.attitude.w);
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

  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: view.color, metalness: 0.5, roughness: 0.4 }),
    [view.color],
  );

  return (
    <group ref={group} name={`compare-run-${view.tag}`}>
      <mesh material={material} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00017, 0.00017, 0.0056, 20]} />
      </mesh>
      <mesh material={material} position={[0.00305, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.00017, 0.0014, 20]} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <group key={i} position={[-0.00235, 0, 0]} rotation={[(i * Math.PI) / 2, 0, 0]}>
          <group ref={(el) => { fins.current[i] = el; }}>
            <mesh position={[0, 0.00030, 0]}>
              <boxGeometry args={[0.00044, 0.00030, 0.00002]} />
              <meshStandardMaterial color={view.color} metalness={0.5} roughness={0.45} />
            </mesh>
          </group>
        </group>
      ))}
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
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const t = (view.timeKey === "A" ? compareClock.timeA : compareClock.timeB) + view.offset;
    const ended = t < view.run.meta.time_start || t > view.run.meta.time_end;
    const s = view.run.targetSampler.sampleAt(t);
    if (ref.current) {
      ref.current.visible = !ended;
      ref.current.position.set(s.position.x, s.position.y, s.position.z).multiplyScalar(KM);
    }
  });
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[4, 12, 10]} />
      <meshBasicMaterial color={view.tag === "A" ? "#ffcf7a" : "#37b9d8"} />
    </mesh>
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
}: {
  runs: CompareRunView[];
  reference: CompareRunView;
  cameraPreset: CameraPreset;
  quality?: "low" | "medium";
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
        {runs.map((v) => (
          <CompareVehicle key={`veh-${v.tag}`} view={v} showAxes={cameraPreset === "attitude" || cameraPreset === "structure"} />
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
