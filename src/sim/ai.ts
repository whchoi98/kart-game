/**
 * CPU drivers: racing line following, corner drifting with mini-turbos, hazard
 * avoidance, item tactics, rocket starts and gentle rubber-banding.
 * Deterministic: decisions only use the world RNG and simulation state.
 */
import { clamp, datan2, dcos, dsin, wrapAngle } from './dmath.js';
import { CPU_LEVELS, DT, PHYS, START_BOOST_PERFECT, START_BOOST_GOOD, COUNTDOWN_TICKS, type CpuTuning } from './constants.js';
import { ITEMS } from './item-defs.js';
import { deltaS, pointAt, projectToTrack } from './track-query.js';
import type { Rng } from './rng.js';
import type { BuiltTrack, CpuLevel, KartInput, KartState, Projectile } from './types.js';

export interface AiState {
  tuning: CpuTuning;
  /** Personal racing-line bias (m). */
  bias: number;
  wanderPhase: number;
  wanderRate: number;
  personalSpeed: number;
  startTick: number;
  stuck: number;
  reverse: number;
  reverseSteer: number;
  itemTimer: number;
  itemDelay: number;
  holdingFor: number;
  driftWant: number;
  noisePhase: number;
  /** Chosen dodge side per mover (-1 left, 1 right, 0 none). */
  dodge: number[];
}

interface LineCache { line: Float64Array; kAhead: Float64Array }
const lineCache = new WeakMap<BuiltTrack, LineCache>();

/** Ideal lateral offset per sample: inside at the apex, smoothed so it flows. */
export function racingLine(t: BuiltTrack): LineCache {
  let c = lineCache.get(t);
  if (c) return c;
  const n = t.n;
  const kAhead = new Float64Array(n);
  const look = Math.max(4, Math.round(12 / t.spacing));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < look; k++) sum += t.curvature[(i + k) % n]!;
    kAhead[i] = sum / look;
  }
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = kAhead[(i + Math.round(6 / t.spacing)) % n]!;
    const inside = clamp(k * 38, -1, 1);
    raw[i] = inside * t.hw[i]! * 0.55;
  }
  const line = new Float64Array(n);
  const W = Math.round(14 / t.spacing);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -W; k <= W; k++) sum += raw[(i + k + n) % n]!;
    line[i] = sum / (2 * W + 1);
  }
  c = { line, kAhead };
  lineCache.set(t, c);
  return c;
}

export function createAiState(rng: Rng, level: CpuLevel): AiState {
  const tuning = CPU_LEVELS[level];
  let startTick: number;
  const r = rng.next();
  if (r < tuning.startSkill) startTick = START_BOOST_PERFECT[0] + rng.int(2, START_BOOST_PERFECT[1] - START_BOOST_PERFECT[0] - 2);
  else if (r < tuning.startSkill + 0.3) startTick = START_BOOST_GOOD[0] + rng.int(1, START_BOOST_GOOD[1] - START_BOOST_GOOD[0] - 1);
  else startTick = COUNTDOWN_TICKS + rng.int(0, 18);
  return {
    tuning,
    bias: rng.range(-1, 1) * tuning.wander,
    wanderPhase: rng.range(0, 6.28),
    wanderRate: rng.range(0.15, 0.35),
    personalSpeed: 1 + rng.range(-0.015, 0.015),
    startTick,
    stuck: 0, reverse: 0, reverseSteer: 0,
    itemTimer: 0, itemDelay: rng.range(0.4, 2.2), holdingFor: 0,
    driftWant: 0,
    noisePhase: rng.range(0, 6.28),
    dodge: [],
  };
}

export interface AiWorld {
  readonly track: BuiltTrack;
  readonly karts: KartState[];
  readonly projectiles: Projectile[];
  readonly rng: Rng;
  readonly tick: number;
  readonly racing: boolean;
  /** Mover positions at the current tick. */
  moverAt(index: number, aheadTicks?: number): { x: number; z: number; radius: number };
  readonly moverCount: number;
  /** Progress of the leading human (for rubber-banding) or null. */
  humanLeadProgress: number | null;
}

function curvatureAhead(t: BuiltTrack, s: number, from: number, to: number): { max: number; avg: number } {
  const n = t.n;
  const i0 = Math.floor(((s + from) % t.length + t.length) % t.length / t.spacing);
  const cnt = Math.max(1, Math.round((to - from) / t.spacing));
  let max = 0, sum = 0;
  for (let k = 0; k < cnt; k++) {
    const c = t.curvature[(i0 + k) % n]!;
    sum += c;
    if (Math.abs(c) > Math.abs(max)) max = c;
  }
  return { max, avg: sum / cnt };
}

export function computeAiInput(w: AiWorld, k: KartState, ai: AiState, finishedCruise = false, out?: KartInput): KartInput {
  const t = w.track;
  // reuse the caller's object when given (no per-tick garbage); every field is reset here
  const input: KartInput = out ?? { throttle: false, brake: false, steer: 0, drift: false, item: false, back: false };
  input.throttle = false; input.brake = false; input.steer = 0; input.drift = false; input.item = false; input.back = false;

  if (!w.racing) {
    input.throttle = w.tick >= ai.startTick;
    return input;
  }

  // rubber-banding + difficulty
  const tune = ai.tuning;
  let scale = tune.speedFactor * ai.personalSpeed;
  if (w.humanLeadProgress !== null && !finishedCruise) {
    const gap = k.progress - w.humanLeadProgress;
    if (gap > 45) scale *= 1 - Math.min(0.11, (gap - 45) / 520);
    else if (gap < -70) scale *= 1 + Math.min(0.085, (-gap - 70) / 700);
  }
  if (finishedCruise) scale *= 0.86;
  k.speedScale = scale;

  if (k.respawnTime > 0 || k.autopilotTime > 0) { input.throttle = true; return input; }

  const fx = dsin(k.yaw), fz = dcos(k.yaw);
  const f = k.vx * fx + k.vz * fz;

  // stuck recovery
  if (ai.reverse > 0) {
    ai.reverse -= DT;
    input.brake = true;
    input.steer = ai.reverseSteer;
    return input;
  }
  if (k.spinTime <= 0 && k.tumbleTime <= 0 && k.stallTime <= 0 && f < 2.5) ai.stuck += DT; else ai.stuck = 0;
  if (ai.stuck > 1.4) {
    ai.stuck = 0;
    ai.reverse = 0.75;
    ai.reverseSteer = k.d > 0 ? -1 : 1;
    input.brake = true;
    return input;
  }

  // target point on the racing line
  const lc = racingLine(t);
  const look = 6.5 + Math.max(0, f) * 0.5;
  const sT = k.s + look;
  const iT = Math.floor(((sT % t.length) + t.length) % t.length / t.spacing) % t.n;
  ai.wanderPhase += ai.wanderRate * DT;
  const hwT = t.hw[iT]!;
  let dT = lc.line[iT]! + ai.bias * 0.6 + dsin(ai.wanderPhase) * tune.wander * 0.5;
  // pure pursuit on a curve: shift the aim point outward so the chord's middle sits on the line
  const kLook = lc.kAhead[iT]!;
  const bulge = look * look * Math.abs(kLook) / 8;
  if (Math.abs(kLook) > 1e-4) dT -= (kLook > 0 ? 1 : -1) * Math.min(bulge * 0.85, 3.5);

  // line choices: take boost pads that are near the line, stay out of slow surface bands
  if (k.boostTime <= 0 && k.starTime <= 0) {
    for (const pad of t.boostPads) {
      const ds = deltaS(t, k.s, pad.s);
      if (ds < 6 || ds > 45) continue;
      if (Math.abs(pad.d - dT) < 5.5 && k.grounded) {
        const pull = clamp(1 - (ds - 6) / 39, 0, 1) * (0.45 + 0.5 * tune.itemSkill);
        dT += (pad.d - dT) * pull;
      }
    }
    for (const z of t.surfaces) {
      if (z.kind === 'road' || z.kind === 'ice') continue;
      const s0 = deltaS(t, k.s, z.s0), s1 = deltaS(t, k.s, z.s1);
      if (s1 < 0 || s0 > 40) continue;          // zone behind us or too far ahead
      if (dT > z.d0 - 1.2 && dT < z.d1 + 1.2) {
        const toLo = z.d0 - 1.6, toHi = z.d1 + 1.6;
        const hwZ = t.hw[iT]! * 0.82;
        const loOk = toLo > -hwZ, hiOk = toHi < hwZ;
        if (loOk && (!hiOk || Math.abs(dT - toLo) < Math.abs(dT - toHi))) dT = toLo;
        else if (hiOk) dT = toHi;
      }
    }
  }

  // avoid hazards ahead (bananas, oncoming orbs) and movers
  for (const p of w.projectiles) {
    if (p.kind === 'skybomb' || (p.owner === k.index && p.ownerGrace > 0)) continue;
    const ds = deltaS(t, k.s, p.prog !== undefined && p.kind === 'banana' ? projectedS(t, p) : projectedS(t, p));
    if (ds < 2 || ds > 26) continue;
    const pd = projectedD(t, p);
    if (Math.abs(pd - dT) < 2.8) dT = pd + (pd > dT ? -3.4 : 3.4) * (tune.itemSkill > 0.5 ? 1 : 0.7);
  }
  let slowForMover = false;
  for (let m = 0; m < w.moverCount; m++) {
    const now = w.moverAt(m);
    const dx0 = now.x - k.x, dz0 = now.z - k.z;
    if (dx0 * dx0 + dz0 * dz0 > 60 * 60) continue;
    // work in the track frame: arc distance ahead and lateral offset of the mover
    const pm = projectToTrack(t, now.x, now.z, k.ti);
    const ds = deltaS(t, k.s, pm.s);
    if (ds < -2.5 || ds > 45) continue;
    // mover's along-track speed (travel movers follow the road; sweeps have ~0)
    const p2 = w.moverAt(m, 30);
    const pm2 = projectToTrack(t, p2.x, p2.z, pm.i);
    const vAlong = deltaS(t, pm.s, pm2.s) / 0.5;
    const closing = Math.max(3, f - vAlong);
    const eta = Math.max(0, ds) / closing;
    // lateral envelope of the mover around our arrival time
    let dMin = Infinity, dMax = -Infinity;
    for (const dtS of [-0.35, 0, 0.35, 0.7]) {
      const q = w.moverAt(m, Math.max(0, Math.round((eta + dtS) * 60)));
      const pq = projectToTrack(t, q.x, q.z, pm.i);
      if (pq.d < dMin) dMin = pq.d;
      if (pq.d > dMax) dMax = pq.d;
    }
    // easier CPUs leave smaller margins (they get caught now and then)
    const clear = now.radius + 1.0 + 0.6 + 0.7 * tune.itemSkill;
    const lo = dMin - clear, hi = dMax + clear;
    // where will we be laterally when we reach it?
    const reach = clamp(Math.max(0, ds) / look, 0, 1);
    const planned = k.d + (dT - k.d) * reach;
    if (planned > lo && planned < hi) {
      const hwM = t.hw[pm.i]! * 0.82;
      const canL = lo > -hwM, canR = hi < hwM;
      let side = ai.dodge[m] ?? 0;
      let want: number;
      if (!canL && !canR) {
        // fully blocked envelope: pass behind the mover (the side it is leaving) and ease off if close
        const tA = Math.max(0, Math.round(eta * 60));
        const qa = projectToTrack(t, w.moverAt(m, tA).x, w.moverAt(m, tA).z, pm.i);
        const qb = projectToTrack(t, w.moverAt(m, tA + 6).x, w.moverAt(m, tA + 6).z, pm.i);
        const vdM = qb.d - qa.d;
        side = vdM > 0 ? -1 : 1;
        want = clamp(qa.d + side * (now.radius + 2.2), -hwM, hwM);
        if (ds < 14 && Math.abs(planned - qa.d) < now.radius + 1.6) slowForMover = true;
      } else {
        if (side === 0 || (side < 0 && !canL) || (side > 0 && !canR)) {
          if (canL && canR) side = (dT - lo) < (hi - dT) ? -1 : 1; else side = canL ? -1 : 1;
        }
        want = side < 0 ? lo - 0.4 : hi + 0.4;
      }
      ai.dodge[m] = side;
      // aim so that the pursuit reaches `want` at the mover (the look point is beyond it)
      dT = k.d + (want - k.d) / Math.max(0.35, reach);
    } else if (ds > 20) ai.dodge[m] = 0;
  }
  // stay on the road, and keep the chord to the target clear of an inside wall
  // (a chord of length L across curvature k bulges L²k/8 toward the inside)
  let hiD = hwT * 0.82, loD = -hwT * 0.82;
  if (kLook > 1e-4 && t.edgeR[iT] === 1) hiD = Math.min(hiD, t.wallR[iT]! - 2.2 - bulge);
  if (kLook < -1e-4 && t.edgeL[iT] === 1) loD = Math.max(loD, -(t.wallL[iT]! - 2.2 - bulge));
  if (hiD < loD) { const mid = (hiD + loD) / 2; hiD = mid; loD = mid; }
  dT = clamp(dT, loD, hiD);
  const tp = pointAt(t, sT, dT);

  // velocity-aware heading error
  const want = datan2(tp.x - k.x, tp.z - k.z);
  // while sliding, steer by where the kart is actually travelling
  const speedH = Math.sqrt(k.vx * k.vx + k.vz * k.vz);
  const travelYaw = k.driftDir !== 0 && speedH > 5 ? datan2(k.vx, k.vz) : k.yaw;
  const err = wrapAngle(want - travelYaw);
  ai.noisePhase += DT * 1.7;
  const noise = dsin(ai.noisePhase * 2.3) * tune.noise + (k.inkTime > 0 ? dsin(ai.noisePhase * 5) * 0.35 : 0);
  let steer = clamp(-err * 2.4 + noise, -1, 1);

  // predictive barrier guard: where will the kart be across the road in ~0.7 s?
  const gi = k.ti;
  const grx = t.rx[gi]!, grz = t.rz[gi]!;
  const grh = Math.sqrt(grx * grx + grz * grz) || 1;
  const vLat = (k.vx * grx + k.vz * grz) / grh;          // + = moving right across the road
  const barR = t.edgeR[gi] === 2 ? t.hw[gi]! + 0.2 : t.wallR[gi]!;
  const barL = t.edgeL[gi] === 2 ? t.hw[gi]! + 0.2 : t.wallL[gi]!;
  const futureD = k.d + vLat * 0.7;
  const dangerR = futureD > barR - 2.0;
  const dangerL = futureD < -(barL - 2.0);
  if (k.driftDir === 0 && (dangerR || dangerL)) {
    // steer away from the barrier we are sliding toward
    steer = clamp(steer + (dangerR ? -0.8 : 0.8), -1, 1);
  }

  // speed management for tight corners
  const ahead = curvatureAhead(t, k.s, 4, 12 + Math.max(0, f) * 0.9);
  const kMax = Math.abs(ahead.max);
  const vAllow = kMax > 1e-4 ? (k.turnRate * 0.95) / kMax * 1.1 : 1e9;
  input.throttle = !slowForMover;
  if (f > vAllow + 7 && k.driftDir === 0) { input.throttle = false; input.brake = f > vAllow + 11; }
  else if (f > vAllow + 3 && k.driftDir === 0) input.throttle = false;

  // drifting through sustained corners: choose the drift tightness whose arc
  // curvature matches the corner ahead, corrected by the heading error.
  const corner = curvatureAhead(t, k.s, 6, 36);
  const kc = Math.abs(corner.avg);
  const driftDir = corner.avg > 0 ? 1 : -1;
  const skill = tune.driftSkill;
  const hScale = k.turnRate / PHYS.turnRate;
  const kN = hScale / PHYS.driftRadiusNeutral;
  const kT = hScale / PHYS.driftRadiusTight;
  const kW = hScale / PHYS.driftRadiusWide;
  if (k.driftDir === 0) {
    const enter = 0.014 + (1 - skill) * 0.012;
    if (skill > 0 && kc > enter && f > 15 && k.grounded && k.surface === 'road' && steer * driftDir > -0.1) {
      ai.driftWant += DT;
      if (ai.driftWant > 0.05) { input.drift = true; steer = driftDir * Math.max(0.35, Math.abs(steer)); }
    } else ai.driftWant = 0;
  } else {
    const dir = k.driftDir;
    const along = curvatureAhead(t, k.s, 2, 16);
    const kReq = along.avg * dir;                  // curvature needed in the drift direction
    let kDesired = kReq * 1.04 - err * dir * 0.07;
    // lateral awareness: open the arc when sliding toward the inside barrier
    const ki = k.ti;
    const insideWall = dir > 0 ? (t.edgeR[ki] === 2 ? t.hw[ki]! + 0.2 : t.wallR[ki]!) : (t.edgeL[ki] === 2 ? t.hw[ki]! + 0.2 : t.wallL[ki]!);
    const insideRoom = insideWall - k.d * dir;
    if (insideRoom < 3.2) kDesired -= (3.2 - insideRoom) * 0.014;
    let sp: number;
    if (kDesired >= kN) sp = clamp((kDesired - kN) / (kT - kN), 0, 1);
    else sp = -clamp((kN - kDesired) / (kN - kW), 0, 1);
    const cornerEnding = kDesired < kW * 0.75;
    const release = insideRoom < 1.7 || (dir > 0 ? dangerR : dangerL)
      || (cornerEnding && (k.driftLevel >= 1 || kReq < kW * 0.3) && curvatureAhead(t, k.s, 10, 30).avg * dir < kW * 0.8)
      || Math.abs(err) > 1.05
      || (k.driftLevel >= 3 && kReq < kN * 0.6)
      || (skill < 0.6 && k.driftLevel >= 1 && kReq < kN);
    input.drift = !release;
    if (input.drift) steer = clamp(sp * dir + noise * 0.5, -1, 1);
  }
  input.steer = steer;

  // tricks off ramps
  if (!k.grounded && k.trickReady && w.rng.next() < 0.25 + skill * 0.6) input.drift = !k.prevDrift;

  decideItem(w, k, ai, input);
  return input;
}

function projectedS(t: BuiltTrack, p: Projectile): number {
  return (p.i % t.n) * t.spacing;
}
function projectedD(t: BuiltTrack, p: Projectile): number {
  const i = p.i % t.n;
  const rh = Math.sqrt(t.rx[i]! * t.rx[i]! + t.rz[i]! * t.rz[i]!) || 1;
  return ((p.x - t.px[i]!) * t.rx[i]! + (p.z - t.pz[i]!) * t.rz[i]!) / (rh * rh);
}

function decideItem(w: AiWorld, k: KartState, ai: AiState, input: KartInput): void {
  if (!k.item || k.rouletteTime > 0) { ai.itemTimer = 0; ai.holdingFor = 0; return; }
  const skill = ai.tuning.itemSkill;
  ai.itemTimer += DT;
  const t = w.track;
  const item = k.item;
  const fx = dsin(k.yaw), fz = dcos(k.yaw);

  let nearAhead: KartState | null = null, nearBehind: KartState | null = null;
  let aheadDist = Infinity, behindDist = Infinity;
  let aligned = false, alignedBack = false;
  for (const o of w.karts) {
    if (o === k || o.respawnTime > 0) continue;
    const ds = deltaS(t, k.s, o.s);
    const dx = o.x - k.x, dz = o.z - k.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const cosA = dist > 0.1 ? (dx * fx + dz * fz) / dist : 0;
    if (ds > 0 && ds < aheadDist) { aheadDist = ds; nearAhead = o; aligned = cosA > 0.985 && dist < 36; }
    if (ds < 0 && -ds < behindDist) { behindDist = -ds; nearBehind = o; alignedBack = cosA < -0.97 && dist < 14; }
  }
  const def = ITEMS[item];
  const ready = ai.itemTimer > ai.itemDelay * (1.4 - skill * 0.6);
  const reset = () => { ai.itemTimer = 0; ai.itemDelay = w.rng.range(0.5, 2.5); ai.holdingFor = 0; };

  // single trailing items: hold as a shield, release to throw
  if (def.shield === 'trail' && def.uses === 1) {
    let fire = false, back = false;
    if (item === 'banana') {
      fire = (nearBehind !== null && behindDist < 7 && Math.abs(nearBehind.d - k.d) < 3) || ai.holdingFor > 9 + skill * 6;
    } else if (item === 'orb') {
      if (aligned && ready) fire = true;
      else if (alignedBack && ready) { fire = true; back = true; }
      else if (ai.holdingFor > 10) fire = true;
    } else {
      fire = (nearAhead !== null && aheadDist < 140 && ready) || ai.holdingFor > 8;
    }
    if (!k.holding) {
      input.item = ready || (nearBehind !== null && behindDist < 18);
      ai.holdingFor = 0;
    } else {
      ai.holdingFor += DT;
      input.item = !fire;
      input.back = back;
      if (fire) reset();
    }
    return;
  }

  const pulse = () => { input.item = !k.prevItem; if (input.item) reset(); };
  switch (item) {
    case 'banana3':
      if ((nearBehind && behindDist < 10 && ready) || ai.itemTimer > 6) pulse();
      break;
    case 'orb3':
      if (aligned && ready) pulse();
      else if (alignedBack && ready) { input.back = true; pulse(); }
      else if (ai.itemTimer > 9) pulse();
      break;
    case 'rocket3':
      if (nearAhead && aheadDist < 120 && ready) pulse();
      else if (ai.itemTimer > 10) pulse();
      break;
    case 'nitro':
    case 'nitro3': {
      const straight = Math.abs(curvatureAhead(t, k.s, 0, 30).avg) < 0.008;
      if ((straight || k.surface === 'dirt' || k.surface === 'mud') && ready && k.boostTime <= 0 && k.grounded) pulse();
      break;
    }
    case 'star':
      if (ready || (nearAhead && aheadDist < 25)) pulse();
      break;
    default:
      if (ready) pulse();
  }
}
