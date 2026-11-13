import { useBitmapTexture } from "./bitmapTexture";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { DISPLAY_GLSL, STAR_KM } from "./display";

/**
 * The real sky at the site: NASA SVS Deep Star Maps 2020 Milky Way (stars brighter than Tycho's limit removed)
 * plus 25,493 Hipparcos stars (V <= 7.5) drawn as points, both in J2000 and turned into scene axes by the hourly
 * SPICE quaternion (J2000 -> MOON_ME -> local). No atmosphere: stars do not twinkle, the sky stays black by day.
 */

interface SkyProps { quat: THREE.Quaternion; sunDir: [number, number, number] }

/** Keep a sky object centred on the camera so it behaves as if infinitely far. */
function useFollowCamera(ref: React.RefObject<THREE.Object3D | null>) {
  useFrame(({ camera }) => { ref.current?.position.copy(camera.position); });
}

export function MilkyWay({ quat }: { quat: THREE.Quaternion }) {
  const map = useBitmapTexture("/textures/milkyway_4k.jpg");
  const ref = useRef<THREE.Mesh>(null);
  useFollowCamera(ref);
  const material = useMemo(() => {
    map.colorSpace = THREE.NoColorSpace; // decoded in the shader
    map.minFilter = THREE.LinearFilter;  // magnified on screen; no mipmaps, so no seam at RA 0h
    map.generateMipmaps = false;
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uMap: { value: map }, uGain: { value: 0.12 } },
      vertexShader: /* glsl */ `
        out vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uMap;
        uniform float uGain;
        in vec3 vDir;
        out vec4 outColor;
        ${DISPLAY_GLSL}
        const float PI = 3.141592653589793;
        void main() {
          vec3 d = normalize(vDir);                       // J2000 direction
          float ra = atan(d.y, d.x), dec = asin(clamp(d.z, -1.0, 1.0));
          vec2 uv = vec2(fract(0.5 - ra / (2.0 * PI)), 0.5 + dec / PI); // map centre 0h, RA increasing left
          vec3 c = texture(uMap, uv).rgb;
          c = pow(c, vec3(2.2));                          // to linear
          c = max(c - 0.02, 0.0) * uGain;                // black point keeps the vacuum sky black
          outColor = vec4(display(c), 1.0);
        }`,
    });
  }, [map]);
  return (
    <mesh ref={ref} material={material} quaternion={quat} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[STAR_KM * 1.1, 64, 32]} />
    </mesh>
  );
}

export function StarField({ quat, sunDir }: SkyProps) {
  const [geo, setGeo] = useState<THREE.BufferGeometry | null>(null);
  const ref = useRef<THREE.Points>(null);
  useFollowCamera(ref);
  useEffect(() => {
    let live = true;
    fetch("/data/stars.bin").then((r) => r.arrayBuffer()).then((buf) => {
      if (!live) return;
      const n = buf.byteLength / 10, dv = new DataView(buf);
      const pos = new Float32Array(3 * n), col = new Float32Array(3 * n), mag = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = 10 * i;
        for (let k = 0; k < 3; k++) {
          pos[3 * i + k] = (dv.getInt16(o + 2 * k, true) / 32767) * STAR_KM;
          col[3 * i + k] = dv.getUint8(o + 6 + k) / 255;
        }
        mag[i] = dv.getUint8(o + 9) / 20 - 2;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("starColor", new THREE.BufferAttribute(col, 3));
      g.setAttribute("mag", new THREE.BufferAttribute(mag, 1));
      setGeo(g);
    });
    return () => { live = false; };
  }, []);
  const material = useMemo(() => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      in float mag;
      in vec3 starColor;
      uniform vec3 uSunDir;
      uniform float uPx;
      out vec3 vCol;
      out float vI;
      void main() {
        vec3 dir = normalize(mat3(modelMatrix) * position);
        // perceptual magnitude scale: V 1 -> 1, V 3.5 -> 0.28, V 6 -> 0.08
        float I = pow(10.0, -0.4 * 0.55 * (mag - 1.0));
        // the Sun's glare hides stars near it
        I *= 1.0 - 0.95 * smoothstep(0.94, 0.995, dot(dir, uSunDir));
        vI = I;
        vCol = mix(vec3(1.0), starColor, 0.65);
        gl_PointSize = uPx * (1.6 + 3.2 * pow(clamp(I - 0.2, 0.0, 3.0), 0.6));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec3 vCol;
      in float vI;
      out vec4 outColor;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = exp(-r * r * 6.0) + 0.12 * exp(-r * r * 1.5) * smoothstep(0.6, 1.5, vI);
        outColor = vec4(vCol * vI * a * 1.25, 1.0);
      }`,
  }), []);
  useFrame(({ gl }) => { material.uniforms.uPx.value = gl.getPixelRatio(); });
  material.uniforms.uSunDir.value.set(...sunDir);
  return geo ? <points ref={ref} geometry={geo} material={material} quaternion={quat} renderOrder={-900} frustumCulled={false} /> : null;
}
