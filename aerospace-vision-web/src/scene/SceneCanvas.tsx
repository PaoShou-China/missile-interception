import { Suspense, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SpaceEnvironment } from "./SpaceEnvironment";
import { CameraRig } from "./CameraRig";
import { TrajectoryRibbon } from "./Trajectory";
import { EntityVisual, SurfaceBeacon } from "./Entities";
import { simClock, useAppStore } from "../state/store";
import { COLORS } from "./constants";

/** Advances the single simulation clock and mirrors it to React state. */
function ClockDriver() {
  const acc = useRef(0);
  useFrame((_, dt) => {
    if (simClock.playing) simClock.tick(dt);
    acc.current += dt;
    if (acc.current >= 0.05) {
      acc.current = 0;
      useAppStore.getState().syncTime();
    }
  });
  return null;
}

function RendererSetup() {
  const { gl, scene } = useThree();
  if (gl) {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.06;
    gl.outputColorSpace = THREE.SRGBColorSpace;
  }
  scene.fog = null;
  return null;
}

function ScenarioScene() {
  const runtime = useAppStore((s) => s.runtime);
  const presentation = useAppStore((s) => s.presentation);
  if (!runtime) return null;
  const { manifest } = runtime;
  return (
    <>
      <SpaceEnvironment />
      <TrajectoryRibbon />
      <EntityVisual kind="missile" label="INTERCEPTOR" color={COLORS.accent} showLabel={presentation === "scientific"} />
      <EntityVisual kind="target" label="TARGET" color={COLORS.cyan} showLabel={presentation === "scientific"} />
      <SurfaceBeacon
        latDeg={manifest.launchSite.latDeg}
        lonDeg={manifest.launchSite.lonDeg}
        altM={manifest.launchSite.altM}
        label={manifest.launchSite.label}
        color={COLORS.accent}
        kind="launch"
      />
      <SurfaceBeacon
        latDeg={manifest.targetSite.latDeg}
        lonDeg={manifest.targetSite.lonDeg}
        altM={manifest.targetSite.altM}
        label={manifest.targetSite.label}
        color={COLORS.cyan}
        kind="target"
      />
      <CameraRig />
    </>
  );
}

export function SceneCanvas() {
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
        <ScenarioScene />
      </Suspense>
    </Canvas>
  );
}
