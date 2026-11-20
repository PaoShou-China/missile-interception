import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { EARTH_A_KM, EARTH_B_KM, SUN_DIR, ASSET_BASE, COLORS } from "./constants";
import { useAppStore } from "../state/store";

/** WGS84 ellipsoid with the source day texture; poles aligned to ECEF +Z. */
function EarthSurface() {
  const quality = useAppStore((s) => s.quality);
  const texture = useTexture(`${ASSET_BASE}earth_day_2048.jpg`);
  const clouds = useTexture(`${ASSET_BASE}earth_clouds_1024.png`);
  const segments = quality === "low" ? [64, 48] : quality === "medium" ? [96, 72] : [160, 112];

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
    clouds.anisotropy = 4;
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
          opacity={0.22}
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
function Atmosphere() {
  const shell = useRef<THREE.Group>(null);
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: new THREE.Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z) },
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

  // From inside the shell the additive back faces would wash the whole frame;
  // the limb effect is only meaningful when viewed from outside the atmosphere.
  useFrame(({ camera }) => {
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
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
          uniforms={{
            uSun: { value: new THREE.Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z) },
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

export function SpaceEnvironment() {
  // Keep the light following the camera-independent sun direction.
  const sunPos = useMemo(() => {
    const d = 90000;
    return [SUN_DIR.x * d, SUN_DIR.y * d, SUN_DIR.z * d] as [number, number, number];
  }, []);

  return (
    <>
      <color attach="background" args={[COLORS.space]} />
      <ambientLight intensity={0.24} />
      <hemisphereLight args={["#7fb2ff", "#0a0f1c", 0.22]} />
      <directionalLight position={sunPos} intensity={3.0} color="#fff4e0" />
      <StarField />
      <EarthSurface />
      <Atmosphere />
    </>
  );
}
