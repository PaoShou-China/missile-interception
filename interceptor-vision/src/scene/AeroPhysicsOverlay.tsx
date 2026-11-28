import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { dataClock } from "../data/dataClock";
import { sampleAt } from "../data/telemetry";
import { useApp } from "../state";

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

  // Approximate Planck blackbody tint for nose shock plasma (900K .. 2600K)
  vec3 blackbody(float tempK) {
    float t = clamp((tempK - 700.0) / 1900.0, 0.0, 1.0);
    vec3 c1 = vec3(0.35, 0.72, 1.0);   // supersonic compression blue-white
    vec3 c2 = vec3(1.0, 0.42, 0.14);   // hot plasma orange
    vec3 c3 = vec3(1.0, 0.92, 0.72);   // incandescent white-yellow
    return t < 0.5 ? mix(c1, c2, t * 2.0) : mix(c2, c3, (t - 0.5) * 2.0);
  }

  void main() {
    // vUv.y = 1.0 at nose tip, 0.0 at aft base of cone
    float tip = smoothstep(0.0, 1.0, vUv.y);
    float fresnel = pow(1.0 - abs(dot(normalize(vNormalView), normalize(vViewDir))), 1.75);
    float streak = 0.75 + 0.25 * sin(vUv.x * 50.0 + vUv.y * 18.0 - uTime * 22.0);
    float machVis = smoothstep(1.15, 4.5, uMach);
    float lip = pow(tip, 2.4) * 1.45;
    float alpha = (fresnel * 0.52 + lip * 0.42) * smoothstep(0.0, 0.22, vUv.y) * machVis * streak;
    alpha = clamp(alpha * (0.45 + 0.55 * clamp(uHeat / 5.0, 0.0, 1.4)), 0.0, 0.85);
    vec3 col = mix(vec3(0.45, 0.84, 1.0), blackbody(uWallTemp), pow(tip, 1.4) * smoothstep(900.0, 2100.0, uWallTemp));
    gl_FragColor = vec4(col, alpha);
  }
`;

const THERMAL_VERT = /* glsl */ `
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
    vec3 col = planckGlow(uWallTemp * (0.65 + 0.35 * tip));
    gl_FragColor = vec4(col, alpha);
  }
`;

/** Simple 3D arrow (shaft + cone) pointing along +Y in its own local frame. */
function ForceArrow({
  arrowRef,
  color,
  label,
}: {
  arrowRef: React.RefObject<THREE.Group | null>;
  color: string;
  label: string;
}) {
  return (
    <group ref={arrowRef} visible={false}>
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.024, 0.024, 1.0, 10]} />
        <meshBasicMaterial color={color} transparent opacity={0.92} depthTest={false} />
      </mesh>
      <mesh position={[0, 1.08, 0]}>
        <coneGeometry args={[0.068, 0.22, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.96} depthTest={false} />
      </mesh>
      <Html position={[0, 1.26, 0]} center zIndexRange={[18, 0]} style={{ pointerEvents: "none" }}>
        <span className="xray-tag" style={{ borderColor: color, color }}>{label}</span>
      </Html>
    </group>
  );
}

/**
 * Mounted inside the interceptor's body group (GLB convention: +X nose, +Y up, +Z right).
 * Renders:
 *  1) GLSL Mach-angle Bow Shock Cone + Planck Blackbody Aerothermal Nose Glow
 *  2) Toggleable X-Ray Force Vectors (Lift, Drag, Thrust, NMP Tail-Fin Direct Force)
 *     and dynamic CG / CP station spheres + static margin bar.
 */
export function AeroPhysicsOverlay() {
  const xrayOpen = useApp((s) => s.xrayOpen);
  const lang = useApp((s) => s.lang);

  const shockRef = useRef<THREE.Mesh>(null);
  const thermalRef = useRef<THREE.Mesh>(null);
  const xrayGroupRef = useRef<THREE.Group>(null);
  const liftRef = useRef<THREE.Group>(null);
  const dragRef = useRef<THREE.Group>(null);
  const thrustRef = useRef<THREE.Group>(null);
  const nmpFinRef = useRef<THREE.Group>(null);
  const cgRef = useRef<THREE.Group>(null);
  const cpRef = useRef<THREE.Group>(null);
  const marginBarRef = useRef<THREE.Mesh>(null);
  const hudTagRef = useRef<HTMLDivElement>(null);

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
        vertexShader: THERMAL_VERT,
        fragmentShader: THERMAL_FRAG,
        uniforms: {
          uWallTemp: { value: 288 },
          uHeat: { value: 0 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  useFrame(({ clock }) => {
    const st = useApp.getState();
    const s = st.dataStatus === "ready" ? sampleAt(dataClock.t) : null;
    if (!s) return;

    const mach = s.mach ?? 0;
    const heat = s.heatFluxMWm2 ?? 0;
    const tw = s.wallTempK ?? 288;
    const alphaRad = ((s.alphaDeg ?? 0) * Math.PI) / 180;
    const betaRad = ((s.betaDeg ?? 0) * Math.PI) / 180;

    // 1) GLSL Bow Shock Cone: cone half-angle follows physical Mach angle mu = asin(1/M)
    if (shockRef.current) {
      const showShock = mach > 1.15 && (st.cameraMode !== "macro" || st.xrayOpen);
      shockRef.current.visible = showShock;
      if (showShock) {
        const mu = Math.asin(Math.min(0.95, 1 / Math.max(mach, 1.06)));
        const shockLen = 5.6;
        const baseRad = Math.max(0.46, Math.min(3.4, Math.tan(mu) * shockLen + 0.16));
        shockRef.current.scale.set(baseRad, shockLen, baseRad);
        // Align cone axis along -X (tip at nose +3.45) and tilt subtly with AoA/sideslip
        shockRef.current.rotation.set(0, -betaRad * 0.45, -Math.PI / 2 - alphaRad * 0.45);
        shockRef.current.position.set(3.48 - shockLen * 0.5, 0, 0);
        shockMat.uniforms.uTime.value = clock.elapsedTime;
        shockMat.uniforms.uMach.value = mach;
        shockMat.uniforms.uHeat.value = heat;
        shockMat.uniforms.uWallTemp.value = tw;
      }
    }

    // 2) GLSL Blackbody Aerothermal Nose Glow
    if (thermalRef.current) {
      const showThermal = tw > 680;
      thermalRef.current.visible = showThermal;
      if (showThermal) {
        thermalMat.uniforms.uWallTemp.value = tw;
        thermalMat.uniforms.uHeat.value = heat;
      }
    }

    // 3) X-Ray Force Vectors + Dynamic CG / CP Markers
    if (!xrayGroupRef.current) return;
    xrayGroupRef.current.visible = st.xrayOpen;
    if (!st.xrayOpen) return;

    // Station mapping from missile_intercept [0..8.11 m from nose] -> GLB X [+3.35 .. -3.34]
    const toGlbX = (stationFromNose: number) => 3.35 - (stationFromNose / 8.11) * 6.69;
    const cgStation = s.cgPos ?? (4.10 + Math.max(0, (s.massKg - 1000) / 1565) * 0.35);
    const cpStation = s.cpPos ?? (cgStation + Math.max(0.35, 0.72 - Math.max(0, mach - 5) * 0.032));
    const cgX = toGlbX(cgStation);
    const cpX = toGlbX(cpStation);

    if (cgRef.current) cgRef.current.position.set(cgX, 0, 0);
    if (cpRef.current) cpRef.current.position.set(cpX, 0, 0);
    if (marginBarRef.current) {
      const midX = 0.5 * (cgX + cpX);
      const len = Math.max(0.05, Math.abs(cgX - cpX));
      marginBarRef.current.position.set(midX, 0, 0);
      marginBarRef.current.scale.set(1, len, 1);
    }

    // Body-axis forces (derived from telemetry load/q/fin deflections or recorded F_body)
    const fx = s.bodyForceX ?? (s.phase === "boost" ? 130000 : s.unstartFlag ? 6000 : 28000) - s.qPa * 0.3117 * 0.24;
    const fz = s.bodyForceZ ?? -(s.loadG * s.massKg * 9.80665); // NED +Z down => GLB +Y lift = -fz
    const liftN = -fz;
    const dragN = Math.max(100, s.qPa * 0.3117 * 0.24);
    const thrustN = Math.max(0, fx + dragN);
    const finPitch = 0.5 * ((s.finDeflectionsRad?.left ?? 0) + (s.finDeflectionsRad?.right ?? 0));
    // Tail-fin direct lift (NMP force): positive pitch-up fin pushes tail DOWN (-Y) while nose pitches UP (+Y)
    const finDirectN = s.qPa * 0.3117 * 1.4 * finPitch;

    const normLen = (n: number, scale: number) => Math.max(0.35, Math.min(2.6, Math.log10(1 + Math.abs(n) / scale) * 1.35));

    if (liftRef.current) {
      const len = normLen(liftN, 4000);
      liftRef.current.visible = Math.abs(liftN) > 250;
      liftRef.current.position.set(cpX, 0, 0);
      liftRef.current.rotation.set(0, 0, liftN >= 0 ? 0 : Math.PI);
      liftRef.current.scale.set(1, len, 1);
    }
    if (dragRef.current) {
      const len = normLen(dragN, 5000);
      dragRef.current.visible = dragN > 200;
      dragRef.current.position.set(cpX, 0, 0);
      dragRef.current.rotation.set(0, 0, Math.PI / 2); // +Y -> -X aft
      dragRef.current.scale.set(1, len, 1);
    }
    if (thrustRef.current) {
      const len = normLen(thrustN, 5000);
      thrustRef.current.visible = thrustN > 500;
      thrustRef.current.position.set(-2.3, 0, 0);
      thrustRef.current.rotation.set(0, 0, -Math.PI / 2); // +Y -> +X forward
      thrustRef.current.scale.set(1, len, 1);
    }
    if (nmpFinRef.current) {
      const len = normLen(finDirectN, 1200);
      nmpFinRef.current.visible = Math.abs(finDirectN) > 120;
      nmpFinRef.current.position.set(-2.05, 0, 0);
      // Direct tail lift opposes initial climb direction (classic tail-controlled NMP zero)
      nmpFinRef.current.rotation.set(0, 0, finDirectN >= 0 ? Math.PI : 0);
      nmpFinRef.current.scale.set(1, len, 1);
    }

    if (hudTagRef.current) {
      const sm = cpStation - cgStation;
      const unstartTxt = (s.unstartFlag ?? 0) > 0.5 ? " · ⚠ UNSTART" : "";
      hudTagRef.current.textContent =
        `CG ${cgStation.toFixed(2)}m | CP ${cpStation.toFixed(2)}m | SM +${sm.toFixed(2)}m | Tw ${tw.toFixed(0)}K | q̇s ${heat.toFixed(2)}MW/m²${unstartTxt}`;
    }
  });

  return (
    <group name="aero-physics-overlay">
      {/* 1. GLSL Mach-angle Bow Shock Cone */}
      <mesh ref={shockRef} material={shockMat} visible={false} renderOrder={4}>
        <coneGeometry args={[1, 1, 48, 1, true]} />
      </mesh>

      {/* 2. GLSL Blackbody Aerothermal Nose-Cap Heating Sheath */}
      <mesh
        ref={thermalRef}
        material={thermalMat}
        position={[2.72, 0, 0]}
        rotation={[0, 0, -Math.PI / 2]}
        visible={false}
        renderOrder={5}
      >
        <coneGeometry args={[0.255, 1.48, 36, 1, true]} />
      </mesh>

      {/* 3. X-Ray Force Vectors & Dynamic CG / CP Markers */}
      <group ref={xrayGroupRef} visible={xrayOpen}>
        <ForceArrow arrowRef={liftRef} color="#4df0a8" label={lang === "zh" ? "升力 L" : "Lift L"} />
        <ForceArrow arrowRef={dragRef} color="#ff6d59" label={lang === "zh" ? "阻力 D" : "Drag D"} />
        <ForceArrow arrowRef={thrustRef} color="#ffcb5c" label={lang === "zh" ? "推力 T" : "Thrust T"} />
        <ForceArrow arrowRef={nmpFinRef} color="#ff66d9" label={lang === "zh" ? "尾舵反向力 (NMP)" : "Fin NMP Force"} />

        {/* Dynamic CG marker (Gold) */}
        <group ref={cgRef}>
          <mesh renderOrder={10}>
            <sphereGeometry args={[0.14, 18, 16]} />
            <meshBasicMaterial color="#ffcc4d" depthTest={false} />
          </mesh>
          <Html position={[0, -0.34, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <span className="xray-tag xray-tag--cg">CG</span>
          </Html>
        </group>

        {/* Dynamic CP marker (Cyan) */}
        <group ref={cpRef}>
          <mesh renderOrder={10}>
            <sphereGeometry args={[0.13, 18, 16]} />
            <meshBasicMaterial color="#4fd8ff" depthTest={false} />
          </mesh>
          <Html position={[0, 0.34, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <span className="xray-tag xray-tag--cp">CP</span>
          </Html>
        </group>

        {/* Static margin connecting bar */}
        <mesh ref={marginBarRef} rotation={[0, 0, Math.PI / 2]} renderOrder={9}>
          <cylinderGeometry args={[0.025, 0.025, 1, 8]} />
          <meshBasicMaterial color="#a8f0ff" transparent opacity={0.85} depthTest={false} />
        </mesh>

        {/* Floating live physics readout strip */}
        <Html position={[0.4, 1.55, 0]} center zIndexRange={[22, 0]} style={{ pointerEvents: "none" }}>
          <div ref={hudTagRef} className="xray-hud-strip" />
        </Html>
      </group>
    </group>
  );
}
