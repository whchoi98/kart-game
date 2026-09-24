/**
 * Post-processing helpers for the render pipeline.
 *
 *  - ViewOverlay: per-view state for the screen-space overlays (speed lines, ink splats).
 *  - OverlayPass: draws the overlays as one premultiplied full-viewport triangle on top of a
 *    scene that was rendered straight to the canvas (no-bloom path).
 *  - BloomChain: scene → HDR (MSAA) render target → UnrealBloomPass → composite pass that
 *    applies ACES tone mapping + sRGB + overlays into the view's viewport on the canvas.
 *    One chain per split-screen view, each sized to its own viewport, so bloom is correct in
 *    split screen.
 *
 * Overlays are evaluated in display (sRGB) space after tone mapping in both paths, so they look
 * identical with and without bloom.
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export const MAX_INK_BLOBS = 16;

// ───────────────────────────── GLSL ─────────────────────────────

const OVERLAY_GLSL = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uInk;
uniform float uInkAge;
uniform float uAspect;
uniform float uPx;
uniform float uLineGain;
uniform vec4 uBlobs[${MAX_INK_BLOBS}];

float ovHash(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

// Radial streaks rushing outward from the centre. Premultiplied white.
// Kept to the outer frame (the kart and the road ahead stay clean) and dimmed at night, where
// pure white streaks on a dark sky read as harsh scratches.
vec4 speedLines(vec2 uv) {
  if (uSpeed <= 0.001) return vec4(0.0);
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  float ang = atan(p.y, p.x);
  float a = (ang / 6.2831853 + 0.5) * 96.0;
  float id = floor(a);
  float f = fract(a) - 0.5;
  float h1 = ovHash(id * 1.31 + 0.7);
  float h2 = ovHash(id * 3.77 + 1.9);
  float h3 = ovHash(id * 7.13 + 4.1);
  float ph = fract(uTime * (0.9 + 1.1 * h2) + h1);
  float head = mix(0.24, 1.7, ph);
  float len = 0.12 + 0.3 * h3;
  // bright head, long soft tail
  float seg = smoothstep(head - len, head - len * 0.2, r) * (1.0 - smoothstep(head - 0.012, head, r));
  float cellPx = 6.2831853 * r / 96.0 / uPx;           // ray cell width in pixels at this radius
  float w = (0.05 + 0.1 * h3) * mix(1.0, 0.6, smoothstep(0.45, 1.0, r));   // fraction of the cell
  float aa = 0.6 / max(cellPx, 0.5);
  float line = 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(f));
  float active = step(h1, 0.08 + 0.64 * uSpeed);
  float mask = smoothstep(0.3, 0.7, r);
  float s = line * seg * mask * active * uSpeed * uSpeed * 0.5 * uLineGain;
  // soft cool rim glow for a sense of rushing air
  float rim = smoothstep(0.5, 1.15, r) * uSpeed * uSpeed * 0.13 * uLineGain;
  vec3 c = vec3(1.0) * s + vec3(0.78, 0.9, 1.0) * rim;
  return vec4(c, clamp(s + rim, 0.0, 1.0));
}

// Glossy dark-purple metaball ink with dripping runs. Premultiplied.
// Bounded Wyvill-style kernel (1 - d^2/Rk^2)^2: smooth domes, no singular centres.
const float INK_T = 0.37;          // field value at d = R for Rk = 1.6 R
void inkAdd(vec2 d, float Rk, inout float F, inout vec2 G) {
  float ik = 1.0 / (Rk * Rk);
  float q = dot(d, d) * ik;
  if (q < 1.0) {
    float g = 1.0 - q;
    F += g * g;
    G -= 4.0 * g * ik * d;
  }
}
vec4 inkSplat(vec2 uv) {
  if (uInk <= 0.001) return vec4(0.0);
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float grow = 1.0 - exp(-uInkAge * 16.0) * 0.75;
  float scale = grow * mix(0.5, 1.0, smoothstep(0.0, 0.55, uInk));
  float dripT = smoothstep(0.0, 1.0, uInkAge * 0.35);
  float F = 0.0;
  vec2 G = vec2(0.0);
  for (int i = 0; i < ${MAX_INK_BLOBS}; i++) {
    vec4 b = uBlobs[i];
    float R = b.z * scale;
    if (R <= 0.0) continue;
    vec2 d = p - b.xy;
    float fi = float(i);
    float ang = atan(d.y, d.x + 1e-5);
    float wob = 1.0 + 0.07 * sin(ang * 3.0 + fi * 1.7) + 0.035 * sin(ang * 7.0 - fi * 2.3);
    inkAdd(d, 1.6 * R * wob, F, G);
    float L = b.w * dripT;
    if (L > 0.0) {
      vec2 o = d + vec2(0.0, R * 0.35);
      vec2 ba = vec2(0.0, -(R * 0.55 + L));
      float h = clamp(dot(o, ba) / dot(ba, ba), 0.0, 1.0);
      float rd = R * mix(0.36, 0.2, h) * (1.0 + 0.5 * smoothstep(0.82, 1.0, h));
      inkAdd(o - ba * h, 1.6 * rd, F, G);
    }
  }
  float gl = length(G);
  float aaw = max(gl * uPx * 1.1, 1e-4);
  float cover = smoothstep(INK_T - aaw, INK_T + aaw, F);
  if (cover <= 0.0) return vec4(0.0);
  // plateau profile with steep shoulders: gloss forms crescents along the upper-left rims
  float sN = clamp((F - INK_T) / 0.3, 0.0, 1.0);
  float dh = 2.0 * (1.0 - sN) / 0.3;
  vec3 n = normalize(vec3(-G * dh * 0.036, 1.0));
  vec3 L = normalize(vec3(-0.5, 0.62, 0.9));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(n, H), 0.0);
  float spec = pow(nh, 48.0);
  float back = pow(max(dot(n, normalize(vec3(0.55, -0.5, 0.9))), 0.0), 8.0);
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float edge = 1.0 - smoothstep(0.0, 0.22, sN);       // lit rim just inside the outline
  vec3 base = mix(vec3(0.19, 0.065, 0.28), vec3(0.065, 0.02, 0.11), smoothstep(0.1, 0.9, sN));
  vec3 col = base * (0.75 + 0.35 * diff)
           + vec3(0.42, 0.18, 0.6) * edge * 0.35
           + vec3(0.98, 0.93, 1.0) * spec
           + vec3(0.6, 0.32, 0.9) * back * 0.22 * edge;
  float alpha = cover * smoothstep(0.0, 0.18, uInk) * 0.98;
  return vec4(col * alpha, alpha);
}

vec4 overlayColor(vec2 uv) {
  vec4 s = speedLines(uv);
  vec4 k = inkSplat(uv);
  return vec4(s.rgb * (1.0 - k.a) + k.rgb, s.a * (1.0 - k.a) + k.a);
}
`;

const FS_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const OVERLAY_FRAG = /* glsl */ `
precision highp float;
${OVERLAY_GLSL}
varying vec2 vUv;
void main() {
  gl_FragColor = overlayColor(vUv);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
${OVERLAY_GLSL}
varying vec2 vUv;
float dither(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453) - 0.5; }
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  // bloom is added here instead of being blended back into the (MSAA) scene target: saves a
  // full-resolution pass + resolve blit per view and never re-reads a resolved MSAA buffer
  c.rgb += texture2D(tBloom, vUv).rgb;
  c.rgb = ACESFilmicToneMapping(max(c.rgb, vec3(0.0)));
  c = sRGBTransferOETF(vec4(c.rgb, 1.0));
  c.rgb += dither(gl_FragCoord.xy + fract(uTime) * 61.0) / 255.0;
  vec4 o = overlayColor(vUv);
  gl_FragColor = vec4(c.rgb * (1.0 - o.a) + o.rgb, 1.0);
}
`;

// ───────────────────────────── Shared full-screen triangle ─────────────────────────────

function createFullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  return g;
}

function overlayUniforms(): Record<string, THREE.IUniform> {
  return {
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uInk: { value: 0 },
    uInkAge: { value: 0 },
    uAspect: { value: 1 },
    uPx: { value: 1 / 720 },
    uLineGain: { value: 1 },
    uBlobs: { value: new Float32Array(MAX_INK_BLOBS * 4) },
  };
}

// ───────────────────────────── Per-view overlay state ─────────────────────────────

export class ViewOverlay {
  speed = 0;
  ink = 0;
  inkAge = 0;
  time = 0;
  aspect = 16 / 9;
  /** Aspect-space units per device pixel (1 / viewport height in px). */
  px = 1 / 720;
  /** Speed-line brightness (set by the pipeline: 1 by day, lower at night). */
  lineGain = 1;
  readonly blobs = new Float32Array(MAX_INK_BLOBS * 4);
  private prevInk = 0;

  /** Advance animation; re-seeds the ink layout whenever a new splat starts. */
  advance(dt: number, speed: number, ink: number, widthPx: number, heightPx: number): void {
    this.time += dt;
    if (this.time > 1000) this.time -= 1000;
    this.speed = speed < 0 ? 0 : speed > 1 ? 1 : speed;
    const k = ink < 0 ? 0 : ink > 1 ? 1 : ink;
    this.aspect = widthPx / Math.max(1, heightPx);
    this.px = 1 / Math.max(1, heightPx);
    if (k > 0.001 && (this.prevInk <= 0.001 || k > this.prevInk + 0.25)) {
      this.seedInk();
      this.inkAge = 0;
    }
    if (k > 0.001) this.inkAge += dt;
    else this.inkAge = 0;
    this.prevInk = k;
    this.ink = k;
  }

  get active(): boolean { return this.speed > 0.001 || this.ink > 0.001; }

  private seedInk(): void {
    const b = this.blobs;
    const A = this.aspect;
    b.fill(0);
    // 7 big blobs spread over the screen (weighted toward the middle band where it hurts),
    // each with a drip, plus 9 satellite droplets.
    const big = 6;
    for (let i = 0; i < big; i++) {
      const col = (i + 0.5) / big;
      const x = (col - 0.5) * A * 0.9 + (Math.random() - 0.5) * 0.16;
      const y = (Math.random() - 0.5) * 0.5 + (i % 2 === 0 ? 0.1 : -0.06);
      const r = 0.16 + Math.random() * 0.12;
      b[i * 4] = x; b[i * 4 + 1] = y; b[i * 4 + 2] = r;
      b[i * 4 + 3] = Math.random() < 0.75 ? 0.1 + Math.random() * 0.22 : 0;
    }
    for (let i = big; i < MAX_INK_BLOBS; i++) {
      const host = i % big;
      const ang = Math.random() * Math.PI * 2;
      const hr = b[host * 4 + 2]!;
      const dist = hr * (1.25 + Math.random() * 0.6);
      b[i * 4] = b[host * 4]! + Math.cos(ang) * dist;
      b[i * 4 + 1] = b[host * 4 + 1]! + Math.sin(ang) * dist;
      b[i * 4 + 2] = 0.02 + Math.random() * 0.035;
      b[i * 4 + 3] = 0;
    }
  }

  apply(u: Record<string, THREE.IUniform>): void {
    u['uTime']!.value = this.time;
    u['uSpeed']!.value = this.speed;
    u['uInk']!.value = this.ink;
    u['uInkAge']!.value = this.inkAge;
    u['uAspect']!.value = this.aspect;
    u['uPx']!.value = this.px;
    u['uLineGain']!.value = this.lineGain;
    (u['uBlobs']!.value as Float32Array).set(this.blobs);
  }
}

// ───────────────────────────── Overlay pass (no-bloom path) ─────────────────────────────

export class OverlayPass {
  private readonly geometry = createFullscreenTriangle();
  private readonly material: THREE.RawShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.material = new THREE.RawShaderMaterial({
      name: 'ScreenOverlay',
      uniforms: overlayUniforms(),
      vertexShader: FS_VERT,
      fragmentShader: OVERLAY_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  /** Draws into the renderer's current viewport/scissor (canvas target). */
  render(renderer: THREE.WebGLRenderer, view: ViewOverlay): void {
    view.apply(this.material.uniforms);
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.mesh, this.camera);
    renderer.autoClear = auto;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ───────────────────────────── Bloom chain (per view) ─────────────────────────────

export interface BloomParams { strength: number; threshold: number; radius: number; exposure: number }

const BLUR_X = new THREE.Vector2(1, 0);
const BLUR_Y = new THREE.Vector2(0, 1);

export class BloomChain {
  private target: THREE.WebGLRenderTarget;
  private readonly bloom: UnrealBloomPass;
  private readonly geometry = createFullscreenTriangle();
  private readonly composite: THREE.RawShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly savedClear = new THREE.Color();
  private width = 0;
  private height = 0;
  private samples = 0;

  constructor(width: number, height: number, samples: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.samples = samples;
    this.target = this.makeTarget();
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.3, 0.55, 0.85);
    this.composite = new THREE.RawShaderMaterial({
      name: 'BloomComposite',
      uniforms: { ...overlayUniforms(), tDiffuse: { value: null }, tBloom: { value: null }, toneMappingExposure: { value: 1 } },
      vertexShader: FS_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(this.geometry, this.composite);
    this.quad.frustumCulled = false;
  }

  private makeTarget(): THREE.WebGLRenderTarget {
    const t = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.samples,
    });
    t.texture.name = 'pipeline.scene';
    t.texture.generateMipmaps = false;
    return t;
  }

  /** Resize (device pixels). Cheap when unchanged. */
  ensure(width: number, height: number, samples: number): void {
    width = Math.max(1, width);
    height = Math.max(1, height);
    if (samples !== this.samples) {
      this.samples = samples;
      this.width = width;
      this.height = height;
      this.target.dispose();
      this.target = this.makeTarget();
      this.bloom.setSize(width, height);
      return;
    }
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.target.setSize(width, height);
      this.bloom.setSize(width, height);
    }
  }

  /** Render the scene into the HDR target and build the bloom texture. Leaves the canvas bound afterwards. */
  renderScene(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, p: BloomParams): void {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    this.runBloom(renderer, p);
    renderer.setRenderTarget(null);
  }

  /**
   * UnrealBloomPass stages 1–3 (bright pass, 5-mip separable blur, mip composite) driven with the
   * pass's own materials/targets. Its final stage (additive blend back into the scene target) is
   * skipped: the composite shader adds the bloom texture instead.
   */
  private runBloom(renderer: THREE.WebGLRenderer, p: BloomParams): void {
    const b = this.bloom;
    const quad = this.quad;
    const cam = this.camera;
    renderer.getClearColor(this.savedClear);
    const clearA = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);

    const hp = b.highPassUniforms as Record<string, THREE.IUniform>;
    hp['tDiffuse']!.value = this.target.texture;
    hp['luminosityThreshold']!.value = p.threshold;
    quad.material = b.materialHighPassFilter;
    renderer.setRenderTarget(b.renderTargetBright);
    renderer.clear(true, false, false);
    renderer.render(quad, cam);

    let input: THREE.WebGLRenderTarget = b.renderTargetBright;
    for (let i = 0; i < b.nMips; i++) {
      const m = b.separableBlurMaterials[i]!;
      const h = b.renderTargetsHorizontal[i]!, v = b.renderTargetsVertical[i]!;
      quad.material = m;
      m.uniforms['colorTexture']!.value = input.texture;
      m.uniforms['direction']!.value = BLUR_X;
      renderer.setRenderTarget(h);
      renderer.clear(true, false, false);
      renderer.render(quad, cam);
      m.uniforms['colorTexture']!.value = h.texture;
      m.uniforms['direction']!.value = BLUR_Y;
      renderer.setRenderTarget(v);
      renderer.clear(true, false, false);
      renderer.render(quad, cam);
      input = v;
    }

    const cu = b.compositeMaterial.uniforms;
    cu['bloomStrength']!.value = p.strength;
    cu['bloomRadius']!.value = p.radius;
    quad.material = b.compositeMaterial;
    renderer.setRenderTarget(b.renderTargetsHorizontal[0]!);
    renderer.clear(true, false, false);
    renderer.render(quad, cam);

    quad.material = this.composite;
    renderer.setClearColor(this.savedClear, clearA);
    renderer.autoClear = autoClear;
  }

  /** Tone map + overlays into the canvas; caller sets viewport/scissor. */
  compositeTo(renderer: THREE.WebGLRenderer, view: ViewOverlay, exposure: number): void {
    const u = this.composite.uniforms;
    view.apply(u);
    u['tDiffuse']!.value = this.target.texture;
    u['tBloom']!.value = this.bloom.renderTargetsHorizontal[0]!.texture;
    u['toneMappingExposure']!.value = exposure;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quad, this.camera);
    renderer.autoClear = auto;
  }

  dispose(): void {
    this.target.dispose();
    this.bloom.dispose();
    this.geometry.dispose();
    this.composite.dispose();
  }
}
