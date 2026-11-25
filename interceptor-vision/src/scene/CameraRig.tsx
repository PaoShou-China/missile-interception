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
  const { camera, gl } = useThree();
  const posTarget = useRef(new THREE.Vector3(...CAMERA_POSES.meso.position));
  const lookTarget = useRef(new THREE.Vector3(...CAMERA_POSES.meso.target));
  const fovTarget = useRef(CAMERA_POSES.meso.fov);
  const controls = useRef<unknown>(null);
  const cinematic = useMemo(() => curveFrom(CINEMATIC_PATH), []);
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpLook = useMemo(() => new THREE.Vector3(), []);
  const orbit = useRef({ yaw: 0, pitch: 0, zoom: 1 });

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
    orbit.current.yaw = 0;
    orbit.current.pitch = 0;
    orbit.current.zoom = 1;
  }, [mode, resetRequest]);

  // Manual orbit / zoom on every preset camera. The free camera is handled by
  // OrbitControls, and the cinematic path stays author-controlled.
  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const interactive = () => {
      const m = useApp.getState().cameraMode;
      return m !== "cinematic" && m !== "free";
    };
    const onDown = (e: PointerEvent) => {
      if (!interactive()) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging || !interactive()) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      orbit.current.yaw -= dx * 0.005;
      orbit.current.pitch = THREE.MathUtils.clamp(orbit.current.pitch - dy * 0.004, -1.1, 1.1);
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      el.releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      if (!interactive()) return;
      e.preventDefault();
      orbit.current.zoom = THREE.MathUtils.clamp(orbit.current.zoom * Math.exp(e.deltaY * 0.0011), 0.3, 5);
    };
    const onDouble = () => {
      orbit.current.yaw = 0;
      orbit.current.pitch = 0;
      orbit.current.zoom = 1;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("dblclick", onDouble);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("dblclick", onDouble);
    };
  }, [gl]);

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

    const off = posTarget.current.clone().sub(lookTarget.current);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += orbit.current.yaw;
    sph.phi = THREE.MathUtils.clamp(sph.phi + orbit.current.pitch, 0.12, Math.PI - 0.12);
    sph.radius *= orbit.current.zoom;
    const desired = new THREE.Vector3().setFromSpherical(sph).add(lookTarget.current);
    camera.position.lerp(desired, damp(2.6, delta));
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
