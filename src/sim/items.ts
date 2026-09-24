/**
 * Items: roulette, usage, shields, projectiles and their collisions.
 * Deterministic (world RNG only).
 */
import { clamp, datan2, dcos, dsin, hypot2 } from './dmath.js';
import { DT, KART_RADIUS, PHYS } from './constants.js';
import { ITEMS, ITEM_WEIGHTS, rankBucket } from './item-defs.js';
import { addCoins, applyBoost, cancelDrift, hitKart, type PhysicsContext } from './kart-physics.js';
import { deltaS, pointAt, projectToTrack, surfaceAt } from './track-query.js';
import type { Rng } from './rng.js';
import type {
  BuiltTrack, HitKind, ItemId, KartInput, KartState, Projectile, ProjectileKind,
} from './types.js';

export interface ItemWorld {
  readonly track: BuiltTrack;
  readonly karts: KartState[];
  projectiles: Projectile[];
  readonly rng: Rng;
  readonly ctx: PhysicsContext;
  nextProjectileId(): number;
  /** Seconds until another thunder may be rolled. */
  thunderCooldown: number;
}

const ORB_SPEED = 40;
const ORB_BACK_SPEED = 26;
const ROCKET_SPEED = 38;
const SKYBOMB_SPEED = 58;
const SKYBOMB_ALT = 7.5;
const SKYBOMB_RADIUS = 7;
const PROJECTILE_RADIUS = 0.75;

// ───────────────────────────── roulette ─────────────────────────────

export function rollItem(w: ItemWorld, k: KartState): ItemId {
  const bucket = rankBucket(k.position, w.karts.length);
  const skybombFlying = w.projectiles.some(p => p.kind === 'skybomb');
  let total = 0;
  const entries: Array<[ItemId, number]> = [];
  for (const id of Object.keys(ITEM_WEIGHTS) as ItemId[]) {
    let wgt = ITEM_WEIGHTS[id][bucket]!;
    if (id === 'skybomb' && skybombFlying) wgt = 0;
    if (id === 'thunder' && w.thunderCooldown > 0) wgt = 0;
    if (w.karts.length <= 1 && (id === 'skybomb' || id === 'thunder' || id === 'ink' || id === 'rocket' || id === 'rocket3')) wgt = 0;
    if (wgt > 0) { entries.push([id, wgt]); total += wgt; }
  }
  let r = w.rng.next() * total;
  for (const [id, wgt] of entries) {
    r -= wgt;
    if (r < 0) return id;
  }
  return entries[entries.length - 1]?.[0] ?? 'nitro';
}

/** Called when a kart drives through an item box. */
export function grantItemBox(w: ItemWorld, k: KartState): void {
  if (k.item !== null || k.rouletteTime > 0 || k.finished) return;
  const item = rollItem(w, k);
  if (item === 'thunder') w.thunderCooldown = 16;
  k.item = item;
  k.itemUses = ITEMS[item].uses;
  k.rouletteTime = PHYS.rouletteTime * (k.human >= 0 ? 1 : 0.75);
}

function clearHeld(k: KartState): void {
  k.held = [];
  k.holding = false;
}

function heldKind(item: ItemId): 'banana' | 'orb' | 'rocket' | null {
  if (item === 'banana' || item === 'banana3') return 'banana';
  if (item === 'orb' || item === 'orb3') return 'orb';
  if (item === 'rocket' || item === 'rocket3') return 'rocket';
  return null;
}

function refreshHeld(k: KartState): void {
  if (!k.item || k.rouletteTime > 0) { clearHeld(k); return; }
  const kind = heldKind(k.item);
  if (!kind) { clearHeld(k); return; }
  const def = ITEMS[k.item];
  if (k.item === 'banana3') {
    k.held = Array.from({ length: k.itemUses }, (_, i) => ({ kind, slot: i }));
  } else if (def.shield === 'orbit') {
    k.held = Array.from({ length: k.itemUses }, (_, i) => ({ kind, slot: i + 1 }));
  } else {
    k.held = k.holding ? [{ kind, slot: 0 }] : [];
  }
}

/** Lose the current item when hit (roulette results are kept). */
export function dropItemsOnHit(k: KartState): void {
  if (k.rouletteTime > 0) return;
  if (k.item && (k.held.length > 0 || heldKind(k.item) && ITEMS[k.item].shield === 'orbit')) {
    k.item = null;
    k.itemUses = 0;
  }
  clearHeld(k);
}

export function hitAndDrop(
  w: ItemWorld, k: KartState, kind: HitKind, by: number,
  source: ProjectileKind | 'mover' | 'kart' | 'star' | 'autopilot' | 'thunder',
): boolean {
  const ok = hitKart(k, kind, w.ctx, by, source);
  if (ok && kind !== 'bump') dropItemsOnHit(k);
  return ok;
}

// ───────────────────────────── usage ─────────────────────────────

function spendUse(k: KartState): void {
  k.itemUses--;
  if (k.itemUses <= 0) { k.item = null; k.itemUses = 0; }
  refreshHeld(k);
}

function spawn(w: ItemWorld, kind: ProjectileKind, owner: KartState, x: number, y: number, z: number, vx: number, vz: number): Projectile {
  const p: Projectile = {
    id: w.nextProjectileId(), kind, owner: owner.index,
    x, y, z, vx, vy: 0, vz,
    i: owner.ti, life: kind === 'banana' ? 90 : kind === 'orb' ? 9 : kind === 'rocket' ? 12 : 20,
    bounces: 0, target: -1, ownerGrace: kind === 'banana' ? 0.8 : 0.5,
    state: kind === 'banana' ? 'rest' : kind === 'skybomb' ? 'cruise' : 'fly',
    prog: owner.s,
  };
  w.projectiles.push(p);
  return p;
}

function kartAhead(w: ItemWorld, k: KartState): KartState | null {
  let best: KartState | null = null;
  for (const o of w.karts) {
    if (o === k || o.finished || o.respawnTime > 0) continue;
    if (o.position === k.position - 1) return o;
    if (o.progress > k.progress && (!best || o.progress < best.progress)) best = o;
  }
  return best;
}

function useItem(w: ItemWorld, k: KartState, back: boolean): void {
  const item = k.item!;
  const fx = dsin(k.yaw), fz = dcos(k.yaw);
  const f = k.vx * fx + k.vz * fz;
  w.ctx.emit({ t: 'itemUse', kart: k.index, item });
  switch (item) {
    case 'banana':
    case 'banana3': {
      const dist = 2.4;
      const p = spawn(w, 'banana', k, k.x - fx * dist, k.y, k.z - fz * dist, 0, 0);
      settleOnGround(w, p);
      break;
    }
    case 'orb':
    case 'orb3': {
      const speed = back ? ORB_BACK_SPEED : Math.max(ORB_SPEED, f + 12);
      const dir = back ? -1 : 1;
      spawn(w, 'orb', k, k.x + fx * 2.2 * dir, k.y + 0.5, k.z + fz * 2.2 * dir, fx * speed * dir, fz * speed * dir);
      break;
    }
    case 'rocket':
    case 'rocket3': {
      const dir = back ? -1 : 1;
      const speed = back ? ORB_BACK_SPEED : ROCKET_SPEED;
      const p = spawn(w, 'rocket', k, k.x + fx * 2.2 * dir, k.y + 0.6, k.z + fz * 2.2 * dir, fx * speed * dir, fz * speed * dir);
      if (!back) p.target = kartAhead(w, k)?.index ?? -1;
      break;
    }
    case 'nitro':
    case 'nitro3':
      applyBoost(k, PHYS.nitroBoostTime, 'nitro', w.ctx);
      break;
    case 'star':
      k.starTime = 7.5;
      k.spinTime = 0; k.tumbleTime = 0; k.shrinkTime = 0;
      applyBoost(k, 0.5, 'nitro', w.ctx);
      break;
    case 'thunder': {
      w.ctx.emit({ t: 'thunder', by: k.index });
      const n = w.karts.length;
      for (const o of w.karts) {
        if (o === k || o.starTime > 0 || o.autopilotTime > 0 || o.respawnTime > 0 || o.finished) continue;
        const frac = n > 1 ? (o.position - 1) / (n - 1) : 0;
        o.shrinkTime = 3.5 + 4.5 * (1 - frac);
        hitAndDrop(w, o, 'spin', k.index, 'thunder');
        if (o.rouletteTime <= 0) { o.item = null; o.itemUses = 0; clearHeld(o); }
      }
      break;
    }
    case 'ink': {
      const targets: number[] = [];
      for (const o of w.karts) {
        if (o === k || o.finished || o.position >= k.position) continue;
        o.inkTime = 4.6;
        targets.push(o.index);
      }
      w.ctx.emit({ t: 'ink', by: k.index, targets });
      break;
    }
    case 'autopilot':
      cancelDrift(k, w.ctx);
      k.autopilotTime = 6;
      k.spinTime = 0; k.tumbleTime = 0; k.shrinkTime = 0;
      break;
    case 'skybomb': {
      const p = spawn(w, 'skybomb', k, k.x, k.y + SKYBOMB_ALT, k.z, 0, 0);
      p.prog = k.progress;
      p.state = 'cruise';
      break;
    }
    case 'coins': {
      const c = addCoins(k, 3);
      w.ctx.emit({ t: 'coin', kart: k.index, x: k.x, y: k.y + 1, z: k.z, coins: c });
      break;
    }
  }
  spendUse(k);
}

/** Per-tick item handling for one kart (roulette, holding, firing). */
export function updateKartItem(w: ItemWorld, k: KartState, input: KartInput): void {
  if (k.rouletteTime > 0) {
    k.rouletteTime -= DT;
    if (k.rouletteTime <= 0) {
      k.rouletteTime = 0;
      w.ctx.emit({ t: 'itemGet', kart: k.index, item: k.item! });
      refreshHeld(k);
    }
    return;
  }
  if (!k.item) { clearHeld(k); return; }
  const busy = k.spinTime > 0 || k.tumbleTime > 0 || k.respawnTime > 0 || k.autopilotTime > 0 || !w.ctx.racing;
  const pressed = input.item && !k.prevItem;
  const released = !input.item && k.prevItem;
  const def = ITEMS[k.item];
  if (busy) {
    if (k.holding && !input.item) { k.holding = false; refreshHeld(k); }
    return;
  }
  const trailSingle = def.shield === 'trail' && def.uses === 1;
  if (trailSingle) {
    if (pressed) { k.holding = true; refreshHeld(k); return; }
    if (k.holding && released) { k.holding = false; useItem(w, k, input.back); return; }
    return;
  }
  if (pressed) useItem(w, k, input.back);
}

// ───────────────────────────── projectiles ─────────────────────────────

function settleOnGround(w: ItemWorld, p: Projectile): void {
  const proj = projectToTrack(w.track, p.x, p.z, p.i, p.y);
  p.i = proj.i;
  const s = surfaceAt(w.track, proj);
  if (s.height === -Infinity) { p.life = 0; return; }
  p.y = s.height + 0.35;
}

function removeProjectile(w: ItemWorld, p: Projectile): void {
  if (p.life > -1e8) {
    p.life = -1e9;
    w.ctx.emit({ t: 'projectileGone', id: p.id, x: p.x, y: p.y, z: p.z, kind: p.kind });
  }
}

function explode(w: ItemWorld, p: Projectile, radius: number): void {
  w.ctx.emit({ t: 'explosion', x: p.x, y: p.y, z: p.z, radius, source: p.kind });
  for (const o of w.karts) {
    const dx = o.x - p.x, dz = o.z - p.z, dy = o.y - p.y;
    if (dx * dx + dz * dz < radius * radius && dy * dy < 36) hitAndDrop(w, o, 'tumble', p.owner, p.kind);
  }
  removeProjectile(w, p);
}

function wallBounce(w: ItemWorld, p: Projectile, margin: number): boolean {
  const t = w.track;
  const proj = projectToTrack(t, p.x, p.z, p.i, p.y);
  p.i = proj.i;
  const i = proj.i;
  const limR = t.wallR[i]! - margin, limL = -(t.wallL[i]! - margin);
  let side = 0;
  if (t.edgeR[i] !== 2 && proj.d > limR) side = 1;
  else if (t.edgeL[i] !== 2 && proj.d < limL) side = -1;
  if (side !== 0) {
    const rh = Math.sqrt(t.rx[i]! * t.rx[i]! + t.rz[i]! * t.rz[i]!) || 1;
    const nx = side * t.rx[i]! / rh, nz = side * t.rz[i]! / rh;
    const pen = side > 0 ? proj.d - limR : limL - proj.d;
    p.x -= nx * pen * rh; p.z -= nz * pen * rh;
    const vn = p.vx * nx + p.vz * nz;
    if (vn > 0) { p.vx -= 2 * vn * nx; p.vz -= 2 * vn * nz; }
    return true;
  }
  const s = surfaceAt(t, proj);
  if (s.height === -Infinity) {
    p.vy -= 30 * DT;
    p.y += p.vy * DT;
    if (p.y < proj.h - 8) removeProjectile(w, p);
  } else {
    const target = s.height + (p.kind === 'banana' ? 0.35 : 0.5);
    // glide over ramps and follow terrain; drop off lips
    if (p.y > target + 0.6) { p.vy -= 30 * DT; p.y = Math.max(target, p.y + p.vy * DT); }
    else { p.y = target; p.vy = 0; }
  }
  return false;
}

function stepOrb(w: ItemWorld, p: Projectile): void {
  p.x += p.vx * DT; p.z += p.vz * DT;
  if (wallBounce(w, p, 0.6)) {
    p.bounces++;
    w.ctx.emit({ t: 'projectileBounce', id: p.id, x: p.x, y: p.y, z: p.z });
    if (p.bounces > 6) removeProjectile(w, p);
  }
}

function stepRocket(w: ItemWorld, p: Projectile): void {
  const t = w.track;
  const speed = hypot2(p.vx, p.vz) || ROCKET_SPEED;
  let tx: number, tz: number;
  const target = p.target >= 0 ? w.karts[p.target] : undefined;
  if (target && (target.respawnTime > 0 || target.finished)) p.target = -1;
  const proj = projectToTrack(t, p.x, p.z, p.i, p.y);
  p.i = proj.i;
  if (target && p.target >= 0) {
    const dx = target.x - p.x, dz = target.z - p.z;
    const ds = deltaS(t, proj.s, target.s);
    if (dx * dx + dz * dz < 26 * 26 && ds > -6) { tx = target.x; tz = target.z; }
    else {
      const a = pointAt(t, proj.s + 9, clamp(target.d, -t.hw[proj.i]! * 0.8, t.hw[proj.i]! * 0.8));
      tx = a.x; tz = a.z;
    }
  } else if (p.target === -1 && speed > ORB_BACK_SPEED + 1) {
    // untargeted forward rocket follows the road centre
    const a = pointAt(t, proj.s + 10, clamp(proj.d, -t.hw[proj.i]! * 0.5, t.hw[proj.i]! * 0.5));
    tx = a.x; tz = a.z;
  } else {
    tx = p.x + p.vx; tz = p.z + p.vz;
  }
  const cur = datan2(p.vx, p.vz);
  const want = datan2(tx - p.x, tz - p.z);
  let diff = want - cur;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const maxTurn = 4.2 * DT;
  const nd = cur + clamp(diff, -maxTurn, maxTurn);
  p.vx = dsin(nd) * speed; p.vz = dcos(nd) * speed;
  p.x += p.vx * DT; p.z += p.vz * DT;
  if (wallBounce(w, p, 0.6)) explode(w, p, 2.2);
}

function stepSkybomb(w: ItemWorld, p: Projectile): void {
  const t = w.track;
  let leader: KartState | null = null;
  for (const o of w.karts) if (!o.finished && (!leader || o.position < leader.position)) leader = o;
  if (!leader) { removeProjectile(w, p); return; }
  if (p.state === 'cruise') {
    p.prog += SKYBOMB_SPEED * DT;
    const s = t.startS + p.prog;
    const a = pointAt(t, s, 0);
    p.x = a.x; p.z = a.z; p.y = a.y + SKYBOMB_ALT;
    p.i = a.i;
    if (p.prog >= leader.progress - 14) { p.state = 'dive'; p.target = leader.index; p.life = 2.5; }
  } else {
    const tg = w.karts[p.target] ?? leader;
    const dx = tg.x - p.x, dz = tg.z - p.z, dy = tg.y + 0.6 - p.y;
    const dist = Math.sqrt(dx * dx + dz * dz + dy * dy);
    const step = (SKYBOMB_SPEED * 0.9) * DT;
    if (dist <= step + 0.8) {
      p.x = tg.x; p.y = tg.y + 0.5; p.z = tg.z;
      explode(w, p, SKYBOMB_RADIUS);
      return;
    }
    p.x += dx / dist * step; p.y += dy / dist * step; p.z += dz / dist * step;
    const proj = projectToTrack(t, p.x, p.z, p.i, p.y);
    p.i = proj.i;
  }
}

function shieldBlocks(k: KartState, p: Projectile): boolean {
  if (k.held.length === 0) return false;
  const orbit = k.held.some(h => h.slot > 0) && k.item !== 'banana3';
  if (orbit) return true;
  // trailing shields only cover the rear
  const fx = dsin(k.yaw), fz = dcos(k.yaw);
  return (p.x - k.x) * fx + (p.z - k.z) * fz < 0.3;
}

function projectileHitsKarts(w: ItemWorld, p: Projectile): void {
  if (p.kind === 'skybomb') return;
  const r = KART_RADIUS + PROJECTILE_RADIUS;
  for (const k of w.karts) {
    if (k.respawnTime > 0) continue;
    if (k.index === p.owner && p.ownerGrace > 0) continue;
    const dx = k.x - p.x, dz = k.z - p.z, dy = k.y + 0.4 - p.y;
    if (dx * dx + dz * dz > r * r || dy * dy > 2.6) continue;
    if (k.starTime > 0 || k.autopilotTime > 0) { removeProjectile(w, p); return; }
    if (shieldBlocks(k, p)) {
      w.ctx.emit({ t: 'blocked', kart: k.index, source: p.kind });
      spendUse(k);
      removeProjectile(w, p);
      return;
    }
    hitAndDrop(w, k, p.kind === 'banana' ? 'spin' : 'tumble', p.owner, p.kind);
    removeProjectile(w, p);
    return;
  }
}

function projectilesCollide(w: ItemWorld): void {
  const list = w.projectiles;
  for (let a = 0; a < list.length; a++) {
    const pa = list[a]!;
    if (pa.life <= 0 || pa.kind === 'skybomb') continue;
    for (let b = a + 1; b < list.length; b++) {
      const pb = list[b]!;
      if (pb.life <= 0 || pb.kind === 'skybomb') continue;
      if (pa.kind === 'banana' && pb.kind === 'banana') continue;
      const dx = pa.x - pb.x, dz = pa.z - pb.z, dy = pa.y - pb.y;
      if (dx * dx + dz * dz < 1.6 * 1.6 && dy * dy < 2) {
        w.ctx.emit({ t: 'explosion', x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2, radius: 1.5, source: pa.kind });
        removeProjectile(w, pa);
        removeProjectile(w, pb);
        break;
      }
    }
  }
}

export function updateProjectiles(w: ItemWorld): void {
  if (w.thunderCooldown > 0) w.thunderCooldown -= DT;
  for (const p of w.projectiles) {
    if (p.life <= 0) continue;
    p.life -= DT;
    if (p.ownerGrace > 0) p.ownerGrace -= DT;
    if (p.life <= 0) {
      if (p.kind === 'skybomb') explode(w, p, SKYBOMB_RADIUS);
      else { p.life = 1e-9; removeProjectile(w, p); }
      continue;
    }
    if (p.kind === 'orb') stepOrb(w, p);
    else if (p.kind === 'rocket') stepRocket(w, p);
    else if (p.kind === 'skybomb') stepSkybomb(w, p);
    if (p.life > 0) projectileHitsKarts(w, p);
  }
  projectilesCollide(w);
  if (w.projectiles.some(p => p.life <= 0)) w.projectiles = w.projectiles.filter(p => p.life > 0);
}
