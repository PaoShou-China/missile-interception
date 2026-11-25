import { Suspense, useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { SpaceEnvironment } from "./scene/SpaceEnvironment";
import { CameraRig } from "./scene/CameraRig";
import { TrajectoryRibbon } from "./scene/Trajectory";
import { EntityVisual, SurfaceBeacon } from "./scene/Entities";
import { COLORS } from "./scene/constants";
import { simClock, useAppStore as useOrbitalStore, type QualityLevel } from "./state/store";
import { CINEMATIC_WALL_S, simToWall, wallToSim } from "./cinematic/shots";
import { buildRuntime } from "./runtime";
import { useApp } from "../state";
import { useT } from "../i18n";
import { dataClock } from "../data/dataClock";
import { AdaptiveResolution, DPR_CAP } from "../scene/AdaptiveResolution";

const QUALITY_MAP: Record<string, QualityLevel> = {
  performance: "low",
  balanced: "medium",
  cinematic: "high",
};

/** Bridges the shared flight clock with the orbital store. */
function ClockBridge() {
  const acc = useRef(0);
  useFrame((_, rawDt) => {
    const orb = useOrbitalStore.getState();
    const main = useApp.getState();
    if (!orb.runtime) return;
    // A canvas that has just mounted (or a backgrounded tab) reports a huge
    // first delta; clamping it keeps playback from jumping to the end.
    const dt = Math.min(0.1, rawDt);
    if (orb.presentation === "cinematic") {
      if (simClock.playing) {
        const phases = orb.runtime.manifest.phases;
        const nextWall = Math.min(CINEMATIC_WALL_S, simToWall(simClock.time, phases) + dt);
        const t = wallToSim(nextWall, phases);
        simClock.seek(t);
        main.setDataTime(t);
        if (nextWall >= CINEMATIC_WALL_S) simClock.pause();
      }
      acc.current += dt;
      if (acc.current >= 0.08) {
        acc.current = 0;
        orb.syncTime();
      }
      return;
    }
    if (main.dataPlaying) {
      // The wall clock is authoritative while playing. Seeking the simulation
      // clock from the 7 Hz UI mirror made it jump backwards between updates,
      // which read as camera shake in the close-ups.
      dataClock.t = Math.min(main.telemetry?.end ?? Infinity, dataClock.t + dt * main.dataRate);
      simClock.seek(dataClock.t);
      acc.current += dt;
      if (acc.current >= 0.14) {
        acc.current = 0;
        main.setDataTime(dataClock.t);
      }
    } else {
      if (Math.abs(simClock.time - main.dataTime) > 0.03) simClock.seek(main.dataTime);
    }
    if (main.dataPlaying && !simClock.playing) simClock.play();
    if (!main.dataPlaying && simClock.playing) simClock.pause();
    acc.current += dt;
    if (acc.current >= 0.14) {
      acc.current = 0;
      orb.syncTime();
    }
  });
  return null;
}

function RendererSetup() {
  const { gl, scene, camera } = useThree();
  const acc = useRef({ t: 0, frames: 0 });
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.06;
  gl.outputColorSpace = THREE.SRGBColorSpace;
  scene.fog = null;
  (window as unknown as { __orb?: unknown }).__orb = {
    scene,
    camera,
    store: useOrbitalStore,
    main: useApp,
    clock: simClock,
  };
  useFrame((_, delta) => {
    acc.current.t += delta;
    acc.current.frames += 1;
    if (acc.current.t >= 0.5) {
      useApp.getState().setFps(Math.round(acc.current.frames / acc.current.t));
      acc.current.t = 0;
      acc.current.frames = 0;
    }
  });
  return null;
}
function Effects() {
  const quality = useOrbitalStore((s) => s.quality);
  if (quality !== "high") return null;
  return (
    <EffectComposer multisampling={0}>
      <Bloom intensity={0.34} luminanceThreshold={0.78} luminanceSmoothing={0.3} mipmapBlur radius={0.7} />
    </EffectComposer>
  );
}

/** Small fill light at the camera keeps the vehicle legible on the night side. */
function CameraFillLight() {
  const light = useRef<THREE.PointLight>(null);
  useFrame(({ camera }) => {
    if (light.current) light.current.position.copy(camera.position);
  });
  return <pointLight ref={light} intensity={0.12} distance={0.3} decay={2} color="#cfe0ff" />;
}

export function OrbitalScene({ active = true }: { active?: boolean }) {
  const telemetry = useApp((s) => s.telemetry);
  const quality = useApp((s) => s.quality);
  const t = useT();
  const runtime = useOrbitalStore((s) => s.runtime);
  const presentation = useOrbitalStore((s) => s.presentation);

  useEffect(() => {
    useOrbitalStore.getState().setQuality(QUALITY_MAP[quality] ?? "medium");
  }, [quality]);

  useEffect(() => {
    // Leaving the live cinematic path behind so the transport stays available.
    if (useApp.getState().cameraMode === "cinematic") useApp.getState().setCameraMode("meso");
  }, []);

  useEffect(() => {
    if (!telemetry) return;
    useOrbitalStore.getState().setRuntime(buildRuntime(telemetry));
    simClock.seek(useApp.getState().dataTime);
  }, [telemetry]);

  const cap = DPR_CAP[quality] ?? 1.25;

  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      dpr={cap}
      camera={{ fov: 43, near: 0.0008, far: 300_000, position: [13_000, 8_000, 9_000] }}
      gl={{
        antialias: quality !== "performance",
        powerPreference: "high-performance",
        logarithmicDepthBuffer: true,
        alpha: false,
      }}
      className="scene-canvas"
    >
      <RendererSetup />
      <AdaptiveResolution max={cap} />
      <ClockBridge />
      <Suspense fallback={null}>
        {runtime && (
          <>
            <CameraFillLight />
            <SpaceEnvironment />
            <TrajectoryRibbon />
            <EntityVisual
              kind="missile"
              label={t("entityInterceptor")}
              color={COLORS.accent}
              showLabel={presentation === "scientific"}
            />
            <EntityVisual
              kind="target"
              label={t("entityTarget")}
              color={COLORS.cyan}
              showLabel={presentation === "scientific"}
            />
            <SurfaceBeacon
              latDeg={runtime.manifest.launchSite.latDeg}
              lonDeg={runtime.manifest.launchSite.lonDeg}
              altM={runtime.manifest.launchSite.altM}
              label={t("launchSite")}
              color={COLORS.accent}
              kind="launch"
            />
            <SurfaceBeacon
              latDeg={runtime.manifest.targetSite.latDeg}
              lonDeg={runtime.manifest.targetSite.lonDeg}
              altM={runtime.manifest.targetSite.altM}
              label={t("targetDatum")}
              color={COLORS.cyan}
              kind="target"
            />
            <CameraRig />
          </>
        )}
      </Suspense>
      <Effects />
    </Canvas>
  );
}
