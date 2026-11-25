import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { useApp } from "../state";
import { dataClock, getTelemetry, sampleAt } from "../data/telemetry";

const EARTH_R = 6_371_000;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;
const DOT_COUNT = 36;

function makeDotTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(160,240,255,0.85)");
  g.addColorStop(1, "rgba(80,200,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowLine(count: number, color: number, width: number, opacity: number) {
  const geo = new LineGeometry();
  geo.setPositions(new Float32Array(count * 3));
  const mat = new LineMaterial({
    color,
    linewidth: width,
    worldUnits: false,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const line = new Line2(geo, mat);
  line.frustumCulled = false;
  return line;
}

/**
 * Full recorded flight path as a screen-width glow line. Positions are rebuilt
 * every frame in the vehicle's local frame, so the arc stays glued to the
 * curved ground and to the current position at any playback rate.
 */
export function TrajectoryOverlay() {
  const status = useApp((s) => s.dataStatus);
  const show = useApp((s) => s.showTrajectory);
  const size = useThree((s) => s.size);

  const data = useMemo(() => {
    if (status !== "ready") return null;
    const tel = getTelemetry();
    if (!tel || tel.samples.length < 2) return null;
    const step = Math.max(1, Math.ceil(tel.samples.length / 320));
    const picks: { lat: number; lon: number; alt: number }[] = [];
    let apogeeIdx = 0;
    let maxAlt = -Infinity;
    for (let i = 0; i < tel.samples.length; i += step) {
      const s = tel.samples[i];
      picks.push({ lat: s.latDeg, lon: s.lonDeg, alt: s.altM });
      if (s.altM > maxAlt) {
        maxAlt = s.altM;
        apogeeIdx = picks.length - 1;
      }
    }
    const lastS = tel.samples[tel.samples.length - 1];
    picks.push({ lat: lastS.latDeg, lon: lastS.lonDeg, alt: lastS.altM });
    if (lastS.altM > maxAlt) apogeeIdx = picks.length - 1;

    const n = picks.length;
    const airLine = makeGlowLine(n, 0x8ff3ff, 3.4, 0.95);
    const groundLine = makeGlowLine(n, 0x45b9d6, 2.2, 0.65);
    // The arc spans up to 2000 km and is rebuilt every frame, so culling it is
    // pointless work (and its bounds are meaningless while the clock is at 0).
    airLine.frustumCulled = false;
    groundLine.frustumCulled = false;
    // Hundreds of kilometres away the 600 m lift is below the terrain's depth
    // precision, which reads as a shredded dashed line. Draw it as a projection
    // overlay instead of letting it fight the ground.
    (groundLine.material as LineMaterial).depthTest = false;
    groundLine.renderOrder = 2;

    const markerGeo = new THREE.BufferGeometry();
    markerGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    markerGeo.setAttribute(
      "color",
      new THREE.BufferAttribute(
        new Float32Array([0.5, 0.88, 0.66, 0.39, 0.78, 1, 1, 0.48, 0.35]),
        3,
      ),
    );
    const dotTex = makeDotTexture();
    const markers = new THREE.Points(
      markerGeo,
      new THREE.PointsMaterial({
        size: 15,
        sizeAttenuation: false,
        vertexColors: true,
        map: dotTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    markers.frustumCulled = false;

    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DOT_COUNT * 3), 3));
    // Additive blending lets us switch a distant pulse off by writing black:
    // otherwise the whole 600 km arc collapses onto a few pixels in close-ups
    // and the 36 pulses turn into a bright scribble.
    dotGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(DOT_COUNT * 3).fill(1), 3));
    const dots = new THREE.Points(
      dotGeo,
      new THREE.PointsMaterial({
        size: 12,
        sizeAttenuation: false,
        color: 0xe8fdff,
        vertexColors: true,
        map: dotTex,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    dots.frustumCulled = false;

    return { airLine, groundLine, markers, dots, picks, apogeeIdx, n };
  }, [status]);

  useEffect(() => {
    if (!data) return;
    const line = data.airLine.material as LineMaterial;
    const groundMat = data.groundLine.material as LineMaterial;
    line.resolution.set(size.width, size.height);
    groundMat.resolution.set(size.width, size.height);
  }, [data, size]);

  useEffect(() => {
    if (!data) return;
    return () => {
      data.airLine.geometry.dispose();
      data.groundLine.geometry.dispose();
      (data.airLine.material as THREE.Material).dispose();
      (data.groundLine.material as THREE.Material).dispose();
      data.markers.geometry.dispose();
      (data.markers.material as THREE.Material).dispose();
      data.dots.geometry.dispose();
      (data.dots.material as THREE.Material).dispose();
    };
  }, [data]);

  const scratch = useMemo(() => new Float32Array(320 * 3), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }) => {
    if (!data) return;
    // From 6 m away the whole recorded path is a few degrees wide near the
    // vanishing point, so the close-ups show only the airframe.
    const mode = useApp.getState().cameraMode;
    const closeUp = mode === "micro" || mode === "chase";
    data.airLine.visible = !closeUp;
    data.groundLine.visible = !closeUp;
    data.markers.visible = !closeUp;
    data.dots.visible = !closeUp;
    const cur = sampleAt(dataClock.t);
    if (!cur) return;
    const cos = Math.cos(cur.latDeg * (Math.PI / 180));
    const n = data.n;
    const air = data.airLine.geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
    const airEnd = data.airLine.geometry.getAttribute("instanceEnd") as THREE.InterleavedBufferAttribute;
    const ground = data.groundLine.geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
    const groundEnd = data.groundLine.geometry.getAttribute("instanceEnd") as THREE.InterleavedBufferAttribute;
    const airArr = (air.data as THREE.InstancedInterleavedBuffer).array as Float32Array;
    const groundArr = (ground.data as THREE.InstancedInterleavedBuffer).array as Float32Array;

    for (let i = 0; i < n; i++) {
      const p = data.picks[i];
      const x = (p.lon - cur.lonDeg) * M_PER_DEG_LON * cos;
      const z = -(p.lat - cur.latDeg) * M_PER_DEG_LAT;
      const drop = (x * x + z * z) / (2 * EARTH_R);
      const y = p.alt - cur.altM - drop;
      scratch[i * 3] = x;
      scratch[i * 3 + 1] = y;
      scratch[i * 3 + 2] = z;
    }

    for (let i = 0; i < n - 1; i++) {
      // Line2 interleaves start/end per segment in one buffer.
      airArr[i * 6] = scratch[i * 3];
      airArr[i * 6 + 1] = scratch[i * 3 + 1];
      airArr[i * 6 + 2] = scratch[i * 3 + 2];
      airArr[i * 6 + 3] = scratch[(i + 1) * 3];
      airArr[i * 6 + 4] = scratch[(i + 1) * 3 + 1];
      airArr[i * 6 + 5] = scratch[(i + 1) * 3 + 2];
      groundArr[i * 6] = scratch[i * 3];
      // The ground track lives on the terrain, i.e. cur.altM below the airframe,
      // plus the spherical drop. A 20 m lift is enough now that the material
      // draws without depth testing.
      groundArr[i * 6 + 1] = -cur.altM - (scratch[i * 3] ** 2 + scratch[i * 3 + 2] ** 2) / (2 * EARTH_R) + 20;
      groundArr[i * 6 + 2] = scratch[i * 3 + 2];
      groundArr[i * 6 + 3] = scratch[(i + 1) * 3];
      groundArr[i * 6 + 4] =
        -cur.altM - (scratch[(i + 1) * 3] ** 2 + scratch[(i + 1) * 3 + 2] ** 2) / (2 * EARTH_R) + 20;
      groundArr[i * 6 + 5] = scratch[(i + 1) * 3 + 2];
    }
    air.data.needsUpdate = true;
    ground.data.needsUpdate = true;

    // Event markers.
    const mp = data.markers.geometry.getAttribute("position") as THREE.BufferAttribute;
    const setMarker = (slot: number, idx: number) => {
      mp.setXYZ(slot, scratch[idx * 3], scratch[idx * 3 + 1], scratch[idx * 3 + 2]);
    };
    setMarker(0, 0);
    setMarker(1, data.apogeeIdx);
    setMarker(2, n - 1);
    mp.needsUpdate = true;

    // Flowing pulses, evenly spaced along the sampled path. The macro preset
    // shows the whole arc, but in close-ups the far half compresses to a few
    // pixels, so those pulses fade out instead of piling into a white scribble.
    const dp = data.dots.geometry.getAttribute("position") as THREE.BufferAttribute;
    const dc = data.dots.geometry.getAttribute("color") as THREE.BufferAttribute;
    const maxDotDist =
      mode === "macro" || mode === "cinematic" ? Number.POSITIVE_INFINITY : mode === "meso" ? 260_000 : 55_000;
    const t = clock.elapsedTime * 0.12;
    for (let i = 0; i < DOT_COUNT; i++) {
      const u = (t + i / DOT_COUNT) % 1;
      const fi = u * (n - 1);
      const i0 = Math.floor(fi);
      const i1 = Math.min(n - 1, i0 + 1);
      const f = fi - i0;
      // Sample the point buffer, not the interleaved segment buffer: reading
      // the last point out of the segment stride produced a NaN vertex (and a
      // computeBoundingSphere warning) once per loop.
      tmp.set(
        scratch[i0 * 3] + (scratch[i1 * 3] - scratch[i0 * 3]) * f,
        scratch[i0 * 3 + 1] + (scratch[i1 * 3 + 1] - scratch[i0 * 3 + 1]) * f,
        scratch[i0 * 3 + 2] + (scratch[i1 * 3 + 2] - scratch[i0 * 3 + 2]) * f,
      );
      dp.setXYZ(i, tmp.x, tmp.y, tmp.z);
      const dist = tmp.length();
      const k = THREE.MathUtils.clamp((maxDotDist - dist) / (maxDotDist * 0.25), 0, 1);
      dc.setXYZ(i, k, k, k);
    }
    dp.needsUpdate = true;
    dc.needsUpdate = true;

    // Keep the unused end attribute bound to the same buffer.
    void airEnd;
    void groundEnd;
  });

  if (!data) return null;

  return (
    <group visible={show}>
      <primitive object={data.airLine} />
      <primitive object={data.groundLine} />
      <primitive object={data.markers} />
      <primitive object={data.dots} />
    </group>
  );
}
