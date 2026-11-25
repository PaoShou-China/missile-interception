import { Suspense, useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { SKY_PRESETS, asset } from "./assets";
import { MapTileTexture } from "./MapTiles";
import { dataClock } from "../data/dataClock";
import { getTelemetry, sampleAt } from "../data/telemetry";
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
  const dome = useRef<THREE.Mesh>(null);

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

  // The dome has to follow the camera, otherwise the target tracking shot (which
  // rides tens of kilometres or more from the missile) ends up outside the shell
  // and the sky drops out behind the airframe.
  useFrame(({ camera }) => {
    if (dome.current) dome.current.position.copy(camera.position);
  });

  return (
    <mesh ref={dome} scale={50_000} frustumCulled={false} renderOrder={-1000}>
      <sphereGeometry args={[1, 48, 32]} />
      <shaderMaterial
        vertexShader={SKY_VERT}
        fragmentShader={SKY_FRAG}
        uniforms={uniforms}
        side={THREE.BackSide}
        depthWrite={false}
        depthTest={false}
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
  const shadowSize = quality === "cinematic" ? 2048 : 1024;
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
        args={[preset.horizon, preset.ground, timeOfDay === "night" ? 0.34 : timeOfDay === "dusk" ? 0.28 : 0.42]}
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
      // Night needs a readable body instead of a black silhouette.
      intensity={timeOfDay === "night" ? 0.55 : 0.12}
      distance={timeOfDay === "night" ? 140 : 80}
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
  uniform sampler2D uTerrain;
  uniform vec2 uOrigin;
  uniform vec2 uFarOffset;
  uniform float uSpan;
  uniform float uHasMap;
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
    vec2 uvFar = vWorld.xz / 520000.0 + uFarOffset;
    vec3 baseFar = texture2D(uTerrain, uvFar).rgb;

    // Live satellite tiles, recentred on the recorded position. Both layers
    // scroll with the vehicle; the tile layer takes over close to the nadir.
    vec2 uvNear = vWorld.xz / uSpan + uOrigin;
    vec3 baseNear = texture2D(uMap, uvNear).rgb;
    float r = length(vWorld.xz);
    // Keep the satellite layer inside the tile block (span 626 km => +-313 km).
    // Sampling past the block edge clamps to the border texels and smears into
    // flickering streaks, so hand over to the procedural layer well inside it.
    float blend = (1.0 - smoothstep(80000.0, 235000.0, r)) * uHasMap;
    vec3 base = mix(baseFar, baseNear, blend);

    float dl = max(dot(N, L), 0.0);
    // Sunlight is gone at night, so lift the ambient term instead of letting
    // the whole globe collapse to black.
    float amb = mix(0.26, 0.62, uNight);
    vec3 col = base * uTint * (amb + 0.9 * dl) * uSunColor;

    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col += vec3(0.33, 0.58, 0.86) * fres * 0.28 * (1.0 - uNight * 0.85);

    float dist = length(vWorld - cameraPosition);
    // The planar far layer stretches badly near the horizon; haze it out before
    // the stretch becomes visible so the horizon reads as a clean gradient.
    col = mix(col, uFog, smoothstep(180000.0, 600000.0, dist));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function Terrain() {
  const quality = useApp((s) => s.quality);
  const timeOfDay = useApp((s) => s.timeOfDay);
  const segments = quality === "cinematic" ? 128 : quality === "balanced" ? 96 : 64;
  const terrain = useLoader(THREE.TextureLoader, asset("terrain-day.webp")) as THREE.Texture;
  const preset = SKY_PRESETS[timeOfDay];
  const map = useMemo(() => new MapTileTexture(2048, 8, 9), []);
  const mat = useRef<THREE.ShaderMaterial>(null);
  const ground = useRef<THREE.Mesh>(null);
  const acc = useRef(0);

  useEffect(() => () => map.dispose(), [map]);

  useEffect(() => {
    terrain.wrapS = terrain.wrapT = THREE.RepeatWrapping;
    terrain.anisotropy = 8;
    terrain.needsUpdate = true;
  }, [terrain]);

  const uniforms = useMemo(
    () => ({
      uMap: { value: map.texture },
      uTerrain: { value: terrain },
      uOrigin: { value: new THREE.Vector2() },
      uFarOffset: { value: new THREE.Vector2() },
      uSpan: { value: map.spanMeters },
      uHasMap: { value: 0 },
      uTint: { value: new THREE.Color("#ffffff") },
      uSunDir: { value: preset.sunDir.clone() },
      uSunColor: { value: new THREE.Color(preset.sunColor) },
      uFog: { value: new THREE.Color(preset.hazeColor) },
      uNight: { value: 0 },
    }),
    [terrain, preset, map],
  );

  // ShaderMaterial keeps the uniform object it was built with, so write through
  // the material reference rather than the memoised prop.
  useEffect(() => {
    const u = mat.current?.uniforms;
    if (!u) return;
    u.uSunDir.value.copy(preset.sunDir);
    u.uSunColor.value.set(preset.sunColor);
    u.uFog.value.set(preset.hazeColor);
    u.uNight.value = timeOfDay === "night" ? 1 : 0;
    u.uTint.value.set(
      timeOfDay === "night" ? "#7b8ca3" : timeOfDay === "dusk" ? "#e8c4a8" : "#ffffff",
    );
  }, [uniforms, preset, timeOfDay]);

  // The scroll offset follows the clock every frame (a 0.5 s step made the
  // ground visibly jump), while tile uploads stay batched to one per 200 ms.
  useFrame((_, delta) => {
    const tel = getTelemetry();
    const sample = tel ? sampleAt(dataClock.t) : null;
    const frame = map.update(sample?.latDeg ?? 34, sample?.lonDeg ?? 118);
    // The world scrolls under a fixed camera, so the only way the recorded
    // altitude can read on screen is by moving the ground shell itself: at
    // T+0 the surface is at the airframe, at apogee it is 29.9 km below.
    // Follow the sample exactly: damping left a lag that changed with playback
    // rate, which read as the ground heaving under the vehicle.
    if (ground.current) {
      ground.current.position.y = -(R_EARTH + (sample?.altM ?? 0));
    }
    const u = mat.current?.uniforms;
    if (u) {
      u.uOrigin.value.set(frame.originU, frame.originV);
      u.uFarOffset.value.set(frame.farU, frame.farV);
      u.uSpan.value = frame.spanMeters;
      u.uHasMap.value = frame.ready ? 1 : 0;
    }
    acc.current += delta;
    if (acc.current >= 0.2) {
      acc.current = 0;
      map.flush();
    }
  });

  const geometry = useMemo(() => new THREE.SphereGeometry(1, segments * 2, segments), [segments]);

  return (
    <mesh ref={ground} geometry={geometry} position={[0, -(R_EARTH + 30_000), 0]} scale={[R_EARTH, R_EARTH, R_EARTH]}>
      <shaderMaterial
        ref={mat}
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
      {/* Unlit and single-sided: these are full-screen translucent layers, so
          PBR shading and back faces would multiply fill cost for no gain. */}
      <meshBasicMaterial
        map={map}
        transparent
        opacity={opacity}
        color={tintColor}
        depthWrite={false}
        side={THREE.FrontSide}
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
  const b = useLoader(THREE.TextureLoader, asset("cloud-b.webp")) as THREE.Texture;
  const layers =
    quality === "performance" || quality === "balanced"
      ? []
      : [{ y: -26_000, tex: b, repeat: 3, speed: 900, size: 2_400_000 }];

  return (
    <group>
      {layers.map((l, i) => (
        <CloudLayer
          key={i}
          y={l.y}
          size={l.size}
          repeat={l.repeat}
          speed={l.speed}
          opacity={Math.min(0.3, preset.cloudOpacity * (0.2 + density * 0.3))}
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
  // Warm the other two HDRIs once the first frame is settled so switching
  // time-of-day never stalls on a network round trip.
  useEffect(() => {
    const id = window.setTimeout(() => {
      useLoader.preload(RGBELoader, asset("env-dusk.hdr"));
      useLoader.preload(RGBELoader, asset("env-night.hdr"));
    }, 4000);
    return () => window.clearTimeout(id);
  }, []);

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
