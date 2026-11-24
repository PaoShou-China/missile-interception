import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { simClock, useAppStore } from "../state/store";
import { COLORS, KM } from "./constants";
import type { TrajectorySample } from "../scientific/types";

function positionsArray(samples: TrajectorySample[]): Float32Array {
  const arr = new Float32Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    arr[i * 3] = samples[i].position.x * KM;
    arr[i * 3 + 1] = samples[i].position.y * KM;
    arr[i * 3 + 2] = samples[i].position.z * KM;
  }
  return arr;
}

function makeGeometry(samples: TrajectorySample[], colored = false): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positionsArray(samples), 3));
  if (colored) {
    const colors = new Float32Array(samples.length * 3);
    const low = new THREE.Color("#2078bf");
    const high = new THREE.Color("#a8ecff");
    const c = new THREE.Color();
    for (let i = 0; i < samples.length; i++) {
      const f = Math.min(1, Math.max(0, samples[i].altM / 30000));
      c.copy(low).lerp(high, f);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  return g;
}

/**
 * Full mission trajectory (dim) plus the flown portion (bright).
 * The bright line is revealed with drawRange — no per-frame React updates.
 */
export function TrajectoryRibbon() {
  const runtime = useAppStore((s) => s.runtime);
  const presentation = useAppStore((s) => s.presentation);
  const emphasis = useAppStore((s) => s.trackEmphasis);
  const missile = runtime?.missile ?? [];
  const target = runtime?.target ?? [];

  const fullGeom = useMemo(() => makeGeometry(missile, true), [missile]);
  const flownGeom = useMemo(() => makeGeometry(missile), [missile]);
  const targetGeom = useMemo(() => makeGeometry(target), [target]);
  const fullLine = useMemo(() => new THREE.Line(
    fullGeom,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }),
  ), [fullGeom]);
  const flownLine = useMemo(() => new THREE.Line(
    flownGeom,
    new THREE.LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.95, depthWrite: false }),
  ), [flownGeom]);
  const targetLine = useMemo(() => new THREE.Line(
    targetGeom,
    new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.3, depthWrite: false }),
  ), [targetGeom]);
  const dotGeom = useMemo(() => {
    const stride = 10;
    const count = Math.ceil(missile.length / stride);
    const arr = new Float32Array(count * 3);
    let k = 0;
    for (let i = 0; i < missile.length; i += stride) {
      arr[k++] = missile[i].position.x * KM;
      arr[k++] = missile[i].position.y * KM;
      arr[k++] = missile[i].position.z * KM;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr.slice(0, k), 3));
    return g;
  }, [missile]);

  // Orbital-scale track cord. The tube's radius is a symbol for visibility;
  // its centreline is exactly the telemetry path. It is hidden at close range.
  const tube = useMemo(() => {
    if (missile.length < 2) return null;
    const pts = missile
      .filter((_, i) => i % 4 === 0 || i === missile.length - 1)
      .map((s) => new THREE.Vector3(s.position.x * KM, s.position.y * KM, s.position.z * KM));
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    const geom = new THREE.TubeGeometry(curve, 900, 3.0, 4, false);
    const pos = geom.getAttribute("position");
    const colors = new Float32Array(pos.count * 3);
    const low = new THREE.Color("#2078bf");
    const high = new THREE.Color("#a8ecff");
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      const f = Math.min(1, Math.max(0, (r - 6371) / 30));
      c.copy(low).lerp(high, f);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geom;
  }, [missile]);
  const tubeRef = useRef<THREE.Mesh>(null);
  const dotsRef = useRef<THREE.Points>(null);
  const traveled = useRef<THREE.Line | null>(null);
  const head = useRef<THREE.Sprite>(null);
  const ring = useRef<THREE.Group>(null);
  const lastCount = useRef(-1);

  const headTexture = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(122,222,244,0.8)");
    g.addColorStop(1, "rgba(32,120,191,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);

  const intercept = useMemo(() => {
    if (!runtime) return null;
    const ev = runtime.manifest.events.find((e) => e.kind === "intercept");
    if (!ev) return null;
    const s = runtime.missileSampler.sampleAt(ev.t);
    return {
      t: ev.t,
      pos: new THREE.Vector3(s.position.x * KM, s.position.y * KM, s.position.z * KM),
    };
  }, [runtime]);

  useFrame(({ camera, clock }) => {
    const rt = useAppStore.getState().runtime;
    if (!rt || !traveled.current) return;
    const count = rt.missileSampler.indexAt(simClock.time) + 1;
    if (count !== lastCount.current) {
      const geom = traveled.current.geometry;
      (geom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      geom.setDrawRange(0, count);
      lastCount.current = count;
    }
    if (head.current) {
      const s = rt.missileSampler.sampleAt(simClock.time);
      head.current.position.set(s.position.x * KM, s.position.y * KM, s.position.z * KM);
      const d = camera.position.distanceTo(head.current.position);
      head.current.scale.setScalar(Math.max(0.02, d * 0.008));
      (head.current.material as THREE.SpriteMaterial).opacity =
        THREE.MathUtils.clamp((d - 0.6) / 2, 0, 1);
    }
    if (ring.current && intercept) {
      const local = Math.abs(simClock.time - intercept.t);
      const pulse = 1 + 0.25 * Math.sin(clock.elapsedTime * 4);
      ring.current.scale.setScalar((1 + local * 0.6) * pulse);
      ring.current.position.copy(intercept.pos);
    }
    if (tubeRef.current) {
      tubeRef.current.visible = emphasis && camera.position.length() > 6371 * 1.12;
    }
    if (dotsRef.current) {
      dotsRef.current.visible = emphasis;
    }
  });

  if (!runtime) return null;

  return (
    <group>
      <primitive object={fullLine} />
      {tube && (
        <mesh ref={tubeRef} geometry={tube}>
          <meshBasicMaterial vertexColors transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      )}
      <points ref={dotsRef} geometry={dotGeom}>
        <pointsMaterial
          color={COLORS.accentSoft}
          size={2.2}
          sizeAttenuation={false}
          transparent
          opacity={0.55}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      <primitive ref={traveled} object={flownLine} />
      <primitive object={targetLine} />
      <sprite ref={head} scale={0.02}>
        <spriteMaterial map={headTexture} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {intercept && (
        <group ref={ring} position={intercept.pos}>
          <mesh>
            <ringGeometry args={[0.012, 0.018, 48]} />
            <meshBasicMaterial
              color={COLORS.danger}
              transparent
              opacity={0.85}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          <mesh>
            <ringGeometry args={[0.03, 0.033, 48]} />
            <meshBasicMaterial color={COLORS.accentSoft} transparent opacity={0.35} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        </group>
      )}

      {presentation === "scientific" && (
        <mesh position={intercept?.pos ?? [0, 0, 0]} visible={!!intercept}>
          <sphereGeometry args={[0.006, 12, 8]} />
          <meshBasicMaterial color={COLORS.danger} transparent opacity={0.9} />
        </mesh>
      )}
    </group>
  );
}
