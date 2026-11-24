import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { CAMERA_POSES, CINEMATIC_PATH, CINEMATIC_SECONDS } from "./assets";
import { useApp } from "../state";

function damp(rate: number, dt: number) {
  return 1 - Math.exp(-rate * Math.min(dt, 0.1));
}

function curveFrom(path: typeof CINEMATIC_PATH) {
  return {
    position: new THREE.CatmullRomCurve3(
      path.map((p) => new THREE.Vector3(...p.position)),
      true,
      "centripetal",
      0.4,
    ),
    target: new THREE.CatmullRomCurve3(
      path.map((p) => new THREE.Vector3(...p.target)),
      true,
      "centripetal",
      0.4,
    ),
    fov: path.map((p) => p.fov),
  };
}

export function CameraRig() {
  const mode = useApp((s) => s.cameraMode);
  const playing = useApp((s) => s.playing);
  const resetRequest = useApp((s) => s.resetViewRequest);
  const { camera } = useThree();
  const posTarget = useRef(new THREE.Vector3(...CAMERA_POSES.meso.position));
  const lookTarget = useRef(new THREE.Vector3(...CAMERA_POSES.meso.target));
  const fovTarget = useRef(CAMERA_POSES.meso.fov);
  const controls = useRef<unknown>(null);
  const cinematic = useMemo(() => curveFrom(CINEMATIC_PATH), []);
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpLook = useMemo(() => new THREE.Vector3(), []);

  // Snap to a sensible pose on first mount.
  useEffect(() => {
    camera.position.copy(posTarget.current);
    camera.lookAt(lookTarget.current);
    (camera as THREE.PerspectiveCamera).fov = fovTarget.current;
    camera.updateProjectionMatrix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mode === "cinematic" || mode === "free") return;
    const pose = CAMERA_POSES[mode];
    posTarget.current.set(...pose.position);
    lookTarget.current.set(...pose.target);
    fovTarget.current = pose.fov;
  }, [mode, resetRequest]);

  useEffect(() => {
    if (mode === "cinematic") {
      useApp.getState().setPlaying(true);
    }
  }, [mode]);

  useFrame((_, delta) => {
    const state = useApp.getState();
    const cam = camera as THREE.PerspectiveCamera;

    if (mode === "free") return;

    if (mode === "cinematic") {
      if (playing) {
        let next = state.time + delta;
        if (next >= CINEMATIC_SECONDS) next -= CINEMATIC_SECONDS;
        state.setTime(next);
      }
      const u = (state.time % CINEMATIC_SECONDS) / CINEMATIC_SECONDS;
      cinematic.position.getPoint(u, tmpPos);
      cinematic.target.getPoint(u, tmpLook);
      const fi = u * (cinematic.fov.length - 1);
      const i0 = Math.floor(fi);
      const i1 = Math.min(cinematic.fov.length - 1, i0 + 1);
      const fov = cinematic.fov[i0] + (cinematic.fov[i1] - cinematic.fov[i0]) * (fi - i0);
      camera.position.lerp(tmpPos, damp(6, delta));
      lookTarget.current.lerp(tmpLook, damp(6, delta));
      cam.fov += (fov - cam.fov) * damp(5, delta);
      cam.updateProjectionMatrix();
      camera.lookAt(lookTarget.current);
      return;
    }

    camera.position.lerp(posTarget.current, damp(2.6, delta));
    camera.lookAt(lookTarget.current);
    cam.fov += (fovTarget.current - cam.fov) * damp(2.8, delta);
    cam.updateProjectionMatrix();
  });

  return mode === "free" ? (
    <OrbitControls
      ref={controls as never}
      enabled
      enableDamping
      dampingFactor={0.08}
      target={[0, 0, 0]}
      minDistance={2}
      maxDistance={8000}
      makeDefault
    />
  ) : null;
}
