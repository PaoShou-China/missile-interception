import { useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { Missile } from "./Missile";
import { RealtimeEnvironment } from "./Environment";
import { CameraRig } from "./CameraRig";
import { TrajectoryOverlay } from "./TrajectoryOverlay";
import { TargetTrack } from "./TargetTrack";
import { TelemetryClock } from "./TelemetryClock";
import { useApp } from "../state";
import { SKY_PRESETS } from "./assets";
import { AdaptiveResolution, DPR_CAP } from "./AdaptiveResolution";

/** Shadow maps only need to track a slowly rotating vehicle, so refresh at ~10 Hz. */
function ShadowBudget() {
  const gl = useThree((s) => s.gl);
  const tick = useRef(0);
  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => {
      gl.shadowMap.autoUpdate = true;
    };
  }, [gl]);
  useFrame(() => {
    if (!gl.shadowMap.enabled) return;
    tick.current += 1;
    if (tick.current % 6 === 0) gl.shadowMap.needsUpdate = true;
  });
  return null;
}

function RendererBridge() {
  const { gl, scene, camera } = useThree();
  const exposure = useApp((s) => s.exposure);
  const timeOfDay = useApp((s) => s.timeOfDay);
  const setExposure = useApp((s) => s.setExposure);
  const screenshot = useApp((s) => s.screenshotRequest);
  const setReady = useApp((s) => s.setReady);
  const setFps = useApp((s) => s.setFps);
  const acc = useRef({ t: 0, frames: 0 });

  useEffect(() => {
    setExposure(SKY_PRESETS[timeOfDay].exposure);
  }, [timeOfDay, setExposure]);

  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = exposure;
    gl.outputColorSpace = THREE.SRGBColorSpace;
  }, [gl, scene, exposure]);

  useEffect(() => {
    if (screenshot === 0) return;
    // The drawing buffer is not preserved; render and read back in the same
    // task so no compositing can clear it in between.
    gl.render(scene, camera);
    const url = gl.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `interceptor-vision-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    a.click();
  }, [screenshot, gl, scene, camera]);

  useFrame((_, delta) => {
    acc.current.t += delta;
    acc.current.frames += 1;
    if (acc.current.t >= 0.5) {
      setFps(Math.round(acc.current.frames / acc.current.t));
      acc.current.t = 0;
      acc.current.frames = 0;
    }
    if (!useApp.getState().ready) setReady(true);
  });

  useEffect(() => {
    (window as unknown as { __iv?: unknown }).__iv = {
      gl,
      scene,
      camera,
      store: useApp,
      three: THREE,
    };
    return () => {
      delete (window as unknown as { __iv?: unknown }).__iv;
    };
  }, [gl, scene, camera]);

  return null;
}

function QualityEffects() {
  const quality = useApp((s) => s.quality);
  // Balanced relies on the canvas MSAA; a full-screen composer pass costs more
  // than it buys on integrated GPUs.
  if (quality !== "cinematic") return null;
  return (
    <EffectComposer multisampling={0}>
      <Vignette offset={0.28} darkness={0.6} />
      <Bloom intensity={0.42} luminanceThreshold={0.82} luminanceSmoothing={0.24} mipmapBlur radius={0.72} />
    </EffectComposer>
  );
}

export function SceneCanvas({ active = true }: { active?: boolean }) {
  const quality = useApp((s) => s.quality);
  const cap = DPR_CAP[quality] ?? 1.25;

  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      shadows={quality !== "performance"}
      dpr={cap}
      camera={{ fov: 34, near: 0.12, far: 3_000_000, position: [7.4, 2.3, 6.6] }}
      gl={{
        antialias: quality !== "performance",
        powerPreference: "high-performance",
        logarithmicDepthBuffer: true,
        alpha: false,
      }}
      className="scene-canvas"
    >
      <RendererBridge />
      <AdaptiveResolution max={cap} />
      <ShadowBudget />
      <TelemetryClock />
      <RealtimeEnvironment />
      <Missile />
      <TargetTrack />
      <TrajectoryOverlay />
      <CameraRig />
      <QualityEffects />
    </Canvas>
  );
}
