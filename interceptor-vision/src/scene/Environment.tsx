import { Suspense, useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { SKY_PRESETS, asset } from "./assets";
import { useApp } from "../state";

const R_EARTH = 6_371_000;

/* ------------------------------------------------------------------ */
/* Sky dome                                                           */
/* ------------------------------------------------------------------ */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uHaze;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uMoonDir;
  uniform float uSunPower;
  uniform float uStars;
  varying vec3 vDir;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(up, 0.52));

    // Ground side fades into haze so the terrain patch and sky meet smoothly.
    col = mix(uHaze, col, smoothstep(-0.22, 0.02, d.y));

    float sun = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(sun, 1400.0) * 3.2;
    col += uSunColor * pow(sun, 26.0) * 0.14 * uSunPower;

    float moon = max(dot(d, normalize(uMoonDir)), 0.0);
    col += vec3(0.86, 0.92, 1.0) * pow(moon, 5200.0) * 2.4 * (1.0 - uSunPower);
    col += vec3(0.5, 0.62, 0.9) * pow(moon, 90.0) * 0.05 * (1.0 - uSunPower);

    if (uStars > 0.01 && d.y > 0.0) {
      vec3 g = floor(d * 460.0);
      float h = hash(g);
      float twinkle = 0.55 + 0.45 * sin(h * 71.0);
      float s = smoothstep(0.9975, 1.0, h) * twinkle;
      col += vec3(0.82, 0.89, 1.0) * s * 2.4 * uStars * smoothstep(0.0, 0.12, d.y);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

function SkyDome() {
  const timeOfDay = useApp((s) => s.timeOfDay);
  const preset = SKY_PRESETS[timeOfDay];

  const uniforms = useMemo(
    () => ({
      uZenith: { value: new THREE.Color(preset.zenith) },
      uHorizon: { value: new THREE.Color(preset.horizon) },
      uHaze: { value: new THREE.Color(preset.hazeColor) },
      uSunDir: { value: preset.sunDir.clone() },
      uSunColor: { value: new THREE.Color(preset.sunColor) },
      uMoonDir: { value: preset.moonDir.clone() },
      uSunPower: { value: Math.max(0, preset.sunDir.y) },
      uStars: { value: preset.stars },
    }),
    // Preset uniforms are replaced on theme change.
    [preset],
  );

  useEffect(() => {
    uniforms.uZenith.value.set(preset.zenith);
    uniforms.uHorizon.value.set(preset.horizon);
    uniforms.uHaze.value.set(preset.hazeColor);
    uniforms.uSunDir.value.copy(preset.sunDir);
    uniforms.uSunColor.value.set(preset.sunColor);
    uniforms.uMoonDir.value.copy(preset.moonDir);
    uniforms.uSunPower.value = Math.max(0, preset.sunDir.y);
    uniforms.uStars.value = preset.stars;
  }, [uniforms, preset]);

  return (
    <mesh scale={1_600_000} frustumCulled={false}>
      <sphereGeometry args={[1, 48, 32]} />
      <shaderMaterial
        vertexShader={SKY_VERT}
        fragmentShader={SKY_FRAG}
        uniforms={uniforms}
        side={THREE.BackSide}
        depthWrite={false}
        fog={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/* ------------------------------------------------------------------ */
/* HDRI environment lighting                                          */
/* ------------------------------------------------------------------ */

function HdriEnvironment({ file }: { file: string }) {
  const tex = useLoader(RGBELoader, file) as THREE.DataTexture;
  const { scene } = useThree();
  const intensity = useApp((s) => SKY_PRESETS[s.timeOfDay].envIntensity);

  useEffect(() => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = tex;
    scene.environmentIntensity = intensity;
    return () => {
      scene.environment = null;
    };
  }, [tex, scene, intensity]);

  return null;
}

function EnvironmentForTime() {
  const timeOfDay = useApp((s) => s.timeOfDay);
  const file = asset(`env-${timeOfDay}.hdr`);
  return (
    <Suspense fallback={null}>
      <HdriEnvironment key={file} file={file} />
    </Suspense>
  );
}

/* ------------------------------------------------------------------ */
/* Lights                                                             */
/* ------------------------------------------------------------------ */

function Lights() {
  const timeOfDay = useApp((s) => s.timeOfDay);
  const shadows = useApp((s) => s.shadows);
  const quality = useApp((s) => s.quality);
  const preset = SKY_PRESETS[timeOfDay];
  const sun = useRef<THREE.DirectionalLight>(null);
  const shadowSize = quality === "cinematic" ? 4096 : quality === "balanced" ? 2048 : 1024;
  const cast = shadows && quality !== "performance";

  useEffect(() => {
    if (sun.current) {
      sun.current.position.copy(preset.sunDir).multiplyScalar(400);
      sun.current.color.set(timeOfDay === "night" ? "#a9c1ff" : preset.sunColor);
      sun.current.intensity = timeOfDay === "night" ? 0.3 : preset.sunIntensity;
    }
  }, [preset, timeOfDay]);

  return (
    <>
      <directionalLight
        ref={sun}
        castShadow={cast}
        intensity={preset.sunIntensity}
        color={preset.sunColor}
        shadow-mapSize={[shadowSize, shadowSize]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.03}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-camera-near={1}
        shadow-camera-far={900}
      />
      <directionalLight
        position={preset.moonDir.clone().multiplyScalar(500)}
        intensity={preset.moonIntensity * (timeOfDay === "night" ? 1 : 0.15)}
        color="#93aee6"
      />
      <hemisphereLight
        args={[preset.horizon, preset.ground, timeOfDay === "night" ? 0.12 : timeOfDay === "dusk" ? 0.28 : 0.42]}
      />
      <CameraFillLight />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Curved terrain                                                     */
/* ------------------------------------------------------------------ */

function CameraFillLight() {
  const light = useRef<THREE.PointLight>(null);
  const timeOfDay = useApp((s) => s.timeOfDay);
  useFrame(({ camera }) => {
    if (light.current) light.current.position.copy(camera.position);
  });
  return (
    <pointLight
      ref={light}
      intensity={timeOfDay === "night" ? 0.26 : 0.12}
      distance={80}
      decay={2}
      color="#c2d6f2"
    />
  );
}

const EARTH_VERT = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const EARTH_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uTint;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uFog;
  uniform float uNight;
  varying vec3 vWorld;
  varying vec3 vNormal;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunDir);
    // Planar projection across the visible cap avoids the extreme stretching a
    // lat/long map shows when a 2D terrain tile is wrapped onto the globe.
    vec2 uv = vWorld.xz / 520000.0;
    vec3 base = texture2D(uMap, uv).rgb;
    float dl = max(dot(N, L), 0.0);
    vec3 col = base * uTint * (0.26 + 0.9 * dl) * uSunColor;

    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col += vec3(0.33, 0.58, 0.86) * fres * 0.28 * (1.0 - uNight * 0.85);

    float dist = length(vWorld - cameraPosition);
    col = mix(col, uFog, smoothstep(120000.0, 900000.0, dist));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function Terrain() {
  const quality = useApp((s) => s.quality);
  const timeOfDay = useApp((s) => s.timeOfDay);
  const segments = quality === "cinematic" ? 160 : quality === "balanced" ? 120 : 72;
  const color = useLoader(THREE.TextureLoader, asset("terrain-day.webp")) as THREE.Texture;
  const preset = SKY_PRESETS[timeOfDay];

  useEffect(() => {
    color.wrapS = color.wrapT = THREE.RepeatWrapping;
    color.anisotropy = 8;
    color.needsUpdate = true;
  }, [color]);

  const uniforms = useMemo(
    () => ({
      uMap: { value: color },
      uTint: { value: new THREE.Color("#ffffff") },
      uSunDir: { value: preset.sunDir.clone() },
      uSunColor: { value: new THREE.Color(preset.sunColor) },
      uFog: { value: new THREE.Color(preset.hazeColor) },
      uNight: { value: 0 },
    }),
    // Re-created per preset below through the effect.
    [color, preset],
  );

  useEffect(() => {
    uniforms.uSunDir.value.copy(preset.sunDir);
    uniforms.uSunColor.value.set(preset.sunColor);
    uniforms.uFog.value.set(preset.hazeColor);
    uniforms.uNight.value = timeOfDay === "night" ? 1 : 0;
    uniforms.uTint.value.set(
      timeOfDay === "night" ? "#5b6a80" : timeOfDay === "dusk" ? "#e8c4a8" : "#ffffff",
    );
  }, [uniforms, preset, timeOfDay]);

  const geometry = useMemo(() => new THREE.SphereGeometry(1, segments * 2, segments), [segments]);

  return (
    <mesh geometry={geometry} position={[0, -(R_EARTH + 30_000), 0]} scale={[R_EARTH, R_EARTH, R_EARTH]}>
      <shaderMaterial
        vertexShader={EARTH_VERT}
        fragmentShader={EARTH_FRAG}
        uniforms={uniforms}
        side={THREE.FrontSide}
      />
    </mesh>
  );
}

/* ------------------------------------------------------------------ */
/* Multi-layer clouds                                                 */
/* ------------------------------------------------------------------ */

function CloudLayer({
  y,
  size,
  repeat,
  speed,
  opacity,
  tint,
  texture,
}: {
  y: number;
  size: number;
  repeat: number;
  speed: number;
  opacity: number;
  tint: string;
  texture: THREE.Texture;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (mesh.current) mesh.current.position.x = (mesh.current.position.x + dt * speed) % 90_000;
  });

  const tintColor = useMemo(() => new THREE.Color(tint).multiplyScalar(0.72), [tint]);

  const map = useMemo(() => {
    const t = texture.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
    return t;
  }, [texture, repeat]);

  return (
    <mesh ref={mesh} position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial
        map={map}
        transparent
        opacity={opacity}
        color={tintColor}
        depthWrite={false}
        roughness={1}
        metalness={0}
        side={THREE.DoubleSide}
        fog
        polygonOffset
        polygonOffsetFactor={-1}
      />
    </mesh>
  );
}

function Clouds() {
  const density = useApp((s) => s.cloudDensity);
  const timeOfDay = useApp((s) => s.timeOfDay);
  const quality = useApp((s) => s.quality);
  const preset = SKY_PRESETS[timeOfDay];
  const a = useLoader(THREE.TextureLoader, asset("cloud-a.webp")) as THREE.Texture;
  const b = useLoader(THREE.TextureLoader, asset("cloud-b.webp")) as THREE.Texture;
  const layers =
    quality === "performance"
      ? [{ y: -20_000, tex: a, repeat: 4, speed: 1800, size: 2_300_000 }]
      : [
          { y: -12_000, tex: a, repeat: 6, speed: 2600, size: 2_200_000 },
          { y: -20_000, tex: b, repeat: 4, speed: 1500, size: 2_700_000 },
          { y: -27_000, tex: a, repeat: 3, speed: 800, size: 3_200_000 },
        ];

  return (
    <group>
      {layers.map((l, i) => (
        <CloudLayer
          key={i}
          y={l.y}
          size={l.size}
          repeat={l.repeat}
          speed={l.speed}
          opacity={Math.min(0.62, preset.cloudOpacity * (0.4 + density * 0.8))}
          tint={preset.cloudTint}
          texture={l.tex}
        />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Atmospheric haze and the assembled environment                     */
/* ------------------------------------------------------------------ */

function Haze() {
  const timeOfDay = useApp((s) => s.timeOfDay);
  const haze = useApp((s) => s.haze);
  const { scene } = useThree();
  const preset = SKY_PRESETS[timeOfDay];

  useEffect(() => {
    scene.fog = new THREE.Fog(
      new THREE.Color(preset.hazeColor),
      4_000 + haze * 8_000,
      480_000 - haze * 160_000,
    );
    return () => {
      scene.fog = null;
    };
  }, [scene, preset, haze]);

  return null;
}

export function RealtimeEnvironment() {
  return (
    <>
      <SkyDome />
      <EnvironmentForTime />
      <Lights />
      {/* Ground cover and clouds stream in after the first frame instead of
          delaying the whole scene on a slow connection. */}
      <Suspense fallback={null}>
        <Terrain />
      </Suspense>
      <Suspense fallback={null}>
        <Clouds />
      </Suspense>
      <Haze />
    </>
  );
}
