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
  uniform float uTime;
  uniform float uSkyPow;
  varying vec3 vDir;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.6;
    for (int i = 0; i < 3; i++) {
      v += a * vnoise(p);
      p *= 2.07;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(up, uSkyPow));

    float sun = max(dot(d, normalize(uSunDir)), 0.0);
    vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(0.0001, 0.0, 0.0));
    float az = max(dot(normalize(vec3(d.x, 0.0, d.z) + vec3(0.0001, 0.0, 0.0)), sunFlat), 0.0);

    // Warm band hugging the horizon on the sun side: this is what makes the
    // sky read as air rather than a two-stop gradient.
    float band = exp(-abs(d.y) * 15.0);
    col += uSunColor * pow(az, 5.0) * band * 0.2 * uSunPower;

    // Ground side fades into haze so the terrain patch and sky meet smoothly.
    col = mix(uHaze, col, smoothstep(-0.22, 0.02, d.y));

    // Thin atmosphere limb just above the horizon: at 30 km the planet edge
    // should read blue by day. The limb is a daylight effect, so scale it with
    // the sun rather than lighting the night horizon like a false dawn.
    float limb = exp(-abs(d.y) * 26.0) * smoothstep(-0.02, 0.02, d.y);
    col += vec3(0.2, 0.45, 0.82) * limb * 0.12 * smoothstep(-0.02, 0.2, uSunPower);

    col += uSunColor * pow(sun, 1400.0) * 3.2;
    col += uSunColor * pow(sun, 120.0) * 0.42 * uSunPower;
    col += uSunColor * pow(sun, 22.0) * 0.18 * uSunPower;

    // Slow high cirrus, projected onto a plane so it stretches towards the
    // horizon like real high cloud instead of following the sphere. One noise
    // fbm plus a streak term keeps the full-screen shader cheap on integrated
    // GPUs while still reading as weather rather than a flat gradient.
    float day = smoothstep(0.02, 0.4, uSunPower);
    if (day > 0.001 && d.y > 0.005) {
      vec2 p = d.xz / (d.y + 0.22);
      p = p * 0.62 + vec2(uTime * 0.0035, uTime * 0.0012);
      float n = fbm(p * 1.7);
      float streak = 0.5 + 0.5 * sin(p.y * 7.5 + n * 7.0);
      float cloud = smoothstep(0.46, 0.8, n * 0.78 + streak * 0.28);
      cloud *= smoothstep(0.01, 0.2, d.y) * smoothstep(1.0, 0.3, d.y);
      vec3 cloudCol = mix(uHaze, uSunColor, 0.5) * (0.95 + 0.6 * sun);
      col = mix(col, cloudCol, cloud * 0.3 * day);
    }

    // Twilight only: a magenta veil above the horizon keeps dusk from reading
    // as a single saturated orange block.
    float twilight =
      smoothstep(0.02, 0.14, uSunPower) * (1.0 - smoothstep(0.16, 0.42, uSunPower));
    col += vec3(0.42, 0.12, 0.26) * pow(1.0 - clamp(abs(d.y), 0.0, 1.0), 9.0) * 0.22 * twilight;

    float moon = max(dot(d, normalize(uMoonDir)), 0.0);
    col += vec3(0.86, 0.92, 1.0) * pow(moon, 5200.0) * 2.4 * (1.0 - uSunPower);
    col += vec3(0.5, 0.62, 0.9) * pow(moon, 90.0) * 0.05 * (1.0 - uSunPower);

    if (uStars > 0.01 && d.y > 0.0) {
      vec3 g = floor(d * 460.0);
      float h = hash(g);
      float twinkle = 0.55 + 0.45 * sin(h * 71.0);
      float s = smoothstep(0.9975, 1.0, h) * twinkle;
      // Stars must vanish while there is still daylight in the sky.
      float dark = 1.0 - smoothstep(0.0, 0.12, uSunPower);
      col += vec3(0.82, 0.89, 1.0) * s * 2.4 * uStars * dark * smoothstep(0.0, 0.12, d.y);
    }
    // Dither the smooth gradients so 8-bit output does not band.
    col += (hash2(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(col, 1.0);
    // The sky bypasses tone mapping, but it still has to land in the same
    // output colour space as the ground; without this encode the dome renders
    // linear values and the horizon sits noticeably darker than the haze the
    // terrain fades into.
    #include <colorspace_fragment>
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
      uTime: { value: 0 },
      uSkyPow: { value: preset.skyPow },
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
    uniforms.uSkyPow.value = preset.skyPow;
  }, [uniforms, preset]);

  // The dome has to follow the camera, otherwise the target tracking shot (which
  // rides tens of kilometres or more from the missile) ends up outside the shell
  // and the sky drops out behind the airframe.
  useFrame(({ camera, clock }) => {
    if (dome.current) dome.current.position.copy(camera.position);
    uniforms.uTime.value = clock.elapsedTime;
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
      {/* Cool kicker from behind the vehicle: separates the airframe from the
          sky and gives the paint a crisp edge the sun alone cannot. */}
      <directionalLight
        position={[
          -preset.sunDir.x * 400,
          Math.abs(preset.sunDir.y) * 260 + 140,
          -preset.sunDir.z * 400,
        ]}
        color={timeOfDay === "night" ? "#7fa6ff" : "#a8d4ff"}
        intensity={timeOfDay === "night" ? 0.9 : timeOfDay === "dusk" ? 0.55 : 0.7}
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
      intensity={timeOfDay === "night" ? 0.55 : timeOfDay === "dusk" ? 0.2 : 0.18}
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

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.55;
    for (int i = 0; i < 3; i++) {
      v += a * vnoise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunDir);
    float sunPower = max(L.y, 0.0);
    // Planar projection across the visible cap avoids the extreme stretching a
    // lat/long map shows when a 2D terrain tile is wrapped onto the globe.
    vec2 uvFar = vWorld.xz / 520000.0 + uFarOffset;
    vec3 baseFar = texture2D(uTerrain, uvFar).rgb;
    // The procedural far layer is a low-contrast backdrop, not a map: pull it
    // towards the haze so the horizon reads as atmosphere instead of a band of
    // bright land sitting on the sea.
    baseFar = mix(baseFar, uFog, 0.62);

    // Live satellite tiles, recentred on the recorded position. Both layers
    // scroll with the vehicle; the tile layer takes over close to the nadir.
    vec2 uvNear = vWorld.xz / uSpan + uOrigin;
    vec3 baseNear = texture2D(uMap, uvNear).rgb;
    float r = length(vWorld.xz);
    // Hand over to the procedural layer inside the tile block: sampling past
    // the block edge clamps to the border texels and smears into streaks.
    float blockR = uSpan * 0.5;
    float blend = (1.0 - smoothstep(blockR * 0.6, blockR * 0.95, r)) * uHasMap;
    vec3 base = mix(baseFar, baseNear, blend);

    // Surface detail below the imagery resolution: a kilometre-scale tonal
    // drift plus a finer grain. Without this a 30 km-altitude view reads as a
    // smooth decal. Both octaves fade out with distance so they never alias.
    float dist = length(vWorld - cameraPosition);
    float nearFade = 1.0 - smoothstep(35000.0, 150000.0, dist);
    if (nearFade > 0.002) {
      float d1 = fbm2(vWorld.xz * 0.00085);
      float d2 = vnoise(vWorld.xz * 0.0042);
      float grain = (d1 - 0.5) * 0.26 + (d2 - 0.5) * 0.12;
      base *= 1.0 + grain * nearFade * blend;
    }

    float dl = max(dot(N, L), 0.0);
    // Sunlight is gone at night, so lift the ambient term instead of letting
    // the whole globe collapse to black.
    float amb = mix(0.26, 0.62, uNight);
    vec3 col = base * uTint * (amb + 0.9 * dl) * uSunColor;

    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col += vec3(0.33, 0.58, 0.86) * fres * 0.22 * (1.0 - uNight * 0.85);

    // Sun glitter on open water: the imagery is bluish there, so a tight
    // half-vector highlight lifts the sea without turning land into plastic.
    float water = smoothstep(0.045, 0.16, base.b - base.r);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 140.0);
    float sparkle = 0.55 + 0.65 * base.g;
    col += uSunColor * spec * water * sparkle * 0.9 * (1.0 - uNight) * sunPower;

    // Warm scattering towards the low sun so the far ground melts into the
    // horizon glow instead of ending on a hard tonal step.
    float toSun = max(dot(V, L), 0.0);
    float far = smoothstep(60000.0, 520000.0, length(vWorld - cameraPosition));
    col += uSunColor * pow(toSun, 7.0) * far * 0.14 * sunPower;

    // Aerial perspective: at altitude the ground fades into the same haze the
    // sky dome uses, starting well before the geometric horizon so the tile
    // block boundary is never visible as a tonal step.
    col = mix(col, uFog, smoothstep(70000.0, 320000.0, dist));
    col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
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
  const map = useMemo(() => new MapTileTexture(2048, 8, 10), []);
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
