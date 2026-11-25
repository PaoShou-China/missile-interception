import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useApp } from "../state";
import { dataClock, getTelemetry, sampleAt, type Sample } from "../data/telemetry";

/**
 * The validated payload carries a target entity (lat/lon/alt and the same
 * attitude channels). Without it the "interception" is just a lone airframe, so
 * the target and the line of sight are drawn in the local ENU frame used by the
 * trajectory overlay.
 */
const EARTH_R = 6_371_000;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

function sampleTarget(samples: Sample[], t: number): Sample | null {
  if (samples.length === 0) return null;
  if (t <= samples[0].t) return samples[0];
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1];
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const k = (t - a.t) / (b.t - a.t || 1);
  const lerp = (x: number, y: number) => x + (y - x) * k;
  return { ...a, latDeg: lerp(a.latDeg, b.latDeg), lonDeg: lerp(a.lonDeg, b.lonDeg), altM: lerp(a.altM, b.altM) };
}

function markerTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(size / 2, 14);
  ctx.lineTo(size / 2, 44);
  ctx.moveTo(size / 2, 84);
  ctx.lineTo(size / 2, 114);
  ctx.moveTo(14, size / 2);
  ctx.lineTo(44, size / 2);
  ctx.moveTo(84, size / 2);
  ctx.lineTo(114, size / 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function TargetTrack() {
  const telemetry = useApp((s) => s.telemetry);
  const dataStatus = useApp((s) => s.dataStatus);

  const objects = useMemo(() => {
    const tex = markerTexture();
    const spriteMat = new THREE.SpriteMaterial({ map: tex, color: 0x9ff3ff, transparent: true, depthWrite: false });
    const spriteObj = new THREE.Sprite(spriteMat);
    spriteObj.frustumCulled = false;
    spriteObj.renderOrder = 3;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const losMat = new THREE.LineDashedMaterial({
      color: 0x8ff3ff,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      dashSize: 1,
      gapSize: 0.6,
    });
    const losObj = new THREE.Line(geo, losMat);
    losObj.frustumCulled = false;
    losObj.renderOrder = 2;
    return { tex, spriteObj, losObj, geo, losMat };
  }, []);

  useEffect(
    () => () => {
      objects.tex.dispose();
      objects.geo.dispose();
      (objects.spriteObj.material as THREE.SpriteMaterial).dispose();
      objects.losMat.dispose();
    },
    [objects],
  );

  useFrame(() => {
    const tel = getTelemetry();
    if (!tel || dataStatus !== "ready") return;
    const target = sampleTarget(tel.targetSamples, dataClock.t);
    const cur = sampleAt(dataClock.t);
    if (!target || !cur) return;

    const cos = Math.cos((cur.latDeg * Math.PI) / 180);
    const x = (target.lonDeg - cur.lonDeg) * M_PER_DEG_LON * cos;
    const z = -(target.latDeg - cur.latDeg) * M_PER_DEG_LAT;
    const drop = (x * x + z * z) / (2 * EARTH_R);
    const y = target.altM - cur.altM - drop;

    objects.spriteObj.position.set(x, y, z);
    // Constant apparent size: the target is 1-1600 km away during the run.
    const dist = Math.max(1, Math.hypot(x, y, z));
    const scale = dist * 0.026;
    objects.spriteObj.scale.set(scale, scale, 1);
    (objects.spriteObj.material as THREE.SpriteMaterial).color.set(cur.seekerLock ? 0xffc46a : 0x9ff3ff);

    const pos = objects.geo.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, 0, 0, 0);
    pos.setXYZ(1, x, y, z);
    pos.needsUpdate = true;
    objects.geo.computeBoundingSphere();
    objects.losObj.computeLineDistances();
    objects.losMat.dashSize = Math.max(400, dist * 0.006);
    objects.losMat.gapSize = Math.max(260, dist * 0.004);
    objects.losObj.visible = useApp.getState().showTrajectory;
  });

  if (!telemetry || telemetry.targetSamples.length === 0) return null;

  return (
    <group>
      <primitive object={objects.spriteObj} />
      <primitive object={objects.losObj} />
    </group>
  );
}
