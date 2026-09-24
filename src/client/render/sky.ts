/**
 * Gradient sky dome.
 *
 * A unit sphere drawn from the inside whose vertex shader strips the view
 * translation and pins depth to the far plane (xyww). It therefore follows
 * every camera automatically (split screen included), never needs a radius
 * tuned to the far plane, and is drawn after the opaque pass so terrain and
 * props early-z reject it. Fog-free by construction; it blends into the fog
 * colour near the horizon so distant geometry melts into the sky.
 *
 * Day: 3-colour gradient + soft sun glow + HDR sun disc (blooms on high).
 * Night: same gradient, a pale moon at sunDir and twinkling procedural stars.
 */
import * as THREE from 'three';
import type { EnvironmentSettings } from './contracts.js';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uFog;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uTime;
varying vec3 vDir;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float starLayer(vec3 d, float density, float threshold, float radius) {
  vec3 cell = floor(d * density);
  float h = hash13(cell);
  if (h < threshold) return 0.0;
  vec3 jitter = hash33(cell + 17.0);
  vec3 c = normalize((cell + 0.25 + jitter * 0.5) / density);
  float dist = length(d - c);
  float tw = 0.65 + 0.35 * sin(uTime * (1.5 + jitter.x * 3.0) + h * 60.0);
  return smoothstep(radius, 0.0, dist) * tw * (0.6 + 0.8 * fract(h * 13.7));
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col;
  if (y >= 0.0) {
    float t = pow(clamp(y, 0.0, 1.0), 0.55);
    col = mix(uHorizon, uTop, smoothstep(0.0, 1.0, t));
  } else {
    col = mix(uHorizon, uBottom, smoothstep(0.0, 0.22, -y));
  }
  // horizon haze: meet the fog colour so far terrain dissolves into the sky
  float haze = exp(-abs(y) * 10.0);
  col = mix(col, uFog, haze * 0.6);

  vec3 sd3 = normalize(uSunDir);
  float sd = max(dot(d, sd3), 0.0);
  float day = 1.0 - uNight;
  // wide soft glow + tighter halo
  float glow = pow(sd, 5.0) * 0.18 + pow(sd, 42.0) * 0.45;
  col += uSunColor * glow * mix(0.35, 1.0, day);
  // sun (day) / moon (night) disc with a soft rim
  float discR = mix(0.99955, 0.99975, uNight);
  float disc = smoothstep(discR - 0.00025, discR + 0.00006, sd);
  vec3 discCol = mix(uSunColor * 7.0, vec3(0.95, 0.97, 1.1) * 2.2, uNight);
  col = mix(col, discCol, disc);

  if (uNight > 0.5 && y > -0.02) {
    float fade = smoothstep(0.03, 0.4, y) * (1.0 - disc);
    float s = starLayer(d, 60.0, 0.988, 0.0032) + starLayer(d, 130.0, 0.992, 0.0018) * 0.6;
    col += vec3(0.9, 0.93, 1.15) * s * fade * 1.1;
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // cheap dither against 8-bit banding in the wide gradient
  gl_FragColor.rgb += (hash13(vec3(gl_FragCoord.xy, uTime)) - 0.5) / 255.0;
}
`;

export interface SkyDome {
  readonly mesh: THREE.Mesh;
  setEnvironment(env: EnvironmentSettings): void;
  update(time: number): void;
  dispose(): void;
}

export function createSkyDome(): SkyDome {
  const geometry = new THREE.SphereGeometry(1, 32, 16);
  const uniforms = {
    uTop: { value: new THREE.Color('#3f8fe8') },
    uHorizon: { value: new THREE.Color('#bfe3ff') },
    uBottom: { value: new THREE.Color('#5fbf4a') },
    uFog: { value: new THREE.Color('#cfe8ff') },
    uSunColor: { value: new THREE.Color('#fff4e0') },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'SkyDome',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    fog: false,
    lights: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky-dome';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  // Opaque but drawn last in the opaque list: only uncovered pixels shade the sky.
  mesh.renderOrder = 1e6;

  return {
    mesh,
    setEnvironment(env) {
      uniforms.uTop.value.set(env.skyTop);
      uniforms.uHorizon.value.set(env.skyHorizon);
      uniforms.uBottom.value.set(env.skyBottom);
      uniforms.uFog.value.set(env.fogColor);
      uniforms.uSunColor.value.set(env.sunColor);
      uniforms.uSunDir.value.set(env.sunDir[0], env.sunDir[1], env.sunDir[2]).normalize();
      uniforms.uNight.value = env.night ? 1 : 0;
    },
    update(time) {
      uniforms.uTime.value = time;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
