/**
 * Camera rig: chase camera (critically damped springs), pre-race flyover, finish orbit, shake.
 *
 * Conventions (src/sim/types.ts): +Y up, yaw 0 faces +Z, forward = (sin yaw, 0, cos yaw).
 * The chase position is rigidly attached to the kart horizontally (no positional lag at speed);
 * only yaw, distance, height and FOV are sprung, so the camera never "falls behind" at 30 m/s.
 */
import * as THREE from 'three';
import { projectToTrack, sampleIndex, surfaceAt, wrapS } from '../../sim/track-query.js';
import type { BuiltTrack } from '../../sim/types.js';
import type { CameraRig, ChaseCameraInput, KartPose } from './contracts.js';

type Distance = ChaseCameraInput['distance'];

const CHASE: Record<Distance, { dist: number; height: number }> = {
  near: { dist: 5.0, height: 2.0 },
  normal: { dist: 6.2, height: 2.2 },
  far: { dist: 7.8, height: 2.6 },
};
const BASE_FOV = 70;
const BOOST_FOV = 82;
const LOOK_AHEAD = 2.5;
const LOOK_UP = 0.55;
/** Estimated driver-head height above the pose (intro only; follow uses input.focus). */
const FOCUS_H = 1.1;
const MIN_CLEARANCE = 1.0;
const WALL_PAD = 0.7;
/** Wall avoidance fades out between these heights above the road (a camera 7 m up can't hit a barrier;
 *  applying it there made the flyover jump sideways by 10+ m wherever the edge kind changed). */
const WALL_FADE_LO = 3, WALL_FADE_HI = 7;
/** Max vertical lag of the chase camera behind its target while airborne (m below / above). */
const AIR_LAG_BELOW = 1.3, AIR_LAG_ABOVE = 2.0;
const YAW_OMEGA = 7.5, YAW_OMEGA_AIR = 4;
/** FOV is authored for 16:9. Wider than this keeps the horizontal FOV (split screen would otherwise be a
 *  fisheye: 70° vertical at 1280x360 is 136° horizontal); narrower opens the vertical FOV a little. */
const WIDE_ASPECT = 2.0, NARROW_ASPECT = 1.3;
const NEAR = 0.25;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Vertical FOV actually used for a given authored (16:9) vertical FOV and viewport aspect. */
export function effectiveFov(fovV: number, aspect: number): number {
  if (!(aspect > 0)) return fovV;
  let t = Math.tan(fovV * DEG * 0.5);
  if (aspect > WIDE_ASPECT) t *= WIDE_ASPECT / aspect;
  else if (aspect < NARROW_ASPECT) t *= Math.min(1.4, Math.sqrt(NARROW_ASPECT / aspect));
  return (2 * Math.atan(t)) / DEG;
}

/**
 * Lens proximity: how far to dissolve / shrink an object whose centre is `dist` m from a camera — 0 at
 * `start` m or more, 1 (gone) at `gone` m or less, smoothstep in between (continuous, so nothing pops).
 */
export function lensFade(dist: number, gone: number, start: number): number {
  if (!(dist < start)) return 0; // (NaN: leave it drawn)
  if (dist <= gone) return 1;
  const t = (start - dist) / (start - gone);
  return t * t * (3 - 2 * t);
}

/** Implicit critically damped spring (stable for any dt). */
class Spring {
  x = 0;
  v = 0;
  step(target: number, omega: number, dt: number): number {
    const f = 1 + 2 * dt * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const detInv = 1 / (f + hhoo);
    const detX = f * this.x + dt * this.v + hhoo * target;
    const detV = this.v + hoo * (target - this.x);
    this.x = detX * detInv;
    this.v = detV * detInv;
    return this.x;
  }
  snap(x: number): void { this.x = x; this.v = 0; }
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Like sim pointAt() but with the (banked) right vector interpolated between samples, so large lateral
 *  offsets move smoothly instead of stepping ~d·κ metres at every 1 m sample. Ramp wedges are left out on
 *  purpose: a flying camera must not copy a kicker's 3 m lip drop. */
function trackPoint(t: BuiltTrack, s: number, d: number, out: THREE.Vector3): THREE.Vector3 {
  const ss = wrapS(t, s);
  const f = ss / t.spacing;
  const i = Math.floor(f) % t.n;
  const j = (i + 1) % t.n;
  const k = f - Math.floor(f);
  const rx = t.rx[i]! + (t.rx[j]! - t.rx[i]!) * k;
  const ry = t.ry[i]! + (t.ry[j]! - t.ry[i]!) * k;
  const rz = t.rz[i]! + (t.rz[j]! - t.rz[i]!) * k;
  return out.set(
    t.px[i]! + (t.px[j]! - t.px[i]!) * k + rx * d,
    t.py[i]! + (t.py[j]! - t.py[i]!) * k + ry * d,
    t.pz[i]! + (t.pz[j]! - t.pz[i]!) * k + rz * d,
  );
}

/** Curvature averaged over ±24 m around s (interpolated, tent-weighted, so it varies smoothly with s). */
function curvAround(t: BuiltTrack, s: number): number {
  let sum = 0, wsum = 0;
  for (let q = -6; q <= 6; q++) {
    const f = wrapS(t, s + q * 4) / t.spacing;
    const i = Math.floor(f) % t.n, j = (i + 1) % t.n, k = f - Math.floor(f);
    const w = 7 - Math.abs(q);
    sum += (t.curvature[i]! + (t.curvature[j]! - t.curvature[i]!) * k) * w;
    wsum += w;
  }
  return sum / wsum;
}

export interface CameraRigExt extends CameraRig {
  /** Current shake trauma 0..1 (debug/preview). */
  readonly trauma: number;
  /** As CameraRig.intro; optional `distance` makes the flyover end on the player's chase distance
   *  (default: the distance last passed to follow()). */
  intro(track: BuiltTrack, endPose: KartPose, t: number, distance?: Distance): void;
}

export function createCameraRig(): CameraRigExt {
  // near 0.25 m (not 0.1): 2.5x the depth precision for the 2.4 km far plane; nothing the rig does
  // brings geometry closer than ~0.45 m (wall pad), and particles fade out before 0.35 m.
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 16 / 9, NEAR, 2400);
  camera.name = 'chase-camera';
  camera.position.set(0, 5, -10);

  const yaw = new Spring();
  const dist = new Spring();
  const camY = new Spring();
  const fov = new Spring();
  fov.snap(BASE_FOV);
  const orbitR = new Spring();
  const orbitH = new Spring();

  let mode: 'none' | 'follow' | 'intro' | 'orbit' = 'none';
  let snapNext = true;
  let lastLookBack = false;
  let hint = -1;
  let lastTrack: BuiltTrack | null = null;
  let trauma = 0;
  let shakeT = 0;
  let lastDistance: Distance = 'normal';
  let introDistance: Distance = 'normal';
  let orbitAngle = 0;
  /** Authored (16:9) vertical FOV; camera.fov is this adapted to the viewport aspect. */
  let logicalFov = BASE_FOV;

  // intro cache
  let introTrack: BuiltTrack | null = null;
  let introX = NaN, introZ = NaN, introS = 0, introSpan = 200, introSide = 1;

  const look = new THREE.Vector3();
  const pos = new THREE.Vector3();

  function setFov(f: number): void {
    logicalFov = f;
    const e = effectiveFov(f, camera.aspect);
    if (Math.abs(camera.fov - e) > 1e-3) {
      camera.fov = e;
      camera.updateProjectionMatrix();
    }
  }

  function useTrack(track: BuiltTrack): void {
    if (track !== lastTrack) { lastTrack = track; hint = -1; }
  }

  /** Keep `pos` inside wall barriers and >= MIN_CLEARANCE above the ground. Returns the ground height. */
  function constrain(track: BuiltTrack, p: THREE.Vector3, roadY: number): number {
    // roadY breaks ties between stacked sections (bridges, spirals) when a global search is needed
    const proj = projectToTrack(track, p.x, p.z, hint, roadY);
    hint = proj.i;
    const i = proj.i;
    let shift = 0;
    if (proj.d > 0 && track.edgeR[i] === 1) {
      const lim = track.wallR[i]! - WALL_PAD;
      if (proj.d > lim) shift = lim - proj.d;
    } else if (proj.d < 0 && track.edgeL[i] === 1) {
      const lim = -(track.wallL[i]! - WALL_PAD);
      if (proj.d < lim) shift = lim - proj.d;
    }
    if (shift !== 0) {
      // only near barrier height: fade out with height above the road (continuous, no sideways pops)
      const above = p.y - proj.h;
      shift *= 1 - smooth(WALL_FADE_LO, WALL_FADE_HI, above);
    }
    if (shift !== 0) {
      const rx = track.rx[i]!, rz = track.rz[i]!;
      const rh = Math.hypot(rx, rz) || 1;
      p.x += (rx / rh) * shift;
      p.z += (rz / rh) * shift;
      proj.d += shift;
      proj.h += track.ry[i]! * shift;
    }
    const surf = surfaceAt(track, proj);
    const ground = Number.isFinite(surf.height) ? surf.height : proj.h;
    if (p.y < ground + MIN_CLEARANCE) p.y = ground + MIN_CLEARANCE;
    return ground;
  }

  function applyShake(dt: number): void {
    if (trauma <= 1e-4) { trauma = 0; return; }
    shakeT += dt;
    if (shakeT > 1000) shakeT -= 1000;
    const a = trauma * trauma;
    const nx = Math.sin(shakeT * 41.3) * 0.5 + Math.sin(shakeT * 23.7 + 1.7) * 0.5;
    const ny = Math.sin(shakeT * 37.9 + 0.5) * 0.5 + Math.sin(shakeT * 19.1 + 2.9) * 0.5;
    const nr = Math.sin(shakeT * 29.3 + 4.1) * 0.6 + Math.sin(shakeT * 13.3) * 0.4;
    camera.translateX(nx * a * 0.3);
    camera.translateY(ny * a * 0.24);
    camera.rotateZ(nr * a * 0.055);
    trauma = Math.max(0, trauma - dt * 1.6);
  }

  const rig: CameraRigExt = {
    camera,
    get trauma() { return trauma; },

    setAspect(aspect: number) {
      if (!(aspect > 0)) return;
      const e = effectiveFov(logicalFov, aspect);
      if (Math.abs(camera.aspect - aspect) > 1e-6 || Math.abs(camera.fov - e) > 1e-3) {
        camera.aspect = aspect;
        camera.fov = e;
        camera.updateProjectionMatrix();
      }
    },

    follow(input: ChaseCameraInput, dt: number, track: BuiltTrack) {
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;
      useTrack(track);
      const p = input.pose;
      const cfg = CHASE[input.distance] ?? CHASE.normal;
      lastDistance = CHASE[input.distance] ? input.distance : 'normal';
      const maxS = input.maxSpeed > 0 ? input.maxSpeed : 30;
      const sf = clamp(Math.abs(input.speed) / maxS, 0, 1.3);
      const distT = cfg.dist * (1 + 0.07 * sf) + (input.boosting ? 0.45 : 0);
      const heightT = cfg.height + 0.12 * sf;
      const fovT = input.boosting ? BOOST_FOV : BASE_FOV + 3.5 * Math.min(sf, 1);
      const lb = input.lookBack;
      const swing = lb ? 0 : clamp(input.driftAngle, -0.8, 0.8) * 0.32;
      let yawT = p.yaw + (lb ? Math.PI : 0) + swing;
      const modeChange = snapNext || mode !== 'follow';
      const fromIntro = mode === 'intro';
      const yTarget = p.y + heightT;
      if (modeChange || lb !== lastLookBack) {
        yaw.snap(yawT);
        if (fromIntro && !lb) {
          // continue exactly from the flyover's last frame, then spring to the player's distance
          const ic = CHASE[introDistance];
          dist.snap(ic.dist);
          camY.snap(p.y + ic.height);
        } else {
          dist.snap(distT);
          camY.snap(yTarget);
        }
        if (modeChange) fov.snap(fovT);
        snapNext = false;
      } else {
        yawT = yaw.x + wrapAngle(yawT - yaw.x);
        yaw.step(yawT, input.airborne ? YAW_OMEGA_AIR : YAW_OMEGA, dt);
        if (yaw.v > 5) yaw.v = 5; else if (yaw.v < -5) yaw.v = -5;
        dist.step(distT, 3.5, dt);
        camY.step(yTarget, input.airborne ? 3.2 : 9, dt);
        // air lag adds lift to jumps, but never so much that the camera stares up at the chassis
        if (camY.x < yTarget - AIR_LAG_BELOW) { camY.x = yTarget - AIR_LAG_BELOW; if (camY.v < 0) camY.v = 0; }
        else if (camY.x > yTarget + AIR_LAG_ABOVE) { camY.x = yTarget + AIR_LAG_ABOVE; if (camY.v > 0) camY.v = 0; }
        fov.step(fovT, input.boosting ? 7 : 2.5, dt);
      }
      if (yaw.x > 4 * TAU || yaw.x < -4 * TAU) yaw.x = wrapAngle(yaw.x);
      mode = 'follow';
      lastLookBack = lb;

      const sy = Math.sin(yaw.x), cy = Math.cos(yaw.x);
      pos.set(p.x - sy * dist.x, camY.x, p.z - cy * dist.x);
      const y0 = pos.y;
      constrain(track, pos, p.y);
      if (pos.y > y0) { camY.x = pos.y; if (camY.v < 0) camY.v = 0; }
      camera.position.copy(pos);

      const dir = lb ? -1 : 1;
      const hs = Math.sin(p.yaw), hc = Math.cos(p.yaw);
      look.set(
        input.focus.x + hs * LOOK_AHEAD * dir,
        input.focus.y + LOOK_UP,
        input.focus.z + hc * LOOK_AHEAD * dir,
      );
      camera.lookAt(look);
      setFov(fov.x);
      applyShake(dt);
    },

    intro(track: BuiltTrack, endPose: KartPose, t: number, distance?: Distance) {
      t = clamp(Number.isFinite(t) ? t : 1, 0, 1);
      useTrack(track);
      introDistance = distance && CHASE[distance] ? distance : lastDistance;
      if (introTrack !== track || introX !== endPose.x || introZ !== endPose.z) {
        introTrack = track; introX = endPose.x; introZ = endPose.z;
        introS = projectToTrack(track, endPose.x, endPose.z, -1).s;
        introSpan = clamp(track.length * 0.35, 150, 320);
        // fly on the outside of the dominant bend so more of the course is in view
        let curv = 0;
        for (let k = 0; k < 48; k++) curv += track.curvature[sampleIndex(track, introS - introSpan * (k / 48))]!;
        introSide = curv > 0 ? -1 : 1;
      }
      const cfg = CHASE[introDistance];
      const sy = Math.sin(endPose.yaw), cy = Math.cos(endPose.yaw);
      // exact chase pose at t = 1 (matches follow()'s snap at rest)
      const chX = endPose.x - sy * cfg.dist, chY = endPose.y + cfg.height, chZ = endPose.z - cy * cfg.dist;
      const lkX = endPose.x + sy * LOOK_AHEAD, lkY = endPose.y + FOCUS_H + LOOK_UP, lkZ = endPose.z + cy * LOOK_AHEAD;

      const e = 1 - Math.pow(1 - t, 1.8);
      const sCam = introS - cfg.dist - introSpan * (1 - e);
      const hFly = 2.5 + 30 * Math.pow(1 - smooth(0.15, 1.0, t), 1.35);
      let lat = introSide * 24 * (1 - smooth(0.05, 0.92, t));
      // on the inside of a tight bend a 24 m offset curve folds back on itself: cap it by the local radius
      // (soft limit: smooth in both lat and curvature, so the path never kinks)
      const inside = lat * curvAround(track, sCam);
      if (inside > 0) lat /= Math.sqrt(1 + (inside / 0.4) * (inside / 0.4));
      const c = trackPoint(track, sCam, lat, tmpA);
      const ahead = 60 + (cfg.dist + LOOK_AHEAD - 60) * smooth(0.35, 1.0, t);
      const lp = trackPoint(track, sCam + ahead, lat * 0.25, tmpB);
      const w = smooth(0.8, 1.0, t);
      pos.set(
        c.x + (chX - c.x) * w,
        c.y + hFly + (chY - c.y - hFly) * w,
        c.z + (chZ - c.z) * w,
      );
      // look a little higher early on so the aerial shows horizon/backdrop, not just asphalt
      const lookLift = 1.5 + 9 * (1 - smooth(0.15, 0.85, t));
      look.set(
        lp.x + (lkX - lp.x) * w,
        lp.y + lookLift + (lkY - lp.y - lookLift) * w,
        lp.z + (lkZ - lp.z) * w,
      );
      // the camera's own arc length is known: project locally around it (a global search could land
      // on an overlapping upper deck and shove the camera up by the deck height)
      hint = sampleIndex(track, sCam);
      constrain(track, pos, c.y - hFly * (1 - w));
      camera.position.copy(pos);
      camera.lookAt(look);
      setFov(60 + (BASE_FOV - 60) * smooth(0.4, 1.0, t));
      mode = 'intro';
      snapNext = true;
    },

    orbit(focus: THREE.Vector3, dt: number) {
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;
      if (mode !== 'orbit') {
        const dx = camera.position.x - focus.x, dz = camera.position.z - focus.z;
        orbitAngle = Math.atan2(dx, dz);
        orbitR.snap(Math.max(2, Math.hypot(dx, dz)));
        orbitH.snap(camera.position.y - focus.y);
        fov.snap(logicalFov);
        mode = 'orbit';
        snapNext = true;
      }
      orbitAngle += dt * 0.42;
      if (orbitAngle > TAU) orbitAngle -= TAU;
      orbitR.step(6.8, 1.2, dt);
      orbitH.step(1.5, 1.2, dt);
      pos.set(
        focus.x + Math.sin(orbitAngle) * orbitR.x,
        focus.y + orbitH.x,
        focus.z + Math.cos(orbitAngle) * orbitR.x,
      );
      if (lastTrack) constrain(lastTrack, pos, focus.y - 1);
      camera.position.copy(pos);
      look.set(focus.x, focus.y + 0.2, focus.z);
      camera.lookAt(look);
      setFov(fov.step(62, 2, dt));
      applyShake(dt);
    },

    shake(strength: number) {
      if (!(strength > 0)) return;
      trauma = Math.min(1, trauma + strength);
    },

    reset() {
      snapNext = true;
      trauma = 0;
    },
  };
  return rig;
}
