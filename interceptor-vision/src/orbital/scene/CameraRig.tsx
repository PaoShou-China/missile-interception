import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { simClock, useAppStore, type CameraMode } from "../state/store";
import { BODY_CAMERAS } from "../state/cameraModes";
import { KM } from "./constants";
import { geodeticToEcef } from "../scientific/geodesy";
import { shotAtWall, simToWall } from "../cinematic/shots";
import { cameraInput } from "./cameraInput";

const REGION = geodeticToEcef(34, 118, 0);

function regionAnchor(): THREE.Vector3 {
  return new THREE.Vector3(REGION.x, REGION.y, REGION.z).multiplyScalar(KM);
}

/** Smooth exponential damping factor that is stable at any frame rate. */
function damp(rate: number, dt: number) {
  return 1 - Math.exp(-rate * Math.min(dt, 0.1));
}

export function CameraRig() {
  const cameraMode = useAppStore((s) => s.cameraMode);
  const presentation = useAppStore((s) => s.presentation);
  const { camera, gl } = useThree();
  const look = useRef(regionAnchor());
  const lastMode = useRef<CameraMode | null>(null);
  const lastPresentation = useRef(presentation);
  const camOffset = useRef(new THREE.Vector3());
  const lookOffset = useRef(new THREE.Vector3());

  const anchor = useMemo(regionAnchor, []);
  const regionDir = useMemo(() => anchor.clone().normalize(), [anchor]);

  // Set a sensible starting view once the globe is mounted.
  useEffect(() => {
    if (lastMode.current === null) {
      const start = regionDir.clone().multiplyScalar(15200);
      start.applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
      camera.position.copy(start);
      camera.lookAt(anchor);
      look.current.copy(anchor);
      lastMode.current = cameraMode;
    }
  }, [camera, regionDir, anchor, cameraMode]);

  // Pointer drag and wheel manipulate every mode except free, where
  // OrbitControls owns the camera.
  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const freeMode = () => false;

    const onDown = (e: PointerEvent) => {
      if (freeMode()) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging || freeMode()) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      cameraInput.yaw -= dx * 0.006;
      cameraInput.pitch = THREE.MathUtils.clamp(cameraInput.pitch - dy * 0.005, -1.25, 1.25);
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      el.releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      if (freeMode()) return;
      e.preventDefault();
      cameraInput.zoom = THREE.MathUtils.clamp(
        cameraInput.zoom * Math.exp(e.deltaY * 0.0012),
        0.18,
        8,
      );
    };
    const onDouble = () => {
      cameraInput.yaw = 0;
      cameraInput.pitch = 0;
      cameraInput.zoom = 1;
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

  useFrame((_, dt) => {
    const rt = useAppStore.getState().runtime;
    if (!rt) return;

    let mode: CameraMode = cameraMode;
    if (presentation === "cinematic") {
      mode = shotAtWall(simToWall(simClock.time, rt.manifest.phases)).mode;
    }

    const t = simClock.time;
    const cam = camera as THREE.PerspectiveCamera;
    const wall = presentation === "cinematic"
      ? simToWall(t, rt.manifest.phases)
      : 0;
    // A slow, shot-independent drift keeps the film from looking static.
    const driftYaw = presentation === "cinematic" ? Math.sin(wall * 0.22) * 0.55 : 0;
    const driftPitch = presentation === "cinematic" ? Math.sin(wall * 0.13 + 1) * 0.1 : 0;
    const driftZoom = presentation === "cinematic" ? 1 + 0.07 * Math.sin(wall * 0.09) : 1;
    const userYaw = cameraInput.yaw + driftYaw;
    const userPitch = cameraInput.pitch + driftPitch;
    const userZoom = THREE.MathUtils.clamp(cameraInput.zoom * driftZoom, 0.12, 10);
    const ms = rt.missileSampler.sampleAt(t);
    const ts = rt.targetSampler.sampleAt(t);
    const mpos = new THREE.Vector3(ms.position.x, ms.position.y, ms.position.z).multiplyScalar(KM);
    const tpos = new THREE.Vector3(ts.position.x, ts.position.y, ts.position.z).multiplyScalar(KM);
    const mvel = new THREE.Vector3(ms.velocity.x, ms.velocity.y, ms.velocity.z).normalize();
    const up = new THREE.Vector3(mpos.x, mpos.y, mpos.z).normalize();

    // Body-locked close-ups: offsets are expressed in the vehicle body frame
    // (x forward, y right, z down) and rotated by the recorded attitude.
    if (BODY_CAMERAS.includes(mode)) {
      const q = new THREE.Quaternion(ms.attitude.x, ms.attitude.y, ms.attitude.z, ms.attitude.w);
      const bodyUp = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      // One near three-quarter rear view: the tail fins, nozzle/plume and the
      // body axes are all visible at once instead of three separate cameras.
      const off = new THREE.Vector3(-0.0090, 0.0040, -0.0060);
      const lookOff: THREE.Vector3 = new THREE.Vector3(-0.0012, 0, 0);
      const fov = 38;
      const userQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(userPitch * 0.8, userYaw * 0.8, 0, "YXZ"),
      );
      off.applyQuaternion(userQ);
      off.multiplyScalar(userZoom);
      const desiredPos = off.clone().applyQuaternion(q).add(mpos);
      const desiredLook = lookOff ? lookOff.clone().applyQuaternion(q).add(mpos) : tpos;
      camera.position.copy(desiredPos);
      camera.up.copy(bodyUp);
      camera.lookAt(desiredLook);
      cam.fov = fov;
      camera.updateProjectionMatrix();
      lastMode.current = mode;
      lastPresentation.current = presentation;
      return;
    }

    const desiredPos = new THREE.Vector3();
    const desiredLook = new THREE.Vector3();
    const elapsed = simClock.time - rt.manifest.time.startS;
    const shot = presentation === "cinematic"
      ? shotAtWall(simToWall(simClock.time, rt.manifest.phases))
      : null;
    // Anchor for smoothing: near-field modes follow a moving vehicle, so the
    // camera offset is smoothed in the anchor's frame. Otherwise a 20x playback
    // rate would leave the camera kilometres behind at 60 fps.
    const follow = mode === "chase" || mode === "target";
    let anchorPoint = mpos;
    let lookAnchor = mpos;

    if (mode === "chase") {
      const dist = shot ? 0.035 + shot.distance * 0.5 : 0.075;
      // At launch the recorded velocity is exactly zero; fall back to the body
      // x-axis so the chase camera does not sit inside the vehicle.
      let forward = mvel.clone();
      if (forward.lengthSq() < 1e-8) {
        const q = new THREE.Quaternion(ms.attitude.x, ms.attitude.y, ms.attitude.z, ms.attitude.w);
        forward = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      }
      forward.normalize();
      const side = new THREE.Vector3().crossVectors(forward, up).normalize();
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      desiredPos.copy(mpos)
        .addScaledVector(forward, -dist)
        .addScaledVector(up, dist * 0.22)
        .addScaledVector(side, dist * 0.1);
      desiredLook.copy(mpos).addScaledVector(forward, dist * 0.35);
      cam.fov = 42;
    } else if (mode === "target") {
      const sep = mpos.distanceTo(tpos);
      const dist = Math.max(0.008, sep * 0.55);
      const mid = mpos.clone().lerp(tpos, 0.5);
      const side = new THREE.Vector3().subVectors(tpos, mpos).normalize()
        .cross(up).normalize();
      desiredPos.copy(mid)
        .addScaledVector(up, Math.min(dist * 0.35, 0.4))
        .addScaledVector(side, dist * 0.25);
      desiredLook.copy(mid);
      anchorPoint = mid;
      lookAnchor = mid;
      cam.fov = 38;
    } else {
      const dist = 7800;
      const theta = 0.85 + elapsed * 0.00035;
      const elevation = 0.62;
      desiredPos.copy(regionDir.clone().multiplyScalar(Math.cos(elevation)))
        .add(new THREE.Vector3(0, 0, Math.sin(elevation)))
        .normalize()
        .multiplyScalar(dist)
        .applyAxisAngle(new THREE.Vector3(0, 0, 1), -theta);
      desiredLook.copy(anchor);
      cam.fov = 43;
    }

    // Apply user orbit/zoom around the automatic look point.
    {
      const off = desiredPos.clone().sub(desiredLook);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta += userYaw;
      sph.phi = THREE.MathUtils.clamp(sph.phi + userPitch, 0.06, Math.PI - 0.06);
      sph.radius = Math.max(0.0004, sph.radius * userZoom);
      desiredPos.copy(desiredLook).add(new THREE.Vector3().setFromSpherical(sph));
    }

    const modeChanged = lastMode.current !== mode;
    // Cinematic mode opens on a cut, like a film. Without this the first shot
    // has to fly in from the orbital view, which is slow on low-end GPUs.
    const justEnteredCinematic =
      presentation === "cinematic" && lastPresentation.current !== "cinematic";

    if (follow) {
      if (justEnteredCinematic) {
        camOffset.current.copy(desiredPos).sub(anchorPoint);
        lookOffset.current.copy(desiredLook).sub(lookAnchor);
      } else if (modeChanged) {
        camOffset.current.copy(camera.position).sub(anchorPoint);
        lookOffset.current.copy(look.current).sub(lookAnchor);
      }
      const rate = modeChanged ? 3.2 : 4.5;
      camOffset.current.lerp(desiredPos.clone().sub(anchorPoint), damp(rate, dt));
      lookOffset.current.lerp(desiredLook.clone().sub(lookAnchor), damp(rate + 1.5, dt));
      camera.position.copy(anchorPoint).add(camOffset.current);
      look.current.copy(lookAnchor).add(lookOffset.current);
    } else if (justEnteredCinematic) {
      camera.position.copy(desiredPos);
      look.current.copy(desiredLook);
    } else {
      camera.position.lerp(desiredPos, damp(2.2, dt));
      look.current.lerp(desiredLook, damp(3.0, dt));
    }

    camera.up.copy(up);
    camera.lookAt(look.current);
    camera.updateProjectionMatrix();
    lastMode.current = mode;
    lastPresentation.current = presentation;
  });

  return null;
}

