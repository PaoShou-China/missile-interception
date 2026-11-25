import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useApp } from "../state";
import { dataClock, getTelemetry, sampleAt } from "../data/telemetry";

/** Vertical exaggeration keeps the 30 km altitude profile readable in a local scene. */
const ALT_SCALE = 4;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

function makeLine(points: number[], color: number, opacity: number) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  return line;
}

function makeMarker(color: number, radius: number) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
  );
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Full recorded flight path, anchored to the current vehicle position: launch,
 * apogee and intercept stay in place on the map while the missile advances.
 */
export function TrajectoryOverlay() {
  const status = useApp((s) => s.dataStatus);
  const show = useApp((s) => s.showTrajectory);
  const group = useRef<THREE.Group>(null);

  const data = useMemo(() => {
    if (status !== "ready") return null;
    const tel = getTelemetry();
    if (!tel || tel.samples.length < 2) return null;
    const s0 = tel.samples[0];
    const lat0 = s0.latDeg * (Math.PI / 180);
    const cos = Math.cos(lat0);
    const project = (s: (typeof tel.samples)[number]) => ({
      x: (s.lonDeg - s0.lonDeg) * M_PER_DEG_LON * cos,
      y: (s.altM - s0.altM) * ALT_SCALE,
      z: -(s.latDeg - s0.latDeg) * M_PER_DEG_LAT,
    });

    const step = Math.max(1, Math.ceil(tel.samples.length / 420));
    const air: number[] = [];
    const ground: number[] = [];
    let apogee = tel.samples[0];
    for (let i = 0; i < tel.samples.length; i += step) {
      const s = tel.samples[i];
      const p = project(s);
      air.push(p.x, p.y, p.z);
      ground.push(p.x, 0, p.z);
      if (s.altM > apogee.altM) apogee = s;
    }
    const last = tel.samples[tel.samples.length - 1];
    const lp = project(last);
    air.push(lp.x, lp.y, lp.z);
    ground.push(lp.x, 0, lp.z);

    const airLine = makeLine(air, 0x7fe6ff, 0.32);
    const groundLine = makeLine(ground, 0x9ff2ff, 0.55);

    const markers = new THREE.Group();
    const start = project(s0);
    const top = project(apogee);
    const end = project(last);
    const launch = makeMarker(0x7fe0a8, 1400);
    launch.position.set(start.x, start.y, start.z);
    const apex = makeMarker(0x63c8ff, 1400);
    apex.position.set(top.x, top.y, top.z);
    const impact = makeMarker(0xff7a59, 1600);
    impact.position.set(end.x, end.y, end.z);
    markers.add(launch, apex, impact);

    return { airLine, groundLine, markers, project, step, count: air.length / 3, tStart: s0.t, tEnd: last.t };
  }, [status]);

  useFrame(() => {
    if (!data || !group.current) return;
    const s = sampleAt(dataClock.t);
    if (!s) return;
    const p = data.project(s);
    group.current.position.set(-p.x, -p.y, -p.z);
    // Only the segment around the vehicle is drawn in the air; the full path
    // stays visible as the ground track, which reads better in a local scene.
    const span = data.tEnd - data.tStart || 1;
    const idx = Math.round(((s.t - data.tStart) / span) * (data.count - 1));
    const half = 45;
    const start = Math.max(0, idx - half);
    const count = Math.min(data.count - start, half * 2);
    data.airLine.geometry.setDrawRange(start, count);
  });

  if (!data) return null;

  return (
    <group ref={group} visible={show}>
      <primitive object={data.airLine} />
      <primitive object={data.groundLine} />
      <primitive object={data.markers} />
    </group>
  );
}
