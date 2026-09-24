/**
 * Render module contracts (three.js r186). Each file under src/client/render
 * implements one of these; src/client/game/ glues them together.
 */
import type * as THREE from 'three';
import type { BuiltTrack, CharacterId, HeldItem, KartState, ProjectileKind, ThemeId } from '../../sim/types.js';

// ───────────────────────────── Quality ─────────────────────────────

export type ResolvedQuality = 'low' | 'medium' | 'high';

export interface RenderQuality {
  level: ResolvedQuality;
  shadows: boolean;
  shadowMapSize: number;     // 1024 / 2048 / 4096
  maxPixelRatio: number;     // 1 / 1.5 / 2
  bloom: boolean;
  /** Multiplier for particle counts (0.35 / 0.7 / 1). */
  particles: number;
  /** Multiplier for scenery instance counts (0.4 / 0.75 / 1). */
  scenery: number;
  /** Far plane / fog distance multiplier (0.7 / 0.85 / 1). */
  drawDistance: number;
  antialias: boolean;
}

export const QUALITY_PRESETS: Record<ResolvedQuality, RenderQuality> = {
  low: { level: 'low', shadows: false, shadowMapSize: 1024, maxPixelRatio: 1, bloom: false, particles: 0.35, scenery: 0.4, drawDistance: 0.7, antialias: false },
  medium: { level: 'medium', shadows: true, shadowMapSize: 2048, maxPixelRatio: 1.5, bloom: false, particles: 0.7, scenery: 0.75, drawDistance: 0.85, antialias: true },
  high: { level: 'high', shadows: true, shadowMapSize: 4096, maxPixelRatio: 2, bloom: true, particles: 1, scenery: 1, drawDistance: 1, antialias: true },
};

// ───────────────────────────── Environment ─────────────────────────────

/** Lighting/atmosphere for a scene. Produced by the theme's scenery module. */
export interface EnvironmentSettings {
  skyTop: string; skyHorizon: string; skyBottom: string;
  fogColor: string; fogNear: number; fogFar: number;
  sunColor: string; sunIntensity: number;
  /** Direction TOWARD the sun (unit-ish), world space. */
  sunDir: [number, number, number];
  hemiSky: string; hemiGround: string; hemiIntensity: number;
  exposure: number;
  night: boolean;
  /** Bloom strength when bloom is enabled (0.2 day … 1.1 neon night). */
  bloomStrength: number;
}

// ───────────────────────────── Track mesh (render/track-mesh.ts) ─────────────────────────────

export interface TrackMeshHandle {
  /** Road ribbon, shoulders, curbs, barriers, ramps, boost pads, start gantry, pit visuals. */
  readonly group: THREE.Group;
  /** Animate boost pad arrows, start lights, neon strips etc. */
  update(dt: number, time: number): void;
  dispose(): void;
}
// export function buildTrackMesh(track: BuiltTrack, theme: ThemeId, quality: RenderQuality): TrackMeshHandle

// ───────────────────────────── Scenery (render/themes/*.ts) ─────────────────────────────

export interface SceneryContext {
  scene: THREE.Scene;
  track: BuiltTrack;
  quality: RenderQuality;
  renderer: THREE.WebGLRenderer;
}

export interface SceneryHandle {
  readonly environment: EnvironmentSettings;
  /** Called every frame (animated props: windmills, waves, neon flicker, lava glow, stars…). */
  update(dt: number, time: number, camera: THREE.Camera): void;
  /** Visual for a MoverDef.look (e.g. 'sheep', 'crab', 'boulder', 'car', 'snowball', 'log', 'meteor'). Must return something for unknown looks. */
  createMover(look: string): THREE.Object3D;
  dispose(): void;
}

/** Each theme module exports: `export function buildScenery(ctx: SceneryContext): SceneryHandle` */
export type SceneryBuilder = (ctx: SceneryContext) => SceneryHandle;
// render/themes/index.ts exports: getSceneryBuilder(theme: ThemeId): SceneryBuilder

// ───────────────────────────── Karts (render/kart-model.ts) ─────────────────────────────

export interface KartPose { x: number; y: number; z: number; yaw: number }

export interface KartVisualOptions {
  /** Driver looks over the shoulder (look-back input). */
  lookBack: boolean;
  /** Throttle pressed (engine shake / exhaust puff). */
  throttle: boolean;
  /** Seconds since race start (for idle animations). */
  time: number;
  /** Ghost rendering (translucent, no shadows). */
  ghost?: boolean;
}

export interface KartVisual {
  readonly root: THREE.Object3D;
  readonly charId: CharacterId;
  /** Apply interpolated pose + all state-driven animation (wheels, steering, lean, drift sparks, boost
   *  flames, spin/tumble/squash/trick, star rainbow, shrink, invulnerability blink, autopilot rocket,
   *  respawn drone, held/orbiting items). */
  update(k: KartState, pose: KartPose, dt: number, opts: KartVisualOptions): void;
  /** World position for the chase camera to look at (roughly the driver's head). */
  focus(out: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}
// export function createKartVisual(charId: CharacterId, quality: RenderQuality): KartVisual

// ───────────────────────────── Items & pickups (render/item-models.ts) ─────────────────────────────

export interface PickupVisuals {
  readonly group: THREE.Group;
  /** Sync item boxes / coins (active flags) with the world every frame; handles spin/bob and respawn pop-in. */
  update(
    boxes: ReadonlyArray<{ x: number; y: number; z: number; active: boolean }>,
    coins: ReadonlyArray<{ x: number; y: number; z: number; active: boolean }>,
    dt: number, time: number,
  ): void;
  dispose(): void;
}
// export function createPickupVisuals(boxCount: number, coinCount: number, quality: RenderQuality): PickupVisuals

export interface ProjectileVisuals {
  readonly group: THREE.Group;
  /** Sync with world.projectiles (by id): create, move (interpolation handled by caller via positions), animate, remove. */
  update(projectiles: ReadonlyArray<{ id: number; kind: ProjectileKind; x: number; y: number; z: number; vx: number; vz: number; state: string }>, dt: number, time: number): void;
  dispose(): void;
}
// export function createProjectileVisuals(quality: RenderQuality): ProjectileVisuals
// export function createHeldItemMesh(kind: HeldItem['kind']): THREE.Object3D   (used by kart-model for shields)

// ───────────────────────────── Effects (render/particles.ts, render/camera.ts, render/renderer.ts) ─────────────────────────────

export type ParticleKind =
  | 'driftSpark' | 'boostFlame' | 'dust' | 'grassBits' | 'snowPuff' | 'splash'
  | 'smoke' | 'wallSpark' | 'explosion' | 'itemBoxBurst' | 'coinSparkle'
  | 'confetti' | 'starTrail' | 'shrinkPoof' | 'inkSplat' | 'landingDust' | 'lavaEmber';

export interface ParticleSystem {
  readonly object: THREE.Object3D;
  emit(kind: ParticleKind, x: number, y: number, z: number, opts?: { count?: number; color?: string; dirX?: number; dirY?: number; dirZ?: number; scale?: number }): void;
  update(dt: number, camera: THREE.Camera): void;
  clear(): void;
  dispose(): void;
}
// export function createParticleSystem(quality: RenderQuality): ParticleSystem

export interface ChaseCameraInput {
  pose: KartPose;
  focus: THREE.Vector3;
  speed: number;           // m/s signed
  maxSpeed: number;
  boosting: boolean;
  driftAngle: number;
  airborne: boolean;
  lookBack: boolean;
  distance: 'near' | 'normal' | 'far';
}

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  setAspect(aspect: number): void;
  /** Race chase camera (smooth spring follow, FOV kick on boost, drift swing, look-back, terrain clearance). */
  follow(input: ChaseCameraInput, dt: number, track: BuiltTrack): void;
  /** Pre-race flyover along the track ending behind the player's grid slot. t in [0,1]. */
  intro(track: BuiltTrack, endPose: KartPose, t: number, distance?: 'near' | 'normal' | 'far'): void;
  /** Slow orbit around a kart after finishing. */
  orbit(focus: THREE.Vector3, dt: number): void;
  shake(strength: number): void;
  /** Snap without smoothing on the next follow() call. */
  reset(): void;
}
// export function createCameraRig(): CameraRig

export interface Viewport { x: number; y: number; w: number; h: number }

export interface RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly quality: RenderQuality;
  /** 'auto' adapts resolution/quality to hold ~60 fps. */
  setQuality(q: 'auto' | ResolvedQuality): void;
  /** Apply scene environment: creates/updates the gradient sky dome, fog, sun (DirectionalLight with
   *  shadows) + hemisphere light, tone mapping exposure and bloom strength. Idempotent per scene. */
  applyEnvironment(scene: THREE.Scene, env: EnvironmentSettings): void;
  /** Keep the shadow camera centred on the action (call each frame with the player's position). */
  setShadowFocus(x: number, y: number, z: number): void;
  /** Resize to the container; returns CSS pixel size. */
  resize(): { width: number; height: number };
  /** Render one or two viewports (split screen). Each viewport gets its own camera. Viewports in CSS px, origin top-left. */
  render(scene: THREE.Scene, views: ReadonlyArray<{ camera: THREE.PerspectiveCamera; viewport: Viewport; speedLines: number; inkAmount: number }>, dt: number): void;
  /** Frame-time feedback for the auto quality governor. */
  readonly fps: number;
  dispose(): void;
}
// export function createRenderPipeline(container: HTMLElement, quality: 'auto' | ResolvedQuality): RenderPipeline

// ───────────────────────────── Showroom (render/showroom.ts) ─────────────────────────────

export interface Showroom {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** 'title': several karts parading on a stylised stage; 'garage': one kart on a turntable; 'podium': top three on a podium with confetti & fireworks. */
  show(mode: 'title' | 'garage' | 'podium', chars: CharacterId[]): void;
  update(dt: number, time: number): void;
  setAspect(aspect: number): void;
  dispose(): void;
}
// export function createShowroom(pipeline: RenderPipeline): Showroom
