import { Suspense, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { SpaceEnvironment } from "./SpaceEnvironment";
import { CameraRig } from "./CameraRig";
import { TrajectoryRibbon } from "./Trajectory";
import { EntityVisual, SurfaceBeacon } from "./Entities";
import { simClock, useAppStore } from "../state/store";
import { COLORS } from "./constants";
import { CINEMATIC_WALL_S, simToWall, wallToSim } from "../cinematic/shots";

/** Advances the single simulation clock and mirrors it to React state at low cadence. */
function ClockDriver() {
  const acc = useRef(0);
  const lastSyncedT = useRef(-1);
  useFrame((_, dt) => {
    const state = useAppStore.getState();
    if (state.presentation === "cinematic" && state.runtime) {
      if (simClock.playing) {
        const phases = state.runtime.manifest.phases;
        const wall = simToWall(simClock.time, phases);
        const nextWall = Math.min(CINEMATIC_WALL_S, wall + dt);
        simClock.seek(wallToSim(nextWall, phases));
        if (nextWall >= CINEMATIC_WALL_S) simClock.pause();
      }
    } else if (simClock.playing) {
      simClock.tick(dt);
    }
    // Decouple React UI re-renders from the 60 FPS WebGL loop: skip completely
    // while paused and throttle playback store mirrors to ~8 Hz (125 ms).
    acc.current += dt;
    if (acc.current >= 0.125) {
      acc.current = 0;
      if (Math.abs(simClock.time - lastSyncedT.current) > 1e-6 || simClock.playing !== state.playing) {
        lastSyncedT.current = simClock.time;
        state.syncTime();
      }
    }
  });
  return null;
}

/** Moderate HDR bloom for the high-quality tier only. */
function Effects() {
  const quality = useAppStore((s) => s.quality);
  if (quality !== "high") return null;
  return (
    <EffectComposer multisampling={0}>
      <Bloom
        intensity={0.34}
        luminanceThreshold={0.78}
        luminanceSmoothing={0.3}
        mipmapBlur
        radius={0.7}
      />
    </EffectComposer>
  );
}

function RendererSetup() {
  const { gl, scene, camera } = useThree();
  if (gl) {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.06;
    gl.outputColorSpace = THREE.SRGBColorSpace;
  }
  scene.fog = null;
  if (typeof window !== "undefined" && (import.meta.env.DEV || new URLSearchParams(location.search).has("qa"))) {
    (window as unknown as { __av?: unknown }).__av = { scene, camera, clock: simClock, store: useAppStore };
  }
  return null;
}

/** Small fill light at the camera keeps the vehicle legible when backlit. */
function CameraFillLight() {
  const light = useRef<THREE.PointLight>(null);
  useFrame(({ camera }) => {
    if (light.current) light.current.position.copy(camera.position);
  });
  return <pointLight ref={light} intensity={0.1} distance={0.3} decay={2} color="#cfe0ff" />;
}

function ScenarioScene({
  missileLabel,
  targetLabel,
  launchLabel,
  targetDatumLabel,
}: {
  missileLabel: string;
  targetLabel: string;
  launchLabel: string;
  targetDatumLabel: string;
}) {
  const runtime = useAppStore((s) => s.runtime);
  const presentation = useAppStore((s) => s.presentation);
  if (!runtime) return null;
  const { manifest } = runtime;
  return (
    <>
      <CameraFillLight />
      <SpaceEnvironment />
      <TrajectoryRibbon />
      <EntityVisual kind="missile" label={missileLabel} color={COLORS.accent} showLabel={presentation === "scientific"} />
      <EntityVisual kind="target" label={targetLabel} color={COLORS.cyan} showLabel={presentation === "scientific"} />
      <SurfaceBeacon
        latDeg={manifest.launchSite.latDeg}
        lonDeg={manifest.launchSite.lonDeg}
        altM={manifest.launchSite.altM}
        label={launchLabel}
        color={COLORS.accent}
        kind="launch"
      />
      <SurfaceBeacon
        latDeg={manifest.targetSite.latDeg}
        lonDeg={manifest.targetSite.lonDeg}
        altM={manifest.targetSite.altM}
        label={targetDatumLabel}
        color={COLORS.cyan}
        kind="target"
      />
      <CameraRig />
    </>
  );
}

export function SceneCanvas({
  missileLabel,
  targetLabel,
  launchLabel,
  targetDatumLabel,
}: {
  missileLabel: string;
  targetLabel: string;
  launchLabel: string;
  targetDatumLabel: string;
}) {
  const quality = useAppStore((s) => s.quality);
  const dpr: [number, number] = quality === "low" ? [1, 1.3] : quality === "medium" ? [1, 1.7] : [1, 2];
  return (
    <Canvas
      dpr={dpr}
      camera={{ fov: 43, near: 0.0008, far: 300000, position: [13000, 8000, 9000] }}
      gl={{ antialias: quality !== "low", powerPreference: "high-performance", logarithmicDepthBuffer: true, alpha: false }}
      className="scene-canvas"
    >
      <RendererSetup />
      <ClockDriver />
      <Suspense fallback={null}>
        <ScenarioScene
          missileLabel={missileLabel}
          targetLabel={targetLabel}
          launchLabel={launchLabel}
          targetDatumLabel={targetDatumLabel}
        />
      </Suspense>
      <Effects />
    </Canvas>
  );
}
