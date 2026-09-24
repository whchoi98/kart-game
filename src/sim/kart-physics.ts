/**
 * Arcade kart dynamics. Deterministic: only dmath + exact arithmetic.
 *
 * Model: heading (yaw) + planar velocity. Steering rotates the heading; the
 * velocity is re-decomposed into forward/lateral parts each tick and the
 * lateral part decays by a surface/drift-dependent grip factor, which gives the
 * characteristic slide. Vertical motion follows the ground while it can, and
 * becomes ballistic when the ground falls away faster than gravity (ramp lips,
 * crests, hops).
 */
import { clamp, damp, datan2, dcos, dsin, lerp, approach, wrapAngle } from './dmath.js';
import { DT, GRAVITY, KART_RADIUS, MAX_COINS, PHYS, SPEED_CLASSES } from './constants.js';
import { getCharacter } from './characters.js';
import { deltaS, pointAt, projectToTrack, surfaceAt, trackYaw } from './track-query.js';
import type {
  BoostKind, BuiltTrack, HitKind, KartInput, KartState, ProjectileKind, RaceEvent, RacerSetup, SpeedClass,
} from './types.js';

export interface PhysicsContext {
  track: BuiltTrack;
  /** Absolute tick (since countdown start). */
  tick: number;
  /** True once GO has happened. */
  racing: boolean;
  emit(e: RaceEvent): void;
}

// Precomputed grip decay factors (deterministic dexp once at load).
const GRIP = {
  road: damp(PHYS.gripRoad, DT),
  drift: damp(PHYS.gripDrift, DT),
  ice: damp(PHYS.gripIce, DT),
  air: damp(PHYS.gripAir, DT),
  spin: damp(3, DT),
};
const SPIN_DECAY = damp(2.2, DT);
const TUMBLE_DECAY = damp(3.2, DT);
const AIR_DRAG = damp(0.05, DT);

export function createKart(
  index: number, setup: RacerSetup, cc: SpeedClass, track: BuiltTrack, slot: BuiltTrack['grid'][number], speedScale: number,
): KartState {
  const ch = getCharacter(setup.charId);
  const cls = SPEED_CLASSES[cc];
  const st = ch.stats;
  const progress = deltaS(track, track.startS, slot.s);
  return {
    index, charId: setup.charId, human: setup.human,
    x: slot.x, y: slot.y, z: slot.z, yaw: slot.yaw,
    vx: 0, vz: 0, vy: 0, speed: 0, grounded: true, airTime: 0,
    pitch: 0, roll: 0, driftAngle: 0, steerVisual: 0,
    ti: slot.i, s: slot.s, d: slot.d, progress,
    lap: 0, lapStartTick: 0, lapTicks: [], finished: false, finishTick: -1,
    position: index + 1, wrongWay: false,
    lastSafe: { x: slot.x, y: slot.y, z: slot.z, yaw: slot.yaw, i: slot.i, progress },
    surface: 'road',
    driftDir: 0, driftCharge: 0, driftLevel: 0, hopTime: 0,
    boostTime: 0, boostKind: null, trickReady: false, trickPending: false, trickTime: 0,
    spinTime: 0, tumbleTime: 0, shrinkTime: 0, starTime: 0, inkTime: 0, autopilotTime: 0,
    invulnTime: 0, respawnTime: 0, stallTime: 0,
    item: null, itemUses: 0, rouletteTime: 0, held: [], holding: false, coins: 0,
    prevDrift: false, prevItem: false, throttle: false, throttleStartTick: -1,
    maxSpeed: cls.maxSpeed * (0.95 + 0.02 * (st.speed - 1)),
    accel: cls.accel * (0.82 + 0.09 * (st.accel - 1)) * (1.04 - 0.02 * (st.weight - 1)),
    turnRate: PHYS.turnRate * (0.88 + 0.06 * (st.handling - 1)),
    mass: 0.8 + 0.1 * (st.weight - 1),
    speedScale,
    hitTimer: 99,
  };
}

export function applyBoost(k: KartState, time: number, kind: BoostKind, ctx: PhysicsContext): void {
  const fresh = k.boostTime <= 0.05 || kind !== k.boostKind;
  k.boostTime = Math.max(k.boostTime, time);
  k.boostKind = kind;
  // an instant kick so boosts feel immediate
  const fx = dsin(k.yaw), fz = dcos(k.yaw);
  const f = k.vx * fx + k.vz * fz;
  const kick = k.maxSpeed * k.speedScale * 1.02;
  if (f < kick) {
    k.vx += fx * (kick - f) * 0.5;
    k.vz += fz * (kick - f) * 0.5;
  }
  if (fresh) ctx.emit({ t: 'boost', kart: k.index, kind });
}

export function cancelDrift(k: KartState, ctx: PhysicsContext): void {
  if (k.driftDir !== 0) ctx.emit({ t: 'driftEnd', kart: k.index });
  k.driftDir = 0; k.driftCharge = 0; k.driftLevel = 0;
}

export function loseCoins(k: KartState, count: number, ctx: PhysicsContext): void {
  const lost = Math.min(k.coins, count);
  if (lost > 0) {
    k.coins -= lost;
    ctx.emit({ t: 'coinLoss', kart: k.index, count: lost });
  }
}

/** Returns false when the kart is immune (star, autopilot, invulnerable, respawning). */
export function hitKart(
  k: KartState, kind: HitKind, ctx: PhysicsContext, by: number,
  source: ProjectileKind | 'mover' | 'kart' | 'star' | 'autopilot' | 'thunder' | 'fall',
): boolean {
  if (k.respawnTime > 0 || k.starTime > 0 || k.autopilotTime > 0) return false;
  if (kind !== 'bump' && k.invulnTime > 0) return false;
  if (kind === 'bump') {
    ctx.emit({ t: 'hit', kart: k.index, kind, by, source });
    return true;
  }
  cancelDrift(k, ctx);
  k.trickPending = false;
  k.trickReady = false;
  k.boostTime = 0;
  k.boostKind = null;
  if (kind === 'spin') {
    k.spinTime = PHYS.spinTime;
    loseCoins(k, 2, ctx);
  } else if (kind === 'tumble') {
    k.tumbleTime = PHYS.tumbleTime;
    k.vy = Math.max(k.vy, 7.5);
    k.grounded = false;
    loseCoins(k, 3, ctx);
  } else {
    k.spinTime = PHYS.squashTime;
    loseCoins(k, 1, ctx);
  }
  k.invulnTime = PHYS.invulnAfterHit;
  k.hitTimer = 0;
  ctx.emit({ t: 'hit', kart: k.index, kind, by, source });
  return true;
}

export function startFall(k: KartState, ctx: PhysicsContext): void {
  cancelDrift(k, ctx);
  k.respawnTime = PHYS.respawnTime;
  k.boostTime = 0; k.boostKind = null;
  k.spinTime = 0; k.tumbleTime = 0; k.trickPending = false; k.trickReady = false;
  k.vx = 0; k.vz = 0; k.vy = 0;
  k.autopilotTime = 0;
  loseCoins(k, 2, ctx);
  ctx.emit({ t: 'fall', kart: k.index });
}

function finishRespawn(k: KartState, ctx: PhysicsContext): void {
  const t = ctx.track;
  const ls = k.lastSafe;
  const s = ls.i * t.spacing;
  const d = clamp(k.d, -t.hw[ls.i]! * 0.3, t.hw[ls.i]! * 0.3);
  const p = pointAt(t, s, d);
  k.x = p.x; k.y = p.y; k.z = p.z;
  k.yaw = trackYaw(t, ls.i);
  k.vx = 0; k.vz = 0; k.vy = 0; k.speed = 0;
  k.grounded = true; k.airTime = 0;
  k.ti = ls.i; k.s = s; k.d = d;
  k.progress = ls.progress;
  k.surface = 'road';
  k.invulnTime = 1.6;
  k.respawnTime = 0;
  ctx.emit({ t: 'respawn', kart: k.index });
}

/** Keep the kart on the grid during countdown (engine revs only). */
function stepCountdown(k: KartState, input: KartInput, ctx: PhysicsContext): void {
  if (input.throttle) {
    if (k.throttleStartTick < 0) k.throttleStartTick = ctx.tick;
  } else {
    k.throttleStartTick = -1;
  }
  k.steerVisual = approach(k.steerVisual, input.steer, 6 * DT);
}

function stepAutopilot(k: KartState, ctx: PhysicsContext): void {
  const t = ctx.track;
  k.autopilotTime -= DT;
  const speed = PHYS.autopilotSpeed;
  const ds = speed * DT;
  const s = k.s + ds;
  const d = approach(k.d, 0, 5 * DT);
  const p = pointAt(t, s, d);
  const hover = 0.9;
  k.vx = (p.x - k.x) / DT; k.vz = (p.z - k.z) / DT;
  k.vy = 0;
  k.x = p.x; k.z = p.z; k.y = p.y + hover;
  k.yaw = p.yaw;
  k.speed = speed;
  k.ti = p.i;
  k.progress += deltaS(t, k.s, s);
  k.s = s >= t.length ? s - t.length : s;
  k.d = d;
  k.grounded = true;
  k.surface = 'road';
  k.invulnTime = Math.max(k.invulnTime, 0.2);
  if (k.autopilotTime <= 0) {
    k.autopilotTime = 0;
    k.y = p.y;
    k.lastSafe = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, i: p.i, progress: k.progress };
    applyBoost(k, 1.0, 'nitro', ctx);
  }
}

export function tickTimers(k: KartState): void {
  const dec = (v: number) => (v > DT ? v - DT : 0);
  k.boostTime = dec(k.boostTime);
  if (k.boostTime <= 0) k.boostKind = null;
  k.spinTime = dec(k.spinTime);
  k.tumbleTime = dec(k.tumbleTime);
  k.shrinkTime = dec(k.shrinkTime);
  k.starTime = dec(k.starTime);
  k.inkTime = dec(k.inkTime);
  k.invulnTime = dec(k.invulnTime);
  k.trickTime = dec(k.trickTime);
  k.hopTime = dec(k.hopTime);
  k.stallTime = dec(k.stallTime);
  k.hitTimer += DT;
}

export function stepKart(k: KartState, input: KartInput, ctx: PhysicsContext): void {
  const t = ctx.track;
  tickTimers(k);
  k.throttle = input.throttle;

  if (!ctx.racing) { stepCountdown(k, input, ctx); return; }

  if (k.respawnTime > 0) {
    k.respawnTime -= DT;
    if (k.respawnTime <= 0) finishRespawn(k, ctx);
    return;
  }
  if (k.autopilotTime > 0) { stepAutopilot(k, ctx); return; }

  const controllable = k.spinTime <= 0 && k.tumbleTime <= 0;
  const steer = controllable ? clamp(input.steer, -1, 1) : 0;
  const throttle = controllable && k.stallTime <= 0 && input.throttle;
  const brake = controllable && input.brake && !input.throttle;
  const driftPressed = input.drift && !k.prevDrift;

  // ── heading ──
  let fx = dsin(k.yaw), fz = dcos(k.yaw);
  const f0 = k.vx * fx + k.vz * fz;
  const af0 = f0 < 0 ? -f0 : f0;
  const speedFrac = clamp(af0 / k.maxSpeed, 0, 1);
  let yawRate: number;
  if (k.driftDir !== 0) {
    // radius-based drift arc: tighter when steering into the drift, wider when countering
    const sp = steer * k.driftDir;
    const kN = 1 / PHYS.driftRadiusNeutral;
    const curv = (sp >= 0 ? kN + sp * (1 / PHYS.driftRadiusTight - kN) : kN + sp * (kN - 1 / PHYS.driftRadiusWide))
      * (k.turnRate / PHYS.turnRate);
    yawRate = -k.driftDir * Math.max(af0, 6) * curv;
  } else {
    const auth = clamp(af0 / PHYS.steerFullSpeed, 0, 1) * lerp(1, PHYS.steerHighSpeedFactor, speedFrac);
    yawRate = -steer * k.turnRate * auth * (f0 < -0.5 ? -1 : 1);
  }
  if (!k.grounded) yawRate *= k.hopTime > 0 ? 0.85 : 0.3;
  if (k.spinTime > 0 || k.tumbleTime > 0) yawRate = 0;
  k.yaw = wrapAngle(k.yaw + yawRate * DT);
  fx = dsin(k.yaw); fz = dcos(k.yaw);
  const rxh = -fz, rzh = fx;

  let f = k.vx * fx + k.vz * fz;
  let l = k.vx * rxh + k.vz * rzh;

  // ── speed cap ──
  let surf = 1;
  if (k.grounded) {
    if (k.surface === 'dirt') surf = PHYS.offroadSpeedFactor;
    else if (k.surface === 'mud') surf = PHYS.mudSpeedFactor;
  }
  const boosting = k.boostTime > 0;
  if (boosting || k.starTime > 0) surf = 1;
  let vmax = k.maxSpeed * k.speedScale * (1 + PHYS.coinSpeedBonus * k.coins);
  if (k.starTime > 0) vmax *= PHYS.starSpeedFactor;
  if (k.shrinkTime > 0) vmax *= PHYS.shrinkSpeedFactor;
  const cap = (boosting ? vmax * PHYS.boostSpeedFactor : vmax) * surf;

  // ── longitudinal ──
  if (k.grounded) {
    if (boosting && controllable) {
      f = f < cap ? Math.min(cap, f + PHYS.boostAccel * DT) : approach(f, cap, PHYS.overSpeedDecel * DT);
    } else if (throttle) {
      // braking out of reverse; near zero go straight to accelerating so slopes can't pin the kart
      if (f < -0.5) f = Math.min(0, f + PHYS.brakeDecel * DT);
      else if (f < cap) {
        const r = f / cap;
        f = Math.min(cap, f + k.accel * (1 - 0.62 * r * r) * DT);
      } else f = approach(f, cap, PHYS.overSpeedDecel * DT);
    } else if (brake) {
      if (f > 0.3) f = Math.max(0, f - PHYS.brakeDecel * DT);
      else f = Math.max(-PHYS.reverseMax, f - k.accel * 0.55 * DT);
    } else {
      f = approach(f, 0, PHYS.coastDecel * DT);
      if (f > cap) f = approach(f, cap, PHYS.overSpeedDecel * DT);
    }
    // gravity along the slope in the heading direction
    const i = k.ti;
    const along = fx * t.tx[i]! + fz * t.tz[i]!;
    f -= GRAVITY * PHYS.slopeGravityFactor * t.ty[i]! * along * DT;
    if (k.spinTime > 0) f *= SPIN_DECAY;
    if (k.tumbleTime > 0) f *= TUMBLE_DECAY;
    if (k.stallTime > 0) f = approach(f, 0, 12 * DT);
  } else {
    if (boosting && f < cap) f = Math.min(cap, f + PHYS.boostAccel * 0.3 * DT);
    f *= AIR_DRAG;
  }

  // ── hop / trick / drift ──
  if (controllable && driftPressed) {
    if (k.grounded && k.driftDir === 0) {
      k.vy = PHYS.hopVelocity;
      k.grounded = false;
      k.hopTime = 0.3;
      ctx.emit({ t: 'hop', kart: k.index });
    } else if (!k.grounded && k.trickReady && !k.trickPending) {
      k.trickPending = true;
      k.trickReady = false;
      k.trickTime = 0.55;
      ctx.emit({ t: 'trick', kart: k.index });
    }
  }
  if (controllable && input.drift && k.driftDir === 0 && (steer > 0.3 || steer < -0.3)
    && f > PHYS.driftMinSpeed && (k.grounded || k.hopTime > 0)) {
    k.driftDir = steer > 0 ? 1 : -1;
    k.driftCharge = 0;
    k.driftLevel = 0;
    ctx.emit({ t: 'driftStart', kart: k.index, dir: k.driftDir });
  }
  if (k.driftDir !== 0) {
    if (!input.drift || !controllable) {
      const level = k.driftLevel;
      cancelDrift(k, ctx);
      if (controllable && level > 0) {
        applyBoost(k, PHYS.driftBoostTime[level - 1]!, level === 1 ? 'mini1' : level === 2 ? 'mini2' : 'mini3', ctx);
      }
    } else if (f < PHYS.driftMinSpeed * 0.6) {
      cancelDrift(k, ctx);
    } else if (k.grounded && (k.surface === 'road' || k.surface === 'ice')) {
      const sp = steer * k.driftDir;
      k.driftCharge += (sp >= 0 ? 1 + 0.9 * sp : 1 + 0.2 * sp) * DT;
      const lv = k.driftCharge >= PHYS.driftLevels[2] ? 3 : k.driftCharge >= PHYS.driftLevels[1] ? 2 : k.driftCharge >= PHYS.driftLevels[0] ? 1 : 0;
      if (lv > k.driftLevel) {
        k.driftLevel = lv as 1 | 2 | 3;
        ctx.emit({ t: 'driftLevel', kart: k.index, level: k.driftLevel });
      }
    }
  }

  // ── lateral grip ──
  let g = GRIP.road;
  if (!k.grounded) g = GRIP.air;
  else if (k.spinTime > 0) g = GRIP.spin;
  else if (k.driftDir !== 0) g = GRIP.drift;
  else if (k.surface === 'ice') g = GRIP.ice;
  l *= g;

  k.vx = fx * f + rxh * l;
  k.vz = fz * f + rzh * l;
  k.speed = f;

  // ── integrate horizontal ──
  const prevI = k.ti;
  k.x += k.vx * DT;
  k.z += k.vz * DT;
  let proj = projectToTrack(t, k.x, k.z, k.ti, k.y);

  // ── barriers ──
  const i = proj.i;
  const rX = t.rx[i]!, rZ = t.rz[i]!;
  const rh = Math.sqrt(rX * rX + rZ * rZ) || 1;
  const limR = t.wallR[i]! - KART_RADIUS * 0.85;
  const limL = -(t.wallL[i]! - KART_RADIUS * 0.85);
  let pen = 0, side = 0;
  if (t.edgeR[i] !== 2 && proj.d > limR) { pen = proj.d - limR; side = 1; }
  else if (t.edgeL[i] !== 2 && proj.d < limL) { pen = limL - proj.d; side = -1; }
  if (side !== 0) {
    const nx = side * rX / rh, nz = side * rZ / rh;
    k.x -= nx * pen * rh;
    k.z -= nz * pen * rh;
    const vn = k.vx * nx + k.vz * nz;
    if (vn > 0) {
      k.vx -= nx * vn * (1 + PHYS.wallRestitution);
      k.vz -= nz * vn * (1 + PHYS.wallRestitution);
      if (vn > 3) {
        const scale = 1 - PHYS.wallSpeedLoss * Math.min(1, vn / 14);
        k.vx *= scale; k.vz *= scale;
        ctx.emit({ t: 'wall', kart: k.index, impact: vn, x: k.x + nx * KART_RADIUS, y: k.y + 0.4, z: k.z + nz * KART_RADIUS });
      }
      if (vn > 7 && k.driftDir !== 0) cancelDrift(k, ctx);
    }
    proj = projectToTrack(t, k.x, k.z, proj.i, k.y);
  }

  // ── vertical ──
  const sInfo = surfaceAt(t, proj);
  const ground = sInfo.height;
  if (k.grounded) {
    const ballistic = k.y + k.vy * DT - 0.5 * GRAVITY * DT * DT;
    if (ground === -Infinity || ground < ballistic - 0.02) {
      k.grounded = false;
      k.y = ballistic;
      k.vy -= GRAVITY * DT;
      if (t.rampH[prevI]! > 0.3) {
        k.trickReady = true;
        if (t.rampTrick[prevI]) applyBoost(k, 0.8, 'ramp', ctx);
      }
    } else {
      k.vy = clamp((ground - k.y) / DT, -30, 16);
      k.y = ground;
    }
  } else {
    k.vy -= GRAVITY * DT;
    k.y += k.vy * DT;
    k.airTime += DT;
    if (ground !== -Infinity && k.y <= ground) {
      const hard = k.vy < -11;
      if (k.airTime > 0.22) ctx.emit({ t: 'land', kart: k.index, hard });
      k.y = ground;
      // land with the ground-following vertical speed so downhill landings don't skip
      {
        const li = proj.i;
        const thx = t.tx[li]!, thz = t.tz[li]!;
        const th = Math.sqrt(thx * thx + thz * thz) || 1;
        const va = (k.vx * thx + k.vz * thz) / th;
        k.vy = clamp(va * (t.ty[li]! / th), -30, 16);
      }
      k.grounded = true;
      k.hopTime = 0;
      k.trickReady = false;
      if (k.trickPending) {
        k.trickPending = false;
        applyBoost(k, PHYS.trickBoostTime, 'trick', ctx);
      }
    }
  }
  if (k.grounded) k.airTime = 0;

  // ── track bookkeeping ──
  k.ti = proj.i;
  k.progress += deltaS(t, k.s, proj.s);
  k.s = proj.s;
  k.d = proj.d;
  k.surface = k.grounded ? sInfo.kind : ground === -Infinity ? 'pit' : 'air';

  // fell into a pit / out of the world
  if (!k.grounded && (ground === -Infinity ? k.y < proj.h - 10 : k.y < ground - 30)) {
    startFall(k, ctx);
    return;
  }
  if (k.grounded && sInfo.onRoad && Math.abs(proj.d) < t.hw[proj.i]! * 0.7 && ctx.tick % 10 === 0) {
    k.lastSafe = { x: k.x, y: k.y, z: k.z, yaw: trackYaw(t, proj.i), i: proj.i, progress: k.progress };
  }

  // ── visuals ──
  const n = proj.i;
  const nfx = t.ux[n]! * fx + t.uz[n]! * fz;
  const nrx = t.ux[n]! * rxh + t.uz[n]! * rzh;
  const targetPitch = k.grounded ? -datan2(nfx, t.uy[n]!) : clamp(k.vy * 0.018, -0.35, 0.35);
  const targetRoll = k.grounded ? datan2(nrx, t.uy[n]!) : 0;
  k.pitch = approach(k.pitch, targetPitch, 2.5 * DT);
  k.roll = approach(k.roll, targetRoll, 2.5 * DT);
  const driftTarget = k.driftDir !== 0 ? -k.driftDir * (0.3 + 0.14 * Math.max(0, steer * k.driftDir)) : 0;
  k.driftAngle = approach(k.driftAngle, driftTarget, 2.6 * DT);
  k.steerVisual = approach(k.steerVisual, steer, 7 * DT);
}

/** Give a kart coins (capped), returns the new total. */
export function addCoins(k: KartState, n: number): number {
  k.coins = Math.min(MAX_COINS, k.coins + n);
  return k.coins;
}
