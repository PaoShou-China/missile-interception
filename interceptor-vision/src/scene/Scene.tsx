import { useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, SMAA, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { Missile } from "./Missile";
import { RealtimeEnvironment } from "./Environment";
import { CameraRig } from "./CameraRig";
import { TelemetryClock } from "./TelemetryClock";
import { useApp } from "../state";
import { SKY_PRESETS } from "./assets";

function RendererBridge() {
  const { gl, scene, camera } = useThree();
  const exposure = useApp((s) => s.exposure);
  const timeOfDay = useApp((s) => s.timeOfDay);
  const setExposure = useApp((s) => s.setExposure);
  const screenshot = useApp((s) => s.screenshotRequest);
  const setReady = useApp((s) => s.setReady);
  const setFps = useApp((s) => s.setFps);
  const lastShot = useRef(0);
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
    lastShot.current = screenshot;
    // The drawing buffer is preserved, so a synchronous read is safe.
    const url = gl.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `interceptor-vision-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    a.click();
  }, [screenshot, gl]);

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
  if (quality === "performance") return null;
  return (
    <EffectComposer multisampling={0}>
      <SMAA />
      <Vignette offset={0.28} darkness={0.55} />
      {quality === "cinematic" && (
        <Bloom intensity={0.22} luminanceThreshold={0.92} luminanceSmoothing={0.22} mipmapBlur radius={0.6} />
      )}
    </EffectComposer>
  );
}

export function SceneCanvas() {
  const quality = useApp((s) => s.quality);
  const dpr: [number, number] =
    quality === "performance" ? [1, 1] : quality === "balanced" ? [1, 1.5] : [1, 2];

  return (
    <Canvas
      shadows={quality !== "performance"}
      dpr={dpr}
      camera={{ fov: 34, near: 0.05, far: 3_000_000, position: [7.4, 2.3, 6.6] }}
      gl={{
        antialias: quality !== "performance",
        powerPreference: "high-performance",
        logarithmicDepthBuffer: true,
        alpha: false,
        preserveDrawingBuffer: true,
      }}
      className="scene-canvas"
    >
      <RendererBridge />
      <TelemetryClock />
      <RealtimeEnvironment />
      <Missile />
      <CameraRig />
      <QualityEffects />
    </Canvas>
  );
}
