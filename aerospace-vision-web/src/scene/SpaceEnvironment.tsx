import { useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { EARTH_A_KM, EARTH_B_KM, ASSET_BASE, COLORS } from "./constants";
import { simClock, useAppStore } from "../state/store";
import { skyStateAt } from "../scientific/astronomy";

/** WGS84 ellipsoid with the source day texture; poles aligned to ECEF +Z. */
function EarthSurface() {
  const quality = useAppStore((s) => s.quality);
  const { gl } = useThree();
  // Fall back to the 2K map on GPUs whose maximum texture size cannot hold 8K.
  const high = quality === "high" && gl.capabilities.maxTextureSize >= 8192;
  const texture = useTexture(`${ASSET_BASE}${high ? "earth_day_8k.jpg" : "earth_day_2048.jpg"}`);
  const clouds = useTexture(`${ASSET_BASE}${high ? "earth_clouds_4k.jpg" : "earth_clouds_1024.png"}`);
  const segments = quality === "low" ? [64, 48] : quality === "medium" ? [96, 72] : [192, 128];

  const geometry = useMemo(() => {
    const g = new THREE.SphereGeometry(1, segments[0], segments[1]);
    // Three's sphere poles are +Y; rotate so the north pole is ECEF +Z.
    g.rotateX(Math.PI / 2);
    return g;
  }, [segments]);

  useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.wrapS = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    clouds.anisotropy = 8;
    clouds.needsUpdate = true;
  }, [texture, clouds]);

  return (
    <>
      <mesh geometry={geometry} scale={[EARTH_A_KM, EARTH_A_KM, EARTH_B_KM]}>
        <meshStandardMaterial
          map={texture}
          roughness={0.95}
          metalness={0.01}
          emissiveMap={texture}
          emissive={new THREE.Color("#0a1626")}
          emissiveIntensity={0.1}
        />
      </mesh>
      <mesh geometry={geometry} scale={[EARTH_A_KM * 1.0022, EARTH_A_KM * 1.0022, EARTH_B_KM * 1.0026]}>
        <meshStandardMaterial
          alphaMap={clouds}
          color="#dbe8f6"
          transparent
          opacity={high ? 0.34 : 0.22}
          roughness={1}
          metalness={0}
          depthWrite={false}
        />
      </mesh>
    </>
  );
}

/**
 * Two-layer atmospheric shell: a thin fresnel rim plus a wide outer glow.
 * Additive blending keeps the limb bright without occluding the surface.
 */
function Atmosphere({ sunDir }: { sunDir: RefObject<THREE.Vector3> }) {
  const shell = useRef<THREE.Group>(null);
  const wide = useRef<THREE.ShaderMaterial>(null);

  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: new THREE.Vector3(0, 0, 1) },
      uDay: { value: new THREE.Color("#8fc8ff") },
      uNight: { value: new THREE.Color("#0a1c3d") },
      uIntensity: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      uniform vec3 uDay;
      uniform vec3 uNight;
      uniform float uIntensity;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float rim = pow(1.0 - abs(dot(normalize(vWorldNormal), viewDir)), 1.6);
        float sunDot = dot(normalize(vWorldPos), normalize(uSun));
        float day = smoothstep(-0.32, 0.6, sunDot);
        vec3 col = mix(uNight, uDay, day);
        float alpha = rim * (0.08 + 0.42 * day) * uIntensity;
        gl_FragColor = vec4(col * (0.7 + 0.6 * day), alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
  }), []);

  useFrame(({ camera }) => {
    const dir = sunDir.current;
    if (dir) {
      material.uniforms.uSun.value.copy(dir);
      if (wide.current) wide.current.uniforms.uSun.value.copy(dir);
    }
    // From inside the shell the additive back faces would wash the whole frame;
    // the limb effect is only meaningful when viewed from outside the atmosphere.
    if (shell.current) {
      shell.current.visible = camera.position.length() > EARTH_A_KM * 1.016;
    }
  });

  return (
    <group ref={shell}>
      <mesh scale={EARTH_A_KM * 1.022}>
        <sphereGeometry args={[1, 96, 72]} />
        <primitive object={material} attach="material" />
      </mesh>
      <mesh scale={EARTH_A_KM * 1.062}>
        <sphereGeometry args={[1, 64, 48]} />
        <shaderMaterial
          ref={wide}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
          uniforms={{
            uSun: { value: new THREE.Vector3(0, 0, 1) },
          }}
          vertexShader={/* glsl */ `
            varying vec3 vWorldNormal;
            varying vec3 vWorldPos;
            void main() {
              vec4 wp = modelMatrix * vec4(position, 1.0);
              vWorldPos = wp.xyz;
              vWorldNormal = normalize(mat3(modelMatrix) * normal);
              gl_Position = projectionMatrix * viewMatrix * wp;
            }
          `}
          fragmentShader={/* glsl */ `
            uniform vec3 uSun;
            varying vec3 vWorldNormal;
            varying vec3 vWorldPos;
            void main() {
              vec3 viewDir = normalize(cameraPosition - vWorldPos);
              float rim = pow(1.0 - abs(dot(normalize(vWorldNormal), viewDir)), 3.2);
              float day = smoothstep(-0.5, 0.6, dot(normalize(vWorldPos), normalize(uSun)));
              vec3 col = mix(vec3(0.03, 0.10, 0.28), vec3(0.28, 0.62, 1.0), day);
              gl_FragColor = vec4(col, rim * 0.13 * (0.2 + day));
            }
          `}
        />
      </mesh>
    </group>
  );
}

/** Procedural deep-space star field on a far shell. */
function StarField() {
  const quality = useAppStore((s) => s.quality);
  const points = useRef<THREE.Points>(null);
  const count = quality === "low" ? 1800 : quality === "medium" ? 4200 : 9000;
  useFrame((_, dt) => {
    if (points.current) points.current.rotation.z += dt * 0.002;
  });
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    let seed = 20261120;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const u = rnd() * 2 - 1;
      const phi = rnd() * Math.PI * 2;
      const r = 120000;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(phi);
      pos[i * 3 + 1] = r * s * Math.sin(phi);
      pos[i * 3 + 2] = r * u;
      const temp = rnd();
      const c = temp < 0.15
        ? new THREE.Color("#a9c4ff")
        : temp < 0.3
          ? new THREE.Color("#ffe6c2")
          : new THREE.Color("#ffffff");
      const b = 0.55 + rnd() * 0.45;
      col[i * 3] = c.r * b;
      col[i * 3 + 1] = c.g * b;
      col[i * 3 + 2] = c.b * b;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [count]);

  return (
    <points ref={points} geometry={geometry}>
      <pointsMaterial size={1.5} sizeAttenuation={false} vertexColors transparent opacity={0.9} />
    </points>
  );
}

/**
 * Sun, moon and the moving directional light. Everything is driven by the
 * declared demo UTC plus elapsed simulation time; no data is modified.
 */
function Astronomy({ sunDir }: { sunDir: RefObject<THREE.Vector3> }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const sunRef = useRef<THREE.Group>(null);
  const moonRef = useRef<THREE.Group>(null);
  const acc = useRef(0);

  useFrame((_, dt) => {
    const rt = useAppStore.getState().runtime;
    const demo = rt?.manifest.time.demoUtc ?? "2026-11-20T02:00:00Z";
    const site = rt?.manifest.launchSite ?? { latDeg: 40, lonDeg: 110 };
    acc.current += dt;
    if (acc.current < 0.25) return;
    acc.current = 0;
    const sky = skyStateAt(demo, simClock.time, site);
    sunDir.current?.set(sky.sun.x, sky.sun.y, sky.sun.z);
    const D = 90000;
    const sunPos = new THREE.Vector3(sky.sun.x * D, sky.sun.y * D, sky.sun.z * D);
    if (light.current) light.current.position.copy(sunPos);
    if (sunRef.current) sunRef.current.position.copy(sunPos);
    if (moonRef.current) {
      moonRef.current.position.set(sky.moon.x * 52000, sky.moon.y * 52000, sky.moon.z * 52000);
    }
  });

  return (
    <>
      <directionalLight ref={light} position={[90000, 0, 0]} intensity={3.0} color="#fff4e0" />
      <group ref={sunRef}>
        <mesh>
          <sphereGeometry args={[700, 16, 12]} />
          <meshBasicMaterial color="#fff6d8" />
        </mesh>
        <mesh scale={2.2}>
          <sphereGeometry args={[700, 16, 12]} />
          <meshBasicMaterial color="#ffd98a" transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <mesh scale={4.5}>
          <sphereGeometry args={[700, 16, 12]} />
          <meshBasicMaterial color="#ffbe5c" transparent opacity={0.06} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      </group>
      <group ref={moonRef}>
        {/* Symbolic size and distance; direction is computed from the demo epoch. */}
        <mesh>
          <sphereGeometry args={[420, 24, 16]} />
          <meshStandardMaterial color="#c9d3de" roughness={1} metalness={0} />
        </mesh>
        <mesh scale={1.012}>
          <sphereGeometry args={[420, 24, 16]} />
          <meshBasicMaterial color="#8fa6bd" transparent opacity={0.12} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      </group>
    </>
  );
}

export function SpaceEnvironment() {
  const sunDir = useRef(new THREE.Vector3(1, 0, 0).normalize());

  return (
    <>
      <color attach="background" args={[COLORS.space]} />
      <ambientLight intensity={0.2} />
      <hemisphereLight args={["#7fb2ff", "#0a0f1c", 0.2]} />
      <Astronomy sunDir={sunDir} />
      <StarField />
      <EarthSurface />
      <Atmosphere sunDir={sunDir} />
    </>
  );
}
