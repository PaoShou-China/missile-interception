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
const CLOSE_OFFSET = new THREE.Vector3(-0.0090, 0.0040, -0.0060);
const CLOSE_LOOK = new THREE.Vector3(-0.0012, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const BODY_FORWARD = new THREE.Vector3(1, 0, 0);

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
  // Close-up smoothing state; the recorded attitude can change measurably
  // between frames at 60x playback, which reads as shake if applied raw.
  const smoothPos = useRef(new THREE.Vector3());
  const smoothLook = useRef(new THREE.Vector3());
  const smoothUp = useRef(new THREE.Vector3(0, 1, 0));
  const lastFov = useRef(43);

  const anchor = useMemo(regionAnchor, []);
  const regionDir = useMemo(() => anchor.clone().normalize(), [anchor]);

  const tmp = useMemo(
    () => ({
      off: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      look: new THREE.Vector3(),
      mpos: new THREE.Vector3(),
      tpos: new THREE.Vector3(),
      mvel: new THREE.Vector3(),
      up: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      side: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      anchor: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      userQ: new THREE.Quaternion(),
      euler: new THREE.Euler(),
      sph: new THREE.Spherical(),
    }),
    [],
  );

  // Set a sensible starting view once the globe is mounted.
  useEffect(() => {
    if (lastMode.current === null) {
      const start = regionDir.clone().multiplyScalar(15200);
      start.applyAxisAngle(Z_AXIS, 0.5);
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

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
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
    const mpos = tmp.mpos.set(ms.position.x, ms.position.y, ms.position.z).multiplyScalar(KM);
    const tpos = tmp.tpos.set(ts.position.x, ts.position.y, ts.position.z).multiplyScalar(KM);
    const mvel = tmp.mvel.set(ms.velocity.x, ms.velocity.y, ms.velocity.z).normalize();
    const up = tmp.up.set(mpos.x, mpos.y, mpos.z).normalize();

    const modeChanged = lastMode.current !== mode;

    // Body-locked close-ups: offsets are expressed in the vehicle body frame
    // (x forward, y right, z down) and rotated by the recorded attitude.
    if (BODY_CAMERAS.includes(mode)) {
      const q = tmp.q.set(ms.attitude.x, ms.attitude.y, ms.attitude.z, ms.attitude.w);
      const bodyUp = tmp.side.set(0, 0, -1).applyQuaternion(q);
      tmp.euler.set(userPitch * 0.8, userYaw * 0.8, 0, "YXZ");
      tmp.userQ.setFromEuler(tmp.euler);
      const off = tmp.off.copy(CLOSE_OFFSET).applyQuaternion(tmp.userQ).multiplyScalar(userZoom);
      const desiredPos = tmp.pos.copy(off).applyQuaternion(q).add(mpos);
      const desiredLook = tmp.look.copy(CLOSE_LOOK).applyQuaternion(q).add(mpos);

      if (modeChanged) {
        smoothPos.current.copy(desiredPos);
        smoothLook.current.copy(desiredLook);
        smoothUp.current.copy(bodyUp);
      } else {
        // 60x playback moves the recorded attitude quickly; damping the camera
        // pose keeps the airframe framed without per-frame jitter.
        const kPos = damp(16, dt);
        const kUp = damp(10, dt);
        smoothPos.current.lerp(desiredPos, kPos);
        smoothLook.current.lerp(desiredLook, kPos);
        smoothUp.current.lerp(bodyUp, kUp).normalize();
      }
      camera.position.copy(smoothPos.current);
      camera.up.copy(smoothUp.current);
      camera.lookAt(smoothLook.current);
      if (Math.abs(cam.fov - 38) > 1e-3) {
        cam.fov = 38;
        camera.updateProjectionMatrix();
      }
      lastMode.current = mode;
      lastPresentation.current = presentation;
      return;
    }

    const desiredPos = tmp.pos;
    const desiredLook = tmp.look;
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
      const forward = tmp.fwd.copy(mvel);
      if (forward.lengthSq() < 1e-8) {
        const q = tmp.q.set(ms.attitude.x, ms.attitude.y, ms.attitude.z, ms.attitude.w);
        forward.copy(BODY_FORWARD).applyQuaternion(q);
      }
      forward.normalize();
      const side = tmp.side.crossVectors(forward, up).normalize();
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
      const mid = tmp.anchor.copy(mpos).lerp(tpos, 0.5);
      const side = tmp.side.subVectors(tpos, mpos).normalize().cross(up).normalize();
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
      desiredPos.copy(regionDir).multiplyScalar(Math.cos(elevation))
        .add(tmp.fwd.set(0, 0, Math.sin(elevation)))
        .normalize()
        .multiplyScalar(dist)
        .applyAxisAngle(Z_AXIS, -theta);
      desiredLook.copy(anchor);
      cam.fov = 43;
    }

    // Apply user orbit/zoom around the automatic look point.
    {
      const off = tmp.off.copy(desiredPos).sub(desiredLook);
      const sph = tmp.sph.setFromVector3(off);
      sph.theta += userYaw;
      sph.phi = THREE.MathUtils.clamp(sph.phi + userPitch, 0.06, Math.PI - 0.06);
      sph.radius = Math.max(0.0004, sph.radius * userZoom);
      desiredPos.copy(desiredLook).add(tmp.fwd.setFromSpherical(sph));
    }

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
      camOffset.current.lerp(tmp.mid.copy(desiredPos).sub(anchorPoint), damp(rate, dt));
      lookOffset.current.lerp(tmp.side.copy(desiredLook).sub(lookAnchor), damp(rate + 1.5, dt));
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
    if (Math.abs(cam.fov - lastFov.current) > 1e-3) {
      lastFov.current = cam.fov;
      camera.updateProjectionMatrix();
    }
    lastMode.current = mode;
    lastPresentation.current = presentation;
  });

  return null;
}
