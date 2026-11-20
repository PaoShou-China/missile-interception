import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { simClock, useAppStore, type CameraMode } from "../state/store";
import { KM } from "./constants";
import { geodeticToEcef } from "../scientific/geodesy";
import { shotAt } from "../cinematic/shots";

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
  const { camera } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const look = useRef(regionAnchor());
  const lastMode = useRef<CameraMode | null>(null);
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

  useFrame((_, dt) => {
    const rt = useAppStore.getState().runtime;
    if (!rt) return;

    let mode: CameraMode = cameraMode;
    if (presentation === "cinematic") {
      mode = shotAt(simClock.time).mode;
    }

    if (mode === "free") {
      if (!controls.current) return;
      if (lastMode.current !== "free") {
        controls.current.target.copy(look.current);
        controls.current.update();
      }
      lastMode.current = mode;
      return;
    }

    const t = simClock.time;
    const cam = camera as THREE.PerspectiveCamera;
    const ms = rt.missileSampler.sampleAt(t);
    const ts = rt.targetSampler.sampleAt(t);
    const mpos = new THREE.Vector3(ms.position.x, ms.position.y, ms.position.z).multiplyScalar(KM);
    const tpos = new THREE.Vector3(ts.position.x, ts.position.y, ts.position.z).multiplyScalar(KM);
    const mvel = new THREE.Vector3(ms.velocity.x, ms.velocity.y, ms.velocity.z).normalize();
    const up = new THREE.Vector3(mpos.x, mpos.y, mpos.z).normalize();

    const desiredPos = new THREE.Vector3();
    const desiredLook = new THREE.Vector3();
    const elapsed = simClock.time - rt.manifest.time.startS;
    const shot = presentation === "cinematic" ? shotAt(t) : null;
    // Anchor for smoothing: near-field modes follow a moving vehicle, so the
    // camera offset is smoothed in the anchor's frame. Otherwise a 20x playback
    // rate would leave the camera kilometres behind at 60 fps.
    const follow = mode === "chase" || mode === "target";
    let anchorPoint = mpos;
    let lookAnchor = mpos;

    if (mode === "chase") {
      const dist = shot ? 0.035 + shot.distance * 0.5 : 0.075;
      const side = new THREE.Vector3().crossVectors(mvel, up).normalize();
      desiredPos.copy(mpos)
        .addScaledVector(mvel, -dist)
        .addScaledVector(up, dist * 0.22)
        .addScaledVector(side, dist * 0.1);
      desiredLook.copy(mpos).addScaledVector(mvel, dist * 0.35);
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
    } else if (mode === "top") {
      const dist = 8400;
      const theta = 0.55 + elapsed * 0.0006;
      desiredPos.copy(regionDir.clone().multiplyScalar(Math.cos(0.32))).multiplyScalar(dist);
      desiredPos.applyAxisAngle(new THREE.Vector3(0, 0, 1), -theta);
      desiredLook.copy(anchor);
      cam.fov = 42;
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

    const modeChanged = lastMode.current !== mode;
    if (follow) {
      if (modeChanged) {
        camOffset.current.copy(camera.position).sub(anchorPoint);
        lookOffset.current.copy(look.current).sub(lookAnchor);
      }
      const rate = modeChanged ? 3.2 : 4.5;
      camOffset.current.lerp(desiredPos.clone().sub(anchorPoint), damp(rate, dt));
      lookOffset.current.lerp(desiredLook.clone().sub(lookAnchor), damp(rate + 1.5, dt));
      camera.position.copy(anchorPoint).add(camOffset.current);
      look.current.copy(lookAnchor).add(lookOffset.current);
    } else {
      camera.position.lerp(desiredPos, damp(2.2, dt));
      look.current.lerp(desiredLook, damp(3.0, dt));
    }

    camera.up.copy(up);
    camera.lookAt(look.current);
    camera.updateProjectionMatrix();
    lastMode.current = mode;
  });

  return (
    <OrbitControls
      ref={controls}
      enabled={cameraMode === "free" && presentation === "scientific"}
      enablePan
      enableZoom
      enableRotate
      dampingFactor={0.08}
      minDistance={0.01}
      maxDistance={60000}
      zoomSpeed={0.9}
      rotateSpeed={0.6}
      makeDefault={false}
    />
  );
}

