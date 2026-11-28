import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { simClock, useAppStore } from "../state/store";
import { KM, COLORS, EARTH_A_KM, WGS84_E2_KM } from "./constants";
import { AeroPhysicsField } from "./AeroPhysicsField";

/** Radial glow sprite texture, generated once on a canvas. */
function useGlowTexture(inner: string, outer: string) {
  return useMemo(() => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, outer);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [inner, outer]);
}

/** Body-axis triad drawn in the vehicle body frame (x forward, y right, z down). */
function BodyAxes({ groupRef }: { groupRef: RefObject<THREE.Group | null> }) {
  const axes: { dir: [number, number, number]; rot: [number, number, number]; color: string }[] = [
    { dir: [1, 0, 0], rot: [0, 0, -Math.PI / 2], color: "#ff7a59" },
    { dir: [0, 1, 0], rot: [0, 0, 0], color: "#63e6ff" },
    { dir: [0, 0, 1], rot: [Math.PI / 2, 0, 0], color: "#7fe0a8" },
  ];
  const L = 0.0042;
  return (
    <group ref={groupRef} visible={false}>
      {axes.map((a) => (
        <group key={a.color}>
          <mesh position={[a.dir[0] * L * 0.5, a.dir[1] * L * 0.5, a.dir[2] * L * 0.5]} rotation={a.rot}>
            <cylinderGeometry args={[0.000007, 0.000007, L, 8]} />
            <meshBasicMaterial color={a.color} />
          </mesh>
          <mesh position={[a.dir[0] * L, a.dir[1] * L, a.dir[2] * L]} rotation={a.rot}>
            <coneGeometry args={[0.000022, 0.00010, 10]} />
            <meshBasicMaterial color={a.color} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

const WEB_PLUME_VERT = /* glsl */ `
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

const WEB_PLUME_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uRegime;   // 0 = solid booster, 1 = scramjet cruise
  uniform float uPower;
  uniform float uUnstart;
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;

  void main() {
    float axial = clamp(vUv.y, 0.0, 1.0);
    float dist = 1.0 - axial;
    float core = pow(clamp(abs(dot(normalize(vNormalView), normalize(vViewDir))), 0.0, 1.0), 0.72);
    float freq = mix(20.0, 34.0, uRegime);
    float speed = mix(26.0, 48.0, uRegime);
    float diamond = pow(0.5 + 0.5 * sin(dist * freq - uTime * speed), mix(3.2, 5.5, uRegime)) * smoothstep(0.05, 0.92, axial);

    vec3 cCore = mix(vec3(1.0, 0.95, 0.80), vec3(0.88, 0.96, 1.0), uRegime);
    vec3 cMid  = mix(vec3(1.0, 0.52, 0.14), vec3(0.36, 0.78, 1.0), uRegime);
    vec3 cTail = mix(vec3(0.86, 0.22, 0.06), vec3(0.72, 0.44, 0.98), uRegime);

    vec3 col = mix(cTail, cMid, smoothstep(0.0, 0.6, axial));
    col = mix(col, cCore, smoothstep(0.55, 0.98, axial) * 0.75 + diamond * 0.65);

    float sputter = 1.0 - uUnstart * (0.55 + 0.35 * sin(uTime * 68.0));
    col = mix(col, vec3(1.0, 0.46, 0.12), uUnstart * 0.75);
    float fade = pow(axial, mix(1.25, 1.55, uRegime)) * smoothstep(0.0, 0.14, axial);
    float flicker = 0.92 + 0.08 * sin(uTime * 53.0 + dist * 12.0);
    float alpha = clamp((fade * (0.48 + 0.52 * core) + diamond * 0.42 * axial) * uPower * sputter * flicker, 0.0, 0.96);
    gl_FragColor = vec4(col * (1.1 + diamond * 0.65), alpha);
  }
`;

const WEB_AB_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    float axial = clamp(vUv.y, 0.0, 1.0);
    float dist = 1.0 - axial;
    float core = pow(clamp(abs(dot(normalize(vNormalView), normalize(vViewDir))), 0.0, 1.0), 0.65);
    float shock = pow(0.5 + 0.5 * sin(dist * 24.0 - uTime * 36.0), 4.0) * axial;
    vec3 col = mix(vec3(0.95, 0.36, 0.08), vec3(1.0, 0.86, 0.56), smoothstep(0.15, 0.92, axial));
    col = mix(col, vec3(0.68, 0.86, 1.0), shock * 0.55);
    float alpha = clamp((pow(axial, 1.5) * (0.42 + 0.58 * core) + shock * 0.38) * uIntensity, 0.0, 0.92);
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Procedural high-fidelity 8.11 m × 0.63 m hypersonic scramjet lifting-body
 * interceptor (body +x forward, +y right, +z down; km units):
 * - Von Kármán Haack ogive + C-SiC ablative nose tip + sapphire seeker aperture
 * - Twin 2D scramjet compression-ramp intakes with live unstart shock-buzz glow
 * - Swept-delta lifting strakes (3.8 m root chord) & beveled cruciform tail fins (NO fake canards)
 * - Tandem Stage-1 solid booster that separates & tumbles away at t = 13 s
 * - Volumetric GLSL Mach-diamond exhaust plume (boost <-> scramjet <-> unstart)
 */
function MissileBody() {
  const plumeGroup = useRef<THREE.Group>(null);
  const plumeOuterRef = useRef<THREE.Mesh>(null);
  const plumeCoreRef = useRef<THREE.Mesh>(null);
  const nozzleGlow = useRef<THREE.Mesh>(null);
  const boosterRef = useRef<THREE.Group>(null);
  const boosterGlowRef = useRef<THREE.Mesh>(null);
  const buzzMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const finUp = useRef<THREE.Group>(null);
  const finDown = useRef<THREE.Group>(null);
  const finLeft = useRef<THREE.Group>(null);
  const finRight = useRef<THREE.Group>(null);
  const axes = useRef<THREE.Group>(null);

  const {
    bodyGeo,
    noseCapGeo,
    finGeo,
    strakeGeo,
    cowlGeo,
    rampGeo,
    spineGeo,
    boosterGeo,
    boosterFinGeo,
  } = useMemo(() => {
    // True 7.00 m sustainer (+0.00405 nose -> -0.00295 aft) + 1.11 m booster = 8.11 m!
    const profile: [number, number][] = [
      [0.000185, -0.00295],
      [0.000240, -0.00278],
      [0.000285, -0.00230],
      [0.000285, 0.00165],
      [0.000280, 0.00205],
      [0.000264, 0.00238],
      [0.000236, 0.00270],
      [0.000196, 0.00302],
      [0.000148, 0.00334],
      [0.000095, 0.00364],
      [0.000042, 0.00390],
      [0.000012, 0.00405],
    ];
    const body = new THREE.LatheGeometry(
      profile.map(([r, y]) => new THREE.Vector2(r, y)),
      64,
    );
    body.rotateZ(-Math.PI / 2);
    body.computeVertexNormals();

    // Dark C-SiC ablative thermal nose tip (+0.00360 -> +0.00406)
    const tipProf: [number, number][] = [
      [0.000108, 0.00358],
      [0.000046, 0.00390],
      [0.000013, 0.00406],
    ];
    const noseCap = new THREE.LatheGeometry(
      tipProf.map(([r, y]) => new THREE.Vector2(r, y)),
      40,
    );
    noseCap.rotateZ(-Math.PI / 2);
    noseCap.computeVertexNormals();

    // Beveled diamond-airfoil cruciform tail control fin (~0.56 m chord, 0.36 m span)
    const shape = new THREE.Shape();
    shape.moveTo(0.00010, 0);
    shape.lineTo(-0.00048, 0.00005);
    shape.lineTo(-0.00044, 0.00034);
    shape.lineTo(-0.00004, 0.00036);
    shape.closePath();
    const fin = new THREE.ExtrudeGeometry(shape, {
      depth: 0.000028,
      bevelEnabled: true,
      bevelThickness: 0.000008,
      bevelSize: 0.000008,
      bevelSegments: 2,
      curveSegments: 2,
    });
    fin.translate(0, 0, -0.000014);
    fin.computeVertexNormals();

    // Long swept-delta lifting strake matching config.py (ROOT_CHORD 3.8 m, TIP_CHORD 1.6 m)
    const strake = new THREE.Shape();
    strake.moveTo(0.00185, 0.000265);
    strake.lineTo(-0.00195, 0.000265);
    strake.lineTo(-0.00165, 0.000635);
    strake.lineTo(-0.00005, 0.000635);
    strake.closePath();
    const strakeG = new THREE.ExtrudeGeometry(strake, {
      depth: 0.000020,
      bevelEnabled: true,
      bevelThickness: 0.000006,
      bevelSize: 0.000006,
      bevelSegments: 2,
      curveSegments: 2,
    });
    strakeG.translate(0, 0, -0.000010);
    strakeG.computeVertexNormals();

    // Twin 2D scramjet compression-ramp intake nacelle cowl (XZ profile extruded in Y)
    const cowl = new THREE.Shape();
    cowl.moveTo(0.00120, 0.00004);
    cowl.lineTo(0.00070, 0.00021);
    cowl.lineTo(-0.00190, 0.00019);
    cowl.lineTo(-0.00225, 0.00002);
    cowl.lineTo(-0.00185, -0.00008);
    cowl.lineTo(0.00082, -0.00006);
    cowl.closePath();
    const cowlG = new THREE.ExtrudeGeometry(cowl, {
      depth: 0.00016,
      bevelEnabled: true,
      bevelThickness: 0.000018,
      bevelSize: 0.000018,
      bevelSegments: 2,
    });
    cowlG.rotateX(Math.PI / 2);
    cowlG.translate(0, 0.00008, 0);
    cowlG.computeVertexNormals();

    // Oblique-shock compression ramp extending forward of intake lip
    const ramp = new THREE.Shape();
    ramp.moveTo(0.00168, 0.0);
    ramp.lineTo(0.00112, 0.00014);
    ramp.lineTo(0.00112, -0.00002);
    ramp.closePath();
    const rampG = new THREE.ExtrudeGeometry(ramp, {
      depth: 0.00013,
      bevelEnabled: true,
      bevelThickness: 0.000008,
      bevelSize: 0.000008,
      bevelSegments: 1,
    });
    rampG.rotateX(Math.PI / 2);
    rampG.translate(0, 0.000065, 0);
    rampG.computeVertexNormals();

    // Dorsal avionics & telemetry cable spine along top (-Z)
    const spine = new THREE.Shape();
    spine.moveTo(0.00205, 0.0);
    spine.lineTo(0.00165, -0.000072);
    spine.lineTo(-0.00210, -0.000072);
    spine.lineTo(-0.00240, 0.0);
    spine.closePath();
    const spineG = new THREE.ExtrudeGeometry(spine, {
      depth: 0.000095,
      bevelEnabled: true,
      bevelThickness: 0.000014,
      bevelSize: 0.000012,
      bevelSegments: 2,
    });
    spineG.rotateX(Math.PI / 2);
    spineG.translate(0, 0.0000475, 0);
    spineG.computeVertexNormals();

    // Tandem Stage-1 solid booster shell (local origin at booster centre, length 1.11 m)
    const bProf: [number, number][] = [
      [0.000160, -0.00056],
      [0.000255, -0.00042],
      [0.000315, -0.00030],
      [0.000315, 0.00042],
      [0.000265, 0.00055],
    ];
    const bGeo = new THREE.LatheGeometry(
      bProf.map(([r, y]) => new THREE.Vector2(r, y)),
      48,
    );
    bGeo.rotateZ(-Math.PI / 2);
    bGeo.computeVertexNormals();

    // Chamfered booster stabilizer fin
    const bfShape = new THREE.Shape();
    bfShape.moveTo(0.00018, 0);
    bfShape.lineTo(-0.00024, 0);
    bfShape.lineTo(-0.00028, 0.00026);
    bfShape.lineTo(-0.00002, 0.00026);
    bfShape.closePath();
    const bfGeo = new THREE.ExtrudeGeometry(bfShape, {
      depth: 0.000022,
      bevelEnabled: true,
      bevelThickness: 0.000005,
      bevelSize: 0.000005,
      bevelSegments: 1,
    });
    bfGeo.translate(0, 0, -0.000011);
    bfGeo.computeVertexNormals();

    return {
      bodyGeo: body,
      noseCapGeo: noseCap,
      finGeo: fin,
      strakeGeo: strakeG,
      cowlGeo: cowlG,
      rampGeo: rampG,
      spineGeo: spineG,
      boosterGeo: bGeo,
      boosterFinGeo: bfGeo,
    };
  }, []);

  const plumeOuterMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: WEB_PLUME_VERT,
        fragmentShader: WEB_PLUME_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uRegime: { value: 0 },
          uPower: { value: 1 },
          uUnstart: { value: 0 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  const plumeCoreMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: WEB_PLUME_VERT,
        fragmentShader: WEB_PLUME_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uRegime: { value: 0 },
          uPower: { value: 1 },
          uUnstart: { value: 0 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  const finAngles: { key: string; angle: number; ref: RefObject<THREE.Group | null> }[] = [
    { key: "right", angle: 0, ref: finRight },
    { key: "up", angle: -Math.PI / 2, ref: finUp },
    { key: "left", angle: Math.PI, ref: finLeft },
    { key: "down", angle: Math.PI / 2, ref: finDown },
  ];

  useFrame(({ clock }) => {
    const rt = useAppStore.getState().runtime;
    const tAnim = clock.elapsedTime;
    const s = rt ? rt.missileSampler.sampleAt(simClock.time) : null;
    const sep = s?.stageSep !== undefined ? s.stageSep > 0.5 : simClock.time >= 13.0;
    const unstart = (s?.unstartFlag ?? 0) > 0.5 ? 1 : 0;

    // Stage-1 tandem booster separation & tumble dynamics (+Z is down in body frame)
    if (boosterRef.current) {
      if (!sep) {
        boosterRef.current.visible = true;
        boosterRef.current.position.set(-0.00350, 0, 0);
        boosterRef.current.rotation.set(0, 0, 0);
      } else {
        const tau = Math.max(0, simClock.time - 13.0);
        boosterRef.current.visible = tau < 8.5;
        if (boosterRef.current.visible) {
          const back = (0.008 * tau + 0.0012 * tau * tau);
          const down = (0.002 * tau + 0.0025 * tau * tau);
          boosterRef.current.position.set(-0.00350 - back, 0, down);
          boosterRef.current.rotation.set(0.5 * tau, 0.72 * tau, 0.25 * tau);
        }
      }
    }
    if (boosterGlowRef.current) boosterGlowRef.current.visible = !sep;

    // Unstart shock-buzz throat glow inside intakes
    if (buzzMatRef.current) {
      buzzMatRef.current.emissiveIntensity = unstart ? 1.8 + 1.2 * Math.sin(tAnim * 55) : 0;
    }

    // Dual-regime GLSL volumetric exhaust plume (solid boost <-> Mach-diamond scramjet)
    const scramOn = sep && (s ? s.mach >= 1.55 && s.altM < 32200 && s.massKg > 1002 : true);
    const boostOn = !sep;
    const power = !(boostOn || scramOn)
      ? 0
      : boostOn
        ? 1.0
        : THREE.MathUtils.clamp((s?.qPa ?? 90000) / 140000, 0.35, 1.0);

    if (plumeGroup.current) {
      plumeGroup.current.visible = power > 0.02;
      plumeGroup.current.position.set(sep ? -0.00320 : -0.00408, 0, 0);
      if (plumeGroup.current.visible) {
        const lenScale = sep
          ? THREE.MathUtils.lerp(0.68, 1.08, power) * (unstart ? 0.45 : 1.0)
          : 1.32;
        const radScale = sep ? 0.72 : 1.22;
        const flick = 1 + 0.04 * Math.sin(tAnim * 47);
        if (plumeOuterRef.current) {
          plumeOuterRef.current.scale.set(radScale * flick, lenScale, radScale * flick);
          plumeOuterRef.current.position.x = -0.00175 * lenScale;
        }
        if (plumeCoreRef.current) {
          plumeCoreRef.current.scale.set(radScale * 0.56 * flick, lenScale * 0.78, radScale * 0.56 * flick);
          plumeCoreRef.current.position.x = -0.00125 * lenScale;
        }
        plumeOuterMat.uniforms.uTime.value = tAnim;
        plumeOuterMat.uniforms.uRegime.value = sep ? 1 : 0;
        plumeOuterMat.uniforms.uPower.value = power * 0.85;
        plumeOuterMat.uniforms.uUnstart.value = unstart;

        plumeCoreMat.uniforms.uTime.value = tAnim * 1.12;
        plumeCoreMat.uniforms.uRegime.value = sep ? 1 : 0;
        plumeCoreMat.uniforms.uPower.value = power;
        plumeCoreMat.uniforms.uUnstart.value = unstart;
      }
    }
    if (nozzleGlow.current) {
      nozzleGlow.current.visible = power > 0.02 && sep;
      const mat = nozzleGlow.current.material as THREE.MeshBasicMaterial;
      mat.color.set(unstart ? "#ff7a30" : "#9fe0ff");
    }

    if (s) {
      const f = s.finDeflectionsRad;
      if (f) {
        const clamp = (v: number) => Math.max(-0.55, Math.min(0.55, v));
        if (finUp.current) finUp.current.rotation.y = clamp(f.up);
        if (finDown.current) finDown.current.rotation.y = clamp(f.down);
        if (finLeft.current) finLeft.current.rotation.y = clamp(f.left);
        if (finRight.current) finRight.current.rotation.y = clamp(f.right);
      }
    }
    if (axes.current) {
      const mode = useAppStore.getState().cameraMode;
      axes.current.visible = mode === "closeup";
    }
  });

  return (
    <group>
      {/* Monocoque ceramic-titanium lifting body with Von Kármán ogive */}
      <mesh geometry={bodyGeo}>
        <meshPhysicalMaterial
          color="#e2eaf2"
          metalness={0.44}
          roughness={0.32}
          clearcoat={0.72}
          clearcoatRoughness={0.24}
          emissive="#1a2733"
          emissiveIntensity={0.14}
        />
      </mesh>

      {/* Dark C-SiC ablative thermal nose tip */}
      <mesh geometry={noseCapGeo}>
        <meshStandardMaterial color="#2b323b" metalness={0.55} roughness={0.48} />
      </mesh>

      {/* Recessed sapphire MWIR / X-band seeker optical aperture bezel */}
      <mesh position={[0.00342, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.000105, 0.00024, 28, 1, true]} />
        <meshPhysicalMaterial
          color="#0e263b"
          metalness={0.3}
          roughness={0.1}
          clearcoat={1}
          emissive={COLORS.cyan}
          emissiveIntensity={0.52}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Dorsal avionics & cable raceway along top (-Z) */}
      <mesh geometry={spineGeo} position={[0, 0, -0.000278]}>
        <meshStandardMaterial color="#c6d0db" metalness={0.52} roughness={0.36} />
      </mesh>

      {/* Panel clamp rings & heat-shielded service bands */}
      {[0.00182, 0.00095, -0.00065, -0.00215].map((x) => (
        <mesh key={x} position={[x, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[0.000287, 0.000007, 8, 48]} />
          <meshStandardMaterial color="#7f8d9c" metalness={0.78} roughness={0.3} />
        </mesh>
      ))}
      <mesh position={[-0.00125, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.000289, 0.000289, 0.000055, 48]} />
        <meshStandardMaterial color="#2a3440" metalness={0.62} roughness={0.44} />
      </mesh>
      <mesh position={[0.00218, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.000275, 0.000284, 0.000045, 48]} />
        <meshStandardMaterial
          color={COLORS.accent}
          emissive={COLORS.accent}
          emissiveIntensity={0.35}
          metalness={0.5}
          roughness={0.3}
        />
      </mesh>

      {/* Twin lateral-ventral 2D scramjet compression-ramp intakes */}
      {[1, -1].map((side) => (
        <group key={`scram-${side}`} position={[0, side * 0.000265, 0.00008]} rotation={[side * 0.2, 0, 0]}>
          <mesh geometry={cowlGeo}>
            <meshStandardMaterial color="#4e5864" metalness={0.7} roughness={0.34} />
          </mesh>
          <mesh geometry={rampGeo}>
            <meshStandardMaterial color="#76828f" metalness={0.8} roughness={0.26} />
          </mesh>
          {/* Metallic cowl lip */}
          <mesh position={[0.00105, 0, 0.000085]}>
            <boxGeometry args={[0.00010, 0.00018, 0.00017]} />
            <meshStandardMaterial color="#96a3b0" metalness={0.88} roughness={0.22} />
          </mesh>
          {/* Dark inlet duct throat with live unstart shock-buzz glow */}
          <mesh position={[0.00112, 0, 0.000085]}>
            <boxGeometry args={[0.000025, 0.000135, 0.000135]} />
            <meshStandardMaterial
              ref={side === 1 ? buzzMatRef : undefined}
              color="#0b1017"
              metalness={0.2}
              roughness={0.85}
              emissive="#ff5e14"
              emissiveIntensity={0}
            />
          </mesh>
        </group>
      ))}

      {/* Swept-delta lifting strake wings (3.8 m root chord, NO fake canards) */}
      {[1, -1].map((side) => (
        <mesh key={`strake${side}`} geometry={strakeGeo} scale={[1, side, 1]}>
          <meshStandardMaterial color="#7b8590" metalness={0.64} roughness={0.38} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {/* Cruciform all-moving tail fins + metallic EMA actuator root pods */}
      {finAngles.map(({ key, angle, ref }) => (
        <group key={key} position={[-0.00242, 0, 0]} rotation={[angle, 0, 0]}>
          <mesh position={[0, 0.000275, 0]} rotation={[0, 0, -Math.PI / 2]}>
            <cylinderGeometry args={[0.000032, 0.000038, 0.00034, 12]} />
            <meshStandardMaterial color="#58626e" metalness={0.78} roughness={0.32} />
          </mesh>
          <group ref={ref}>
            <mesh geometry={finGeo} position={[0, 0.000272, 0]}>
              <meshStandardMaterial color="#96a3b0" metalness={0.72} roughness={0.34} side={THREE.DoubleSide} />
            </mesh>
          </group>
        </group>
      ))}

      {/* Sustainer scramjet divergent nozzle bell & throat glow */}
      <mesh position={[-0.00308, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.000185, 0.000235, 0.00026, 32, 1, true]} />
        <meshStandardMaterial color="#3a4048" metalness={0.92} roughness={0.26} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={nozzleGlow} position={[-0.00319, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <circleGeometry args={[0.000175, 28]} />
        <meshBasicMaterial
          color="#9fe0ff"
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Tandem Stage-1 solid booster (separates & tumbles away at t = 13 s) */}
      <group ref={boosterRef} position={[-0.00350, 0, 0]}>
        <mesh geometry={boosterGeo}>
          <meshStandardMaterial color="#73755a" metalness={0.34} roughness={0.5} />
        </mesh>
        {/* Titanium separation clamp ring + dark graphite band */}
        <mesh position={[0.00052, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[0.000285, 0.000016, 8, 36]} />
          <meshStandardMaterial color="#9aa4ae" metalness={0.82} roughness={0.26} />
        </mesh>
        <mesh position={[0.00008, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[0.000318, 0.000012, 8, 36]} />
          <meshStandardMaterial color="#2f353c" metalness={0.45} roughness={0.52} />
        </mesh>
        {/* 4 chamfered booster stabilizer fins + clamp latches */}
        {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((ang) => (
          <group key={`bf-${ang}`} rotation={[ang, 0, 0]}>
            <mesh geometry={boosterFinGeo} position={[-0.00018, 0.00030, 0]}>
              <meshStandardMaterial color="#464d55" metalness={0.6} roughness={0.44} />
            </mesh>
          </group>
        ))}
        <mesh ref={boosterGlowRef} position={[-0.00056, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <circleGeometry args={[0.000155, 24]} />
          <meshBasicMaterial
            color="#ffba66"
            transparent
            opacity={0.95}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>

      {/* Volumetric GLSL Mach-diamond exhaust plume (boost <-> scramjet <-> unstart) */}
      <group ref={plumeGroup} position={[-0.00408, 0, 0]}>
        <mesh ref={plumeOuterRef} material={plumeOuterMat} position={[-0.00175, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
          <cylinderGeometry args={[0.00022, 0.000035, 0.0035, 26, 20, true]} />
        </mesh>
        <mesh ref={plumeCoreRef} material={plumeCoreMat} position={[-0.00125, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
          <cylinderGeometry args={[0.00014, 0.000015, 0.0025, 22, 20, true]} />
        </mesh>
      </group>

      <BodyAxes groupRef={axes} />
      <AeroPhysicsField />
    </group>
  );
}

/**
 * High-fidelity 15.7 m × 10.7 m F-35A Lightning II target (km units, +X nose, +Y right, +Z down):
 * - 24-segment superelliptic chined Have-Glass V fuselage + AN/APG-81 RAM radome
 * - Gold-tinted ITO frameless stealth bubble canopy + cockpit sill collar
 * - Sculpted forward-swept DSI caret inlets + compression bumps
 * - Faceted sapphire EOTS chin prism
 * - 15-petal serrated F135 stealth nozzle + GLSL Mach-diamond afterburner plume
 * - Live 3D countermeasure IR flare ejection when decoyActive > 0.5
 */
function TargetBody() {
  const abPlumeRef = useRef<THREE.Mesh>(null);
  const petalInstRef = useRef<THREE.InstancedMesh>(null);
  const flareCoreInstRef = useRef<THREE.InstancedMesh>(null);
  const flareHaloInstRef = useRef<THREE.InstancedMesh>(null);
  const instDummy = useMemo(() => new THREE.Object3D(), []);

  const geo = useMemo(() => {
    const seg = 24;
    const exp = 2 / 3.1;
    const ring: [number, number][] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ring.push([
        Math.sign(c) * Math.pow(Math.abs(c), exp),
        Math.sign(s) * Math.pow(Math.abs(s), exp),
      ]);
    }

    const loft = (stations: { x: number; w: number; h: number; z: number }[]) => {
      const positions: number[] = [];
      const indices: number[] = [];
      for (const st of stations) {
        for (const [ry, rz] of ring) {
          positions.push(st.x, st.w * ry, st.z + st.h * rz);
        }
      }
      for (let i = 0; i < stations.length - 1; i++) {
        for (let j = 0; j < seg; j++) {
          const a = i * seg + j;
          const b = i * seg + ((j + 1) % seg);
          const c = (i + 1) * seg + ((j + 1) % seg);
          const d = (i + 1) * seg + j;
          indices.push(a, b, d, b, c, d);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      g.setIndex(indices);
      g.computeVertexNormals();
      return g;
    };

    const fuselage = loft([
      { x: 0.00785, w: 0.00004, h: 0.00003, z: 0 },
      { x: 0.00715, w: 0.00028, h: 0.00023, z: -0.00002 },
      { x: 0.00630, w: 0.00049, h: 0.00040, z: -0.00003 },
      { x: 0.00510, w: 0.00069, h: 0.00050, z: -0.00005 },
      { x: 0.00380, w: 0.00088, h: 0.00059, z: -0.00006 },
      { x: 0.00220, w: 0.00106, h: 0.00065, z: -0.00006 },
      { x: 0.00060, w: 0.00112, h: 0.00065, z: -0.00005 },
      { x: -0.00120, w: 0.00110, h: 0.00062, z: -0.00003 },
      { x: -0.00300, w: 0.00100, h: 0.00057, z: -0.00001 },
      { x: -0.00480, w: 0.00084, h: 0.00051, z: 0 },
      { x: -0.00620, w: 0.00066, h: 0.00046, z: 0 },
      { x: -0.00720, w: 0.00052, h: 0.00043, z: 0 },
      { x: -0.00775, w: 0.00048, h: 0.00042, z: 0 },
    ]);

    const radome = loft([
      { x: 0.00786, w: 0.000045, h: 0.000035, z: 0 },
      { x: 0.00715, w: 0.000285, h: 0.000235, z: -0.00002 },
      { x: 0.00645, w: 0.000465, h: 0.000385, z: -0.00003 },
    ]);

    const extrude = (build: (s: THREE.Shape) => void, depth: number) => {
      const shape = new THREE.Shape();
      build(shape);
      const g = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: depth * 0.28,
        bevelSize: depth * 0.28,
        bevelSegments: 2,
        curveSegments: 2,
      });
      g.translate(0, 0, -depth / 2);
      g.computeVertexNormals();
      return g;
    };

    const wing = extrude((s) => {
      s.moveTo(0.00205, 0.00075);
      s.lineTo(-0.00135, 0.00535);
      s.lineTo(-0.00310, 0.00535);
      s.lineTo(-0.00405, 0.00075);
      s.closePath();
    }, 0.000048);

    const flap = extrude((s) => {
      s.moveTo(0.00055, 0.00205);
      s.lineTo(-0.00132, 0.00532);
      s.lineTo(-0.00187, 0.00532);
      s.lineTo(-0.00002, 0.00205);
      s.closePath();
    }, 0.000018);

    const stab = extrude((s) => {
      s.moveTo(-0.00415, 0.00055);
      s.lineTo(-0.00535, 0.00245);
      s.lineTo(-0.00615, 0.00245);
      s.lineTo(-0.00625, 0.00055);
      s.closePath();
    }, 0.000030);

    const tail = extrude((s) => {
      s.moveTo(-0.00260, 0.00000);
      s.lineTo(-0.00445, 0.00255);
      s.lineTo(-0.00535, 0.00255);
      s.lineTo(-0.00555, 0.00000);
      s.closePath();
    }, 0.000026);
    tail.rotateX(-Math.PI / 2); // +Y -> -Z (UP in web body frame)

    // Sculpted forward-swept DSI caret inlet fairing (XZ profile extruded in Y)
    const dsiShape = new THREE.Shape();
    dsiShape.moveTo(0.00245, -0.00010);
    dsiShape.lineTo(0.00195, 0.00034);
    dsiShape.lineTo(-0.00045, 0.00034);
    dsiShape.lineTo(-0.00065, -0.00014);
    dsiShape.closePath();
    const dsi = new THREE.ExtrudeGeometry(dsiShape, {
      depth: 0.00040,
      bevelEnabled: true,
      bevelThickness: 0.00004,
      bevelSize: 0.00004,
      bevelSegments: 2,
    });
    dsi.rotateX(Math.PI / 2);
    dsi.translate(0, 0.00020, 0);
    dsi.computeVertexNormals();

    const petal = new THREE.ConeGeometry(0.000095, 0.00034, 4);
    petal.rotateZ(Math.PI / 2);

    return { fuselage, radome, wing, flap, stab, tail, dsi, petal };
  }, []);

  const abMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: WEB_PLUME_VERT,
        fragmentShader: WEB_AB_FRAG,
        uniforms: { uTime: { value: 0 }, uIntensity: { value: 0.65 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );

  useEffect(() => {
    const inst = petalInstRef.current;
    if (!inst) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 15; i++) {
      const ang = (i / 15) * Math.PI * 2;
      dummy.position.set(-0.00804, Math.cos(ang) * 0.00041, Math.sin(ang) * 0.00041);
      dummy.rotation.set(ang, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
  }, []);

  useFrame(({ clock }) => {
    const tAnim = clock.elapsedTime;
    const rt = useAppStore.getState().runtime;
    const ms = rt ? rt.missileSampler.sampleAt(simClock.time) : null;
    const evading = ms ? ms.rangeM < 16000 : false;
    const decoyOn = (ms?.decoyActive ?? 0) > 0.5;

    abMat.uniforms.uTime.value = tAnim;
    abMat.uniforms.uIntensity.value = evading ? 0.95 : 0.52;
    if (abPlumeRef.current) {
      const abLen = (evading ? 1.3 : 0.72) * (1 + 0.04 * Math.sin(tAnim * 43));
      abPlumeRef.current.scale.set(1, abLen, 1);
      abPlumeRef.current.position.x = -0.00802 - 0.0018 * abLen;
    }

    const coreInst = flareCoreInstRef.current;
    const haloInst = flareHaloInstRef.current;
    if (coreInst && haloInst) {
      coreInst.visible = decoyOn;
      haloInst.visible = decoyOn;
      if (decoyOn) {
        for (let i = 0; i < 6; i++) {
          const age = (simClock.time * 1.45 + i * 0.31) % 1.8;
          const side = i % 2 === 0 ? 1 : -1;
          const back = 0.0028 + 0.016 * age + 0.0045 * age * age;
          const drop = 0.0011 + 0.0052 * age + 0.0034 * age * age; // +Z is down
          const lat = side * (0.0012 + 0.0046 * age + 0.0006 * Math.sin(age * 5 + i));
          const fade = THREE.MathUtils.clamp(1.25 - age / 1.8, 0.22, 1.15);
          const sc = fade * (0.9 + 0.15 * Math.sin(tAnim * 38 + i * 2));
          instDummy.position.set(-0.004 - back, lat, 0.0008 + drop);
          instDummy.rotation.set(0, 0, 0);
          instDummy.scale.setScalar(sc);
          instDummy.updateMatrix();
          coreInst.setMatrixAt(i, instDummy.matrix);
          haloInst.setMatrixAt(i, instDummy.matrix);
        }
        coreInst.instanceMatrix.needsUpdate = true;
        haloInst.instanceMatrix.needsUpdate = true;
      }
    }
  });

  return (
    <group>
      {/* Have-Glass V chined blended stealth fuselage + darker AN/APG-81 radome */}
      <mesh geometry={geo.fuselage}>
        <meshStandardMaterial color="#626b76" metalness={0.48} roughness={0.46} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geo.radome}>
        <meshStandardMaterial color="#343b44" metalness={0.55} roughness={0.44} side={THREE.DoubleSide} />
      </mesh>

      {/* Gold-tinted ITO frameless stealth bubble canopy + dark cockpit sill (-Z = UP) */}
      <mesh position={[0.00355, 0, -0.00052]} scale={[0.00215, 0.00058, 0.00052]}>
        <sphereGeometry args={[1, 28, 18]} />
        <meshPhysicalMaterial
          color="#3b311d"
          metalness={0.72}
          roughness={0.08}
          clearcoat={1}
          clearcoatRoughness={0.05}
          emissive="#634616"
          emissiveIntensity={0.34}
        />
      </mesh>
      <mesh position={[0.00352, 0, -0.00044]} scale={[0.00212, 0.00060, 0.00050]}>
        <torusGeometry args={[1, 0.06, 8, 28]} />
        <meshStandardMaterial color="#2a3038" metalness={0.72} roughness={0.36} />
      </mesh>

      {/* Sculpted forward-swept DSI caret inlets + smooth compression bumps */}
      {[1, -1].map((side) => (
        <group key={`dsi-${side}`} position={[0.0001, side * 0.00105, 0.00014]} rotation={[0, 0, side * -0.06]}>
          <mesh geometry={geo.dsi}>
            <meshStandardMaterial color="#4b535d" metalness={0.54} roughness={0.46} />
          </mesh>
          <mesh position={[0.00222, side * 0.00004, 0.00012]} rotation={[0, 0.3, 0]}>
            <boxGeometry args={[0.00005, 0.00030, 0.00034]} />
            <meshStandardMaterial color="#10151b" metalness={0.3} roughness={0.8} />
          </mesh>
          <mesh position={[0.00192, -side * 0.00012, 0.00006]} scale={[0.00056, 0.00022, 0.00024]}>
            <sphereGeometry args={[1, 14, 10]} />
            <meshStandardMaterial color="#626b76" metalness={0.48} roughness={0.46} />
          </mesh>
        </group>
      ))}

      {/* Clipped trapezoidal wings + RAM leading-edge flaps + stabilators + canted tails */}
      {[1, -1].map((side) => (
        <group key={`aero-${side}`}>
          <mesh geometry={geo.wing} scale={[1, side, 1]}>
            <meshStandardMaterial color="#68727d" metalness={0.48} roughness={0.48} side={THREE.DoubleSide} />
          </mesh>
          <mesh geometry={geo.flap} position={[0, 0, -0.00003]} scale={[1, side, 1]}>
            <meshStandardMaterial color="#4b535d" metalness={0.52} roughness={0.46} side={THREE.DoubleSide} />
          </mesh>
          <mesh geometry={geo.stab} scale={[1, side, 1]}>
            <meshStandardMaterial color="#626b76" metalness={0.48} roughness={0.48} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
      {[1, -1].map((side) => (
        <group key={`tail-${side}`} position={[0, side * 0.00115, -0.00026]} rotation={[side * 0.56, 0, 0]}>
          <mesh geometry={geo.tail}>
            <meshStandardMaterial color="#656f7a" metalness={0.48} roughness={0.48} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}

      {/* Faceted sapphire EOTS chin prism (+Z = bottom) */}
      <mesh position={[0.00545, 0, 0.00034]} scale={[0.00046, 0.00024, 0.00018]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#2a3038" metalness={0.62} roughness={0.4} />
      </mesh>
      <mesh position={[0.00562, 0, 0.00038]} scale={[0.00024, 0.00014, 0.00011]}>
        <octahedronGeometry args={[1, 0]} />
        <meshPhysicalMaterial
          color="#0d2236"
          metalness={0.55}
          roughness={0.08}
          clearcoat={1}
          emissive="#1e648c"
          emissiveIntensity={0.4}
        />
      </mesh>

      {/* 15-petal serrated F135 stealth nozzle (InstancedMesh, 1 draw call!) + afterburner */}
      <mesh position={[-0.00756, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00044, 0.00048, 0.00088, 24]} />
        <meshStandardMaterial color="#2e343c" metalness={0.85} roughness={0.32} />
      </mesh>
      <instancedMesh ref={petalInstRef} args={[geo.petal, undefined, 15]}>
        <meshStandardMaterial color="#3c434c" metalness={0.86} roughness={0.3} />
      </instancedMesh>
      <mesh position={[-0.00796, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <circleGeometry args={[0.00032, 24]} />
        <meshBasicMaterial color="#ff9a52" transparent opacity={0.78} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={abPlumeRef} material={abMat} position={[-0.00985, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.00031, 0.00005, 0.0036, 22, 16, true]} />
      </mesh>

      {/* Live 3D countermeasure IR flares via InstancedMesh (2 draw calls total!) */}
      <instancedMesh ref={flareCoreInstRef} args={[undefined, undefined, 6]} visible={false}>
        <sphereGeometry args={[0.00024, 10, 8]} />
        <meshBasicMaterial
          color="#fff0c2"
          transparent
          opacity={0.95}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
      <instancedMesh ref={flareHaloInstRef} args={[undefined, undefined, 6]} visible={false}>
        <sphereGeometry args={[0.00068, 10, 8]} />
        <meshBasicMaterial
          color="#ff7c24"
          transparent
          opacity={0.42}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>

      {/* Wingtip navigation lights: green right (+Y), red left (-Y) */}
      <mesh position={[-0.00200, 0.00536, -0.00002]}>
        <sphereGeometry args={[0.000055, 8, 8]} />
        <meshBasicMaterial color="#4dff9a" />
      </mesh>
      <mesh position={[-0.00200, -0.00536, -0.00002]}>
        <sphereGeometry args={[0.000055, 8, 8]} />
        <meshBasicMaterial color="#ff4d4d" />
      </mesh>
    </group>
  );
}

interface EntityProps {
  kind: "missile" | "target";
  label: string;
  color: string;
  showLabel?: boolean;
  modelScale?: number;
}

export function EntityVisual({ kind, label, color, showLabel = false, modelScale = 1 }: EntityProps) {
  const model = useRef<THREE.Group>(null);
  const marker = useRef<THREE.Sprite>(null);
  const labelAnchor = useRef<THREE.Group>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const glowTex = useGlowTexture(
    "rgba(255,255,255,1)",
    kind === "missile" ? "rgba(255,178,87,0.55)" : "rgba(99,230,255,0.55)",
  );

  useFrame(({ camera }) => {
    const rt = useAppStore.getState().runtime;
    if (!rt || !model.current) return;
    const sampler = kind === "missile" ? rt.missileSampler : rt.targetSampler;
    const s = sampler.sampleAt(simClock.time);
    const p = new THREE.Vector3(s.position.x, s.position.y, s.position.z).multiplyScalar(KM);
    model.current.position.copy(p);
    model.current.quaternion.set(s.attitude.x, s.attitude.y, s.attitude.z, s.attitude.w);
    model.current.scale.setScalar(modelScale);

    if (marker.current) {
      marker.current.position.copy(p);
      const d = camera.position.distanceTo(p);
      marker.current.scale.setScalar(Math.max(0.02, d * 0.013));
      const mat = marker.current.material as THREE.SpriteMaterial;
      // The marker is an orbital-scale locator: fade it out well before it can
      // swamp the real, physically sized vehicle at close range.
      mat.opacity = THREE.MathUtils.clamp((d - 0.5) / 3, 0, 0.85);
    }
    if (labelAnchor.current) {
      labelAnchor.current.position.copy(p);
      // Entity labels are useful at close range only; beacons carry the
      // geographic context when zoomed out.
      const near = camera.position.distanceTo(p) < 90;
      if (labelRef.current) labelRef.current.style.display = near ? "block" : "none";
    }
  });

  return (
    <>
      <group ref={model} name={`entity-${kind}`}>
        {kind === "missile" ? <MissileBody /> : <TargetBody />}
      </group>
      <sprite ref={marker} scale={0.01}>
        <spriteMaterial map={glowTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} color={color} />
      </sprite>
      {showLabel && (
        <group ref={labelAnchor}>
          <Html position={[0, 0.0004, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <div className={`entity-tag entity-tag--${kind}`} ref={labelRef} style={{ display: "none" }}>{label}</div>
          </Html>
        </group>
      )}
    </>
  );
}

/** Beacon at the launch/target datum (WGS84 ellipsoid surface). */
export function SurfaceBeacon({
  latDeg,
  lonDeg,
  altM,
  label,
  color,
  kind,
}: {
  latDeg: number;
  lonDeg: number;
  altM: number;
  label: string;
  color: string;
  kind: "launch" | "target";
}) {
  const group = useRef<THREE.Group>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const position = useMemo<[number, number, number]>(() => {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const s = Math.sin(lat);
    const n = EARTH_A_KM / Math.sqrt(1 - WGS84_E2_KM * s * s);
    const x = (n + altM * KM) * Math.cos(lat) * Math.cos(lon);
    const y = (n + altM * KM) * Math.cos(lat) * Math.sin(lon);
    const z = (n * (1 - WGS84_E2_KM) + altM * KM) * s;
    return [x, y, z];
  }, [latDeg, lonDeg, altM]);

  useFrame(({ clock, camera }) => {
    if (!group.current) return;
    group.current.scale.setScalar(1 + 0.18 * Math.sin(clock.elapsedTime * 2.2));
    // Datum labels belong to the orbital/plan view, not to a close chase pass.
    if (labelRef.current) {
      labelRef.current.style.display =
        camera.position.length() > EARTH_A_KM * 1.03 ? "flex" : "none";
    }
  });

  return (
    <group position={position} ref={group}>
      <mesh>
        <sphereGeometry args={[6, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} />
      </mesh>
      <mesh>
        <sphereGeometry args={[16, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <Html position={[0, kind === "target" ? -190 : 120, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        <div className={`surface-tag surface-tag--${kind}`} ref={labelRef}>
          <span className="surface-tag__dot" />
          {label}
        </div>
      </Html>
    </group>
  );
}
