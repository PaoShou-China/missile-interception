import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { simClock, useAppStore } from "../state/store";

const SHOCK_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const SHOCK_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uMach;
  uniform float uHeat;
  uniform float uWallTemp;
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;

  vec3 blackbody(float tempK) {
    float t = clamp((tempK - 700.0) / 1900.0, 0.0, 1.0);
    vec3 c1 = vec3(0.35, 0.72, 1.0);
    vec3 c2 = vec3(1.0, 0.42, 0.14);
    vec3 c3 = vec3(1.0, 0.94, 0.76);
    return t < 0.5 ? mix(c1, c2, t * 2.0) : mix(c2, c3, (t - 0.5) * 2.0);
  }

  void main() {
    float tip = smoothstep(0.0, 1.0, vUv.y);
    float fresnel = pow(1.0 - abs(dot(normalize(vNormalView), normalize(vViewDir))), 1.7);
    float streak = 0.76 + 0.24 * sin(vUv.x * 48.0 + vUv.y * 16.0 - uTime * 20.0);
    float machVis = smoothstep(1.15, 4.5, uMach);
    float alpha = (fresnel * 0.5 + pow(tip, 2.3) * 0.52) * smoothstep(0.0, 0.2, vUv.y) * machVis * streak;
    alpha = clamp(alpha * (0.45 + 0.55 * clamp(uHeat / 5.0, 0.0, 1.4)), 0.0, 0.82);
    vec3 col = mix(vec3(0.45, 0.84, 1.0), blackbody(uWallTemp), pow(tip, 1.4) * smoothstep(900.0, 2100.0, uWallTemp));
    gl_FragColor = vec4(col, alpha);
  }
`;

const THERMAL_FRAG = /* glsl */ `
  uniform float uWallTemp;
  uniform float uHeat;
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;

  vec3 planckGlow(float tempK) {
    float t = clamp((tempK - 650.0) / 1850.0, 0.0, 1.0);
    vec3 darkRed = vec3(0.75, 0.08, 0.02);
    vec3 orange = vec3(1.0, 0.44, 0.06);
    vec3 whiteHot = vec3(1.0, 0.96, 0.82);
    return t < 0.55 ? mix(darkRed, orange, t / 0.55) : mix(orange, whiteHot, (t - 0.55) / 0.45);
  }

  void main() {
    float tip = pow(clamp(vUv.y, 0.0, 1.0), 1.8);
    float tempIntensity = smoothstep(700.0, 2350.0, uWallTemp);
    float rim = 0.55 + 0.45 * pow(1.0 - abs(dot(normalize(vNormalView), normalize(vViewDir))), 1.2);
    float alpha = tip * tempIntensity * rim * clamp(0.4 + uHeat * 0.14, 0.0, 0.95);
    gl_FragColor = vec4(planckGlow(uWallTemp * (0.65 + 0.35 * tip)), alpha);
  }
`;

function KmForceArrow({
  arrowRef,
  color,
}: {
  arrowRef: React.RefObject<THREE.Group | null>;
  color: string;
}) {
  return (
    <group ref={arrowRef} visible={false}>
      <mesh position={[0, 0.0005, 0]}>
        <cylinderGeometry args={[0.000022, 0.000022, 0.001, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.92} depthTest={false} />
      </mesh>
      <mesh position={[0, 0.00108, 0]}>
        <coneGeometry args={[0.000062, 0.00022, 10]} />
        <meshBasicMaterial color={color} transparent opacity={0.96} depthTest={false} />
      </mesh>
    </group>
  );
}

/**
 * Mounted inside `MissileBody` in aerospace-vision-web (km scale: +X nose, +Y right, +Z down).
 * Renders GLSL Mach Bow Shock + Blackbody Nose Heating + X-Ray Forces & Dynamic CG/CP markers.
 */
export function AeroPhysicsField() {
  const xrayMode = useAppStore((s) => s.xrayMode);
  const shockRef = useRef<THREE.Mesh>(null);
  const thermalRef = useRef<THREE.Mesh>(null);
  const xrayRef = useRef<THREE.Group>(null);
  const liftRef = useRef<THREE.Group>(null);
  const dragRef = useRef<THREE.Group>(null);
  const thrustRef = useRef<THREE.Group>(null);
  const nmpRef = useRef<THREE.Group>(null);
  const cgRef = useRef<THREE.Mesh>(null);
  const cpRef = useRef<THREE.Mesh>(null);

  const shockMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SHOCK_VERT,
        fragmentShader: SHOCK_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uMach: { value: 1 },
          uHeat: { value: 0 },
          uWallTemp: { value: 288 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  const thermalMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SHOCK_VERT,
        fragmentShader: THERMAL_FRAG,
        uniforms: { uWallTemp: { value: 288 }, uHeat: { value: 0 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  useFrame(({ clock }) => {
    const st = useAppStore.getState();
    const rt = st.runtime;
    if (!rt) return;
    const s = rt.missileSampler.sampleAt(simClock.time);
    const closeView = st.cameraMode === "closeup" || st.cameraMode === "chase" || st.xrayMode;
    const mach = s.mach;
    const heat = s.heatFluxMWm2 ?? 0;
    const tw = s.wallTempK ?? 288;

    if (shockRef.current) {
      const show = closeView && mach > 1.15;
      shockRef.current.visible = show;
      if (show) {
        const mu = Math.asin(Math.min(0.95, 1 / Math.max(mach, 1.06)));
        const len = 0.0064;
        const rad = Math.max(0.00052, Math.min(0.0036, Math.tan(mu) * len + 0.00018));
        shockRef.current.scale.set(rad, len, rad);
        shockRef.current.position.set(0.00412 - len * 0.5, 0, 0);
        shockMat.uniforms.uTime.value = clock.elapsedTime;
        shockMat.uniforms.uMach.value = mach;
        shockMat.uniforms.uHeat.value = heat;
        shockMat.uniforms.uWallTemp.value = tw;
      }
    }

    if (thermalRef.current) {
      const showT = closeView && tw > 680;
      thermalRef.current.visible = showT;
      if (showT) {
        thermalMat.uniforms.uWallTemp.value = tw;
        thermalMat.uniforms.uHeat.value = heat;
      }
    }

    if (!xrayRef.current) return;
    xrayRef.current.visible = st.xrayMode;
    if (!st.xrayMode) return;

    // Map station from nose [0..8.11 m] -> true 8.11 m body X [+0.00405 .. -0.00406 km]
    const toX = (stn: number) => 0.00405 - stn * 0.001;
    const cgStn = s.cgPos ?? (4.1 + Math.max(0, (s.massKg - 1000) / 1565) * 0.35);
    const cpStn = s.cpPos ?? (cgStn + Math.max(0.35, 0.72 - Math.max(0, mach - 5) * 0.032));
    const cgX = toX(cgStn);
    const cpX = toX(cpStn);

    if (cgRef.current) cgRef.current.position.set(cgX, 0, 0);
    if (cpRef.current) cpRef.current.position.set(cpX, 0, 0);

    const dragN = Math.max(100, s.qPa * 0.3117 * 0.24);
    const liftN = -(s.bodyForceZ ?? -(s.loadG * s.massKg * 9.80665));
    const thrustN = Math.max(0, (s.bodyForceX ?? (s.phase === "boost" ? 120000 : 24000)) + dragN);
    const finP = 0.5 * ((s.finDeflectionsRad?.left ?? 0) + (s.finDeflectionsRad?.right ?? 0));
    const finNmpN = s.qPa * 0.3117 * 1.4 * finP;
    const scl = (v: number, ref: number) => Math.max(0.4, Math.min(2.4, Math.log10(1 + Math.abs(v) / ref) * 1.25));
    const sep = (s.stageSep ?? (simClock.time >= 13 ? 1 : 0)) > 0.5;

    // In web body frame (+X forward, +Y right, +Z down): lift (-Z) is rotation X = -PI/2 from +Y!
    if (liftRef.current) {
      liftRef.current.visible = Math.abs(liftN) > 250;
      liftRef.current.position.set(cpX, 0, 0);
      liftRef.current.rotation.set(liftN >= 0 ? -Math.PI / 2 : Math.PI / 2, 0, 0);
      liftRef.current.scale.set(1, scl(liftN, 4000), 1);
    }
    if (dragRef.current) {
      dragRef.current.visible = dragN > 200;
      dragRef.current.position.set(cpX, 0, 0);
      dragRef.current.rotation.set(0, 0, Math.PI / 2);
      dragRef.current.scale.set(1, scl(dragN, 5000), 1);
    }
    if (thrustRef.current) {
      thrustRef.current.visible = thrustN > 500;
      thrustRef.current.position.set(sep ? -0.0032 : -0.00408, 0, 0);
      thrustRef.current.rotation.set(0, 0, -Math.PI / 2);
      thrustRef.current.scale.set(1, scl(thrustN, 5000), 1);
    }
    if (nmpRef.current) {
      nmpRef.current.visible = Math.abs(finNmpN) > 120;
      nmpRef.current.position.set(-0.00242, 0, 0);
      nmpRef.current.rotation.set(finNmpN >= 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0);
      nmpRef.current.scale.set(1, scl(finNmpN, 1200), 1);
    }
  });

  return (
    <group name="aero-physics-field">
      <mesh ref={shockRef} material={shockMat} rotation={[0, 0, -Math.PI / 2]} visible={false}>
        <coneGeometry args={[1, 1, 40, 1, true]} />
      </mesh>
      <mesh ref={thermalRef} material={thermalMat} position={[0.00308, 0, 0]} rotation={[0, 0, -Math.PI / 2]} visible={false}>
        <coneGeometry args={[0.000285, 0.00196, 36, 1, true]} />
      </mesh>
      <group ref={xrayRef} visible={xrayMode}>
        <KmForceArrow arrowRef={liftRef} color="#4df0a8" />
        <KmForceArrow arrowRef={dragRef} color="#ff6d59" />
        <KmForceArrow arrowRef={thrustRef} color="#ffcb5c" />
        <KmForceArrow arrowRef={nmpRef} color="#ff66d9" />
        <mesh ref={cgRef}>
          <sphereGeometry args={[0.00014, 14, 12]} />
          <meshBasicMaterial color="#ffcc4d" depthTest={false} />
        </mesh>
        <mesh ref={cpRef}>
          <sphereGeometry args={[0.00013, 14, 12]} />
          <meshBasicMaterial color="#4fd8ff" depthTest={false} />
        </mesh>
      </group>
    </group>
  );
}
