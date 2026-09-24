/**
 * Dev-only stand-in for the real RenderPipeline (written by another module) plus a simple
 * daylight test stage (sky, sun with shadows, hemisphere light, asphalt pad).
 */
import * as THREE from 'three';
import { QUALITY_PRESETS, type RenderPipeline, type ResolvedQuality, type Viewport } from '../render/contracts.js';

export function createStandInPipeline(container: HTMLElement, level: ResolvedQuality): RenderPipeline {
  const quality = QUALITY_PRESETS[level];
  const renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  let fps = 60;
  return {
    renderer, canvas, quality,
    setQuality() { /* dev stand-in */ },
    applyEnvironment() { /* showroom lights itself */ },
    setShadowFocus() { /* n/a */ },
    resize() {
      const w = container.clientWidth || window.innerWidth, h = container.clientHeight || window.innerHeight;
      if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      return { width: w, height: h };
    },
    render(scene: THREE.Scene, views: ReadonlyArray<{ camera: THREE.PerspectiveCamera; viewport: Viewport }>, dt: number) {
      renderer.info.reset();
      for (const v of views) {
        const h = container.clientHeight || window.innerHeight;
        renderer.setViewport(v.viewport.x, h - v.viewport.y - v.viewport.h, v.viewport.w, v.viewport.h);
        renderer.render(scene, v.camera);
      }
      if (dt > 0) fps = fps * 0.9 + (1 / dt) * 0.1;
    },
    get fps() { return fps; },
    dispose() { renderer.dispose(); canvas.remove(); },
  };
}

/** Daylight test stage roughly matching the meadow environment the scenery module produces. */
export function buildTestStage(scene: THREE.Scene, shadows: boolean): { sun: THREE.DirectionalLight } {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(400, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color('#3f8fe8') }, hor: { value: new THREE.Color('#bfe3ff') } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 hor; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y, 0.0, 1.0); gl_FragColor = vec4(mix(hor, top, pow(h, 0.6)), 1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
    }),
  );
  scene.add(sky);
  scene.fog = new THREE.Fog('#cfe8ff', 60, 220);
  const hemi = new THREE.HemisphereLight('#cfe8ff', '#5fbf4a', 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff4e0', 2.6);
  sun.position.set(12, 22, 9);
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 80;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  // ground: grass + asphalt pad with lane lines
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#5fbf4a', roughness: 0.95 }));
  grass.position.y = -0.02;
  grass.receiveShadow = true;
  scene.add(grass);
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4a4d57'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 3000; i++) { g.fillStyle = Math.random() > 0.5 ? '#555964' : '#42454e'; g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2); }
  g.fillStyle = '#f4f4f0';
  for (let i = 0; i < 8; i++) g.fillRect(250, i * 64 + 8, 12, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  road.receiveShadow = true;
  scene.add(road);
  return { sun };
}
