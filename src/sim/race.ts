/**
 * RaceWorld — the authoritative race simulation (60 Hz fixed step).
 * Owns karts, projectiles, item boxes, coins and movers; emits RaceEvents.
 */
import { dcos, dsin, TAU } from './dmath.js';
import { COUNTDOWN_TICKS, DT, KART_RADIUS, PHYS, START_BOOST_GOOD, START_BOOST_PERFECT, START_STALL_BEFORE, TICK_HZ } from './constants.js';
import { computeAiInput, createAiState, type AiState, type AiWorld } from './ai.js';
import { quantizeInput, NEUTRAL_INPUT } from './input-log.js';
import { grantItemBox, hitAndDrop, updateKartItem, updateProjectiles, type ItemWorld } from './items.js';
import { addCoins, applyBoost, createKart, stepKart, type PhysicsContext } from './kart-physics.js';
import { Rng } from './rng.js';
import { getBuiltTrack } from './track-builder.js';
import { deltaS, pointAt } from './track-query.js';
import type {
  BuiltTrack, KartInput, KartState, Projectile, RaceConfig, RaceEvent, RacePhase, RaceResult,
} from './types.js';

const HARD_LOOKS = new Set(['boulder', 'car', 'snowball', 'rock', 'log', 'lava', 'meteor', 'bus', 'truck', 'tiki']);
/** Half-length (m) of capsule-shaped movers along their heading. */
const MOVER_HALF_LENGTH: Record<string, number> = { bus: 3.4, truck: 2.8, car: 1.2 };

export class RaceWorld implements ItemWorld, AiWorld {
  readonly config: RaceConfig;
  readonly track: BuiltTrack;
  readonly laps: number;
  tick = 0;
  phase: RacePhase = 'countdown';
  karts: KartState[];
  projectiles: Projectile[] = [];
  itemBoxes: Array<{ x: number; y: number; z: number; active: boolean; timer: number }>;
  coins: Array<{ x: number; y: number; z: number; active: boolean; timer: number }>;
  readonly rng: Rng;
  readonly ctx: PhysicsContext;
  thunderCooldown = 0;
  humanLeadProgress: number | null = null;
  /** Tick (absolute) when the race was declared over. */
  doneTick = -1;
  private events: RaceEvent[] = [];
  private ai: Array<AiState | null>;
  private projectileSeq = 1;
  private finishCount = 0;
  private wrongWayTimer: number[];
  private lastHumanFinishTick = -1;
  private padCooldown: number[];
  /** Reused per-tick buffers (no garbage in the hot loop). */
  private readonly inputBuf: KartInput[] = [];
  private readonly aiInputs: KartInput[] = [];

  constructor(config: RaceConfig, track?: BuiltTrack) {
    this.config = config;
    this.track = track ?? getBuiltTrack(config.trackId, config.mirror);
    this.laps = config.laps ?? this.track.def.laps;
    this.rng = new Rng(config.seed);
    const tt = config.mode === 'tt';
    this.karts = config.racers.map((r, idx) => {
      const slot = this.track.grid[idx % this.track.grid.length]!;
      return createKart(idx, r, config.cc, this.track, slot, 1);
    });
    this.ai = this.karts.map(k => (k.human < 0 ? createAiState(this.rng, config.cpuLevel) : null));
    this.itemBoxes = config.items && !tt ? this.track.itemBoxes.map(b => ({ x: b.x, y: b.y, z: b.z, active: true, timer: 0 })) : [];
    this.coins = !tt ? this.track.coins.map(c => ({ x: c.x, y: c.y, z: c.z, active: true, timer: 0 })) : [];
    if (tt) for (const k of this.karts) { k.item = 'nitro3'; k.itemUses = 3; }
    this.wrongWayTimer = this.karts.map(() => 0);
    this.padCooldown = this.karts.map(() => 0);
    const emit = (e: RaceEvent) => { this.events.push(e); };
    const self = this;
    this.ctx = {
      track: this.track,
      get tick() { return self.tick; },
      get racing() { return self.phase !== 'countdown'; },
      emit,
    };
    this.events.push({ t: 'countdown', n: 3 });
    this.updatePositions();
  }

  get racing(): boolean { return this.phase !== 'countdown'; }
  get moverCount(): number { return this.track.movers.length; }

  nextProjectileId(): number { return this.projectileSeq++; }

  drainEvents(): RaceEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Ticks since GO (0 during countdown). */
  raceTicks(): number {
    return this.tick > COUNTDOWN_TICKS ? this.tick - COUNTDOWN_TICKS : 0;
  }

  moverPosition(index: number): { x: number; y: number; z: number; yaw: number } {
    return this.moverPositionAt(index, this.tick);
  }

  /** Mover pose at an arbitrary tick (movers are a pure function of time). */
  moverPositionAt(index: number, tick: number): { x: number; y: number; z: number; yaw: number } {
    const m = this.track.movers[index]!;
    const time = tick / TICK_HZ;
    if (m.kind === 'sweep') {
      const d = m.d + (m.amplitude ?? 0) * dsin(TAU * time / m.period + (m.phase ?? 0));
      const p = pointAt(this.track, m.s, d);
      const vd = (m.amplitude ?? 0) * dcos(TAU * time / m.period + (m.phase ?? 0));
      // movers drive on the road deck, never up the ramp wedges
      return { x: p.x, y: p.y - this.track.rampH[p.i]!, z: p.z, yaw: p.yaw + (vd >= 0 ? -Math.PI / 2 : Math.PI / 2) };
    }
    const frac = time / m.period + (m.phase ?? 0);
    const s = m.s + this.track.length * (frac - Math.floor(frac));
    const p = pointAt(this.track, s, m.d);
    return { x: p.x, y: p.y - this.track.rampH[p.i]!, z: p.z, yaw: p.yaw };
  }

  moverAt(index: number, aheadTicks = 0): { x: number; z: number; radius: number } {
    const p = this.moverPositionAt(index, this.tick + aheadTicks);
    return { x: p.x, z: p.z, radius: this.track.movers[index]!.radius };
  }

  step(humanInputs: readonly KartInput[]): void {
    const tick = this.tick;
    if (this.phase === 'countdown') {
      if (tick === 60) this.events.push({ t: 'countdown', n: 2 });
      else if (tick === 120) this.events.push({ t: 'countdown', n: 1 });
      if (tick >= COUNTDOWN_TICKS) {
        this.phase = 'racing';
        this.events.push({ t: 'countdown', n: 0 });
        this.resolveStarts();
      }
    }

    // leading human progress for rubber-banding
    let lead: number | null = null;
    for (const k of this.karts) if (k.human >= 0 && !k.finished && (lead === null || k.progress > lead)) lead = k.progress;
    this.humanLeadProgress = lead;

    // inputs
    const inputs = this.inputBuf;
    inputs.length = this.karts.length;
    for (let idx = 0; idx < this.karts.length; idx++) {
      const k = this.karts[idx]!;
      if (k.human >= 0 && !k.finished) { inputs[idx] = quantizeInput(humanInputs[k.human] ?? NEUTRAL_INPUT); continue; }
      let ai = this.ai[idx];
      if (!ai) { ai = createAiState(new Rng(idx * 7919 + 13), 'normal'); this.ai[idx] = ai; }
      const out = this.aiInputs[idx] ?? (this.aiInputs[idx] = { ...NEUTRAL_INPUT });
      inputs[idx] = computeAiInput(this, k, ai, k.finished, out);
    }

    for (let idx = 0; idx < this.karts.length; idx++) updateKartItem(this, this.karts[idx]!, inputs[idx]!);
    for (let idx = 0; idx < this.karts.length; idx++) stepKart(this.karts[idx]!, inputs[idx]!, this.ctx);
    if (this.racing) {
      this.collideKarts();
      updateProjectiles(this);
      this.pickups();
      this.moverCollisions();
      this.progressAndLaps();
    }
    for (let idx = 0; idx < this.karts.length; idx++) {
      const k = this.karts[idx]!;
      k.prevDrift = inputs[idx]!.drift;
      k.prevItem = inputs[idx]!.item;
    }
    this.updatePositions();
    this.checkDone();
    this.tick++;
  }

  private resolveStarts(): void {
    for (const k of this.karts) {
      const st = k.throttleStartTick;
      if (st < 0) continue;
      if (st >= START_BOOST_PERFECT[0] && st < START_BOOST_PERFECT[1]) {
        applyBoost(k, PHYS.startBoostPerfect, 'start', this.ctx);
        this.events.push({ t: 'startBoost', kart: k.index, good: true });
      } else if (st >= START_BOOST_GOOD[0] && st < START_BOOST_GOOD[1]) {
        applyBoost(k, PHYS.startBoostGood, 'start', this.ctx);
        this.events.push({ t: 'startBoost', kart: k.index, good: false });
      } else if (st < START_STALL_BEFORE) {
        k.stallTime = 0.9;
        this.events.push({ t: 'stall', kart: k.index });
      }
    }
  }

  private collideKarts(): void {
    const ks = this.karts;
    const R2 = KART_RADIUS * 2;
    for (let a = 0; a < ks.length; a++) {
      const ka = ks[a]!;
      if (ka.respawnTime > 0) continue;
      for (let b = a + 1; b < ks.length; b++) {
        const kb = ks[b]!;
        if (kb.respawnTime > 0) continue;
        const dx = kb.x - ka.x, dz = kb.z - ka.z, dy = kb.y - ka.y;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R2 * R2 || dy * dy > 2.2 || d2 < 1e-8) continue;
        const dist = Math.sqrt(d2);
        const nx = dx / dist, nz = dz / dist;
        const overlap = R2 - dist;
        // immunity / power interactions
        const aPower = ka.starTime > 0 || ka.autopilotTime > 0;
        const bPower = kb.starTime > 0 || kb.autopilotTime > 0;
        if (aPower && !bPower) { hitAndDrop(this, kb, 'tumble', ka.index, ka.starTime > 0 ? 'star' : 'autopilot'); }
        else if (bPower && !aPower) { hitAndDrop(this, ka, 'tumble', kb.index, kb.starTime > 0 ? 'star' : 'autopilot'); }
        else if (ka.shrinkTime > 0 && kb.shrinkTime <= 0) hitAndDrop(this, ka, 'squash', kb.index, 'kart');
        else if (kb.shrinkTime > 0 && ka.shrinkTime <= 0) hitAndDrop(this, kb, 'squash', ka.index, 'kart');
        const ma = ka.mass * (ka.shrinkTime > 0 ? 0.4 : 1) * (aPower ? 6 : 1);
        const mb = kb.mass * (kb.shrinkTime > 0 ? 0.4 : 1) * (bPower ? 6 : 1);
        const inv = 1 / (ma + mb);
        ka.x -= nx * overlap * mb * inv; ka.z -= nz * overlap * mb * inv;
        kb.x += nx * overlap * ma * inv; kb.z += nz * overlap * ma * inv;
        const vrel = (kb.vx - ka.vx) * nx + (kb.vz - ka.vz) * nz;
        if (vrel < 0) {
          const j = -(1 + PHYS.kartRestitution) * vrel / (1 / ma + 1 / mb) + 1.2 * (ma * mb) * inv * 2;
          ka.vx -= nx * j / ma; ka.vz -= nz * j / ma;
          kb.vx += nx * j / mb; kb.vz += nz * j / mb;
          if (-vrel > 1.5) {
            this.events.push({ t: 'kartBump', a: ka.index, b: kb.index, impact: -vrel, x: ka.x + nx * KART_RADIUS, y: (ka.y + kb.y) / 2 + 0.5, z: ka.z + nz * KART_RADIUS });
          }
        }
      }
    }
  }

  private pickups(): void {
    const t = this.track;
    for (let bi = 0; bi < this.itemBoxes.length; bi++) {
      const box = this.itemBoxes[bi]!;
      if (!box.active) {
        box.timer -= DT;
        if (box.timer <= 0) box.active = true;
      }
    }
    for (let ci = 0; ci < this.coins.length; ci++) {
      const c = this.coins[ci]!;
      if (!c.active) {
        c.timer -= DT;
        if (c.timer <= 0) c.active = true;
      }
    }
    for (let ki = 0; ki < this.karts.length; ki++) {
      const k = this.karts[ki]!;
      if (k.respawnTime > 0) continue;
      for (let b = 0; b < this.itemBoxes.length; b++) {
        const box = this.itemBoxes[b]!;
        if (!box.active) continue;
        const dx = box.x - k.x, dz = box.z - k.z, dy = box.y - (k.y + 0.6);
        if (dx * dx + dz * dz < 2.1 * 2.1 && dy * dy < 3.2) {
          box.active = false;
          box.timer = PHYS.itemBoxRespawn;
          this.events.push({ t: 'itemBox', kart: k.index, x: box.x, y: box.y, z: box.z, box: b });
          grantItemBox(this, k);
        }
      }
      for (let ci = 0; ci < this.coins.length; ci++) {
        const c = this.coins[ci]!;
        if (!c.active) continue;
        const dx = c.x - k.x, dz = c.z - k.z, dy = c.y - (k.y + 0.6);
        if (dx * dx + dz * dz < 1.7 * 1.7 && dy * dy < 3.2) {
          c.active = false;
          c.timer = PHYS.coinRespawn;
          const total = addCoins(k, 1);
          const fx = dsin(k.yaw), fz = dcos(k.yaw);
          k.vx += fx * 0.7; k.vz += fz * 0.7;
          this.events.push({ t: 'coin', kart: k.index, x: c.x, y: c.y, z: c.z, coins: total });
        }
      }
      if (this.padCooldown[ki]! > 0) this.padCooldown[ki]! -= DT;
      if (k.grounded) {
        for (let pi = 0; pi < t.boostPads.length; pi++) {
          const pad = t.boostPads[pi]!;
          if (Math.abs(deltaS(t, k.s, pad.s)) < 2.6 && Math.abs(k.d - pad.d) < 2.7) {
            if (this.padCooldown[ki]! <= 0) {
              applyBoost(k, PHYS.padBoostTime, 'pad', this.ctx);
              this.padCooldown[ki] = 0.35;
            } else k.boostTime = Math.max(k.boostTime, PHYS.padBoostTime * 0.8);
          }
        }
      }
    }
  }

  private moverCollisions(): void {
    const movers = this.track.movers;
    for (let m = 0; m < movers.length; m++) {
      const mv = movers[m]!;
      const p = this.moverPosition(m);
      const r = mv.radius + KART_RADIUS;
      // long vehicles collide as a capsule along their heading
      const half = MOVER_HALF_LENGTH[mv.look] ?? 0;
      const hx = dsin(p.yaw) * half, hz = dcos(p.yaw) * half;
      for (const k of this.karts) {
        if (k.respawnTime > 0) continue;
        let cx = p.x, cz = p.z;
        if (half > 0) {
          const tt = Math.max(-1, Math.min(1, ((k.x - p.x) * hx + (k.z - p.z) * hz) / (half * half)));
          cx = p.x + hx * tt; cz = p.z + hz * tt;
        }
        const dx = k.x - cx, dz = k.z - cz, dy = k.y - p.y;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r || dy * dy > 6) continue;
        const dist = Math.sqrt(d2) || 1e-3;
        const nx = dx / dist, nz = dz / dist;
        k.x = cx + nx * r; k.z = cz + nz * r;
        const vn = k.vx * nx + k.vz * nz;
        if (vn < 0) { k.vx -= nx * vn; k.vz -= nz * vn; }
        k.vx += nx * 2.5; k.vz += nz * 2.5;
        if (k.starTime > 0 || k.autopilotTime > 0) continue;
        hitAndDrop(this, k, HARD_LOOKS.has(mv.look) ? 'tumble' : 'spin', -1, 'mover');
      }
    }
  }

  private progressAndLaps(): void {
    const L = this.track.length;
    const rt = this.tick - COUNTDOWN_TICKS + 1;
    for (let idx = 0; idx < this.karts.length; idx++) {
      const k = this.karts[idx]!;
      // wrong way
      if (!k.finished && k.grounded && k.respawnTime <= 0) {
        const i = k.ti;
        const fx = dsin(k.yaw), fz = dcos(k.yaw);
        const align = fx * this.track.tx[i]! + fz * this.track.tz[i]!;
        const moving = Math.abs(k.speed) > 4;
        const backwards = moving && (k.speed > 0 ? align < -0.35 : align > 0.35);
        if (backwards) this.wrongWayTimer[idx]! += DT; else this.wrongWayTimer[idx] = Math.max(0, this.wrongWayTimer[idx]! - DT * 3);
        const ww = this.wrongWayTimer[idx]! > 0.9;
        if (ww !== k.wrongWay) {
          k.wrongWay = ww;
          this.events.push({ t: 'wrongWay', kart: k.index, on: ww });
        }
      }
      if (k.finished) continue;
      const lapNow = k.progress < 0 ? 0 : Math.floor(k.progress / L) + 1;
      if (lapNow > k.lap) {
        if (k.lap >= 1) {
          const lt = rt - k.lapStartTick;
          k.lapTicks.push(lt);
          k.lapStartTick = rt;
          if (lapNow <= this.laps) this.events.push({ t: 'lap', kart: k.index, lap: lapNow, lapTicks: lt });
        }
        k.lap = lapNow;
        if (lapNow === this.laps && this.laps > 1) this.events.push({ t: 'finalLap', kart: k.index });
        if (lapNow > this.laps) {
          k.finished = true;
          k.finishTick = rt;
          k.lap = this.laps;
          this.finishCount++;
          k.position = this.finishCount;
          this.events.push({ t: 'finish', kart: k.index, position: this.finishCount, ticks: rt });
          if (k.human >= 0) this.lastHumanFinishTick = this.tick;
        }
      }
    }
  }

  private updatePositions(): void {
    const order = [...this.karts].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTick - b.finishTick || a.index - b.index;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress || a.index - b.index;
    });
    for (let r = 0; r < order.length; r++) {
      const k = order[r]!;
      const pos = r + 1;
      if (k.position !== pos) {
        if (this.phase !== 'countdown') this.events.push({ t: 'position', kart: k.index, from: k.position, to: pos });
        k.position = pos;
      }
    }
  }

  private checkDone(): void {
    if (this.phase !== 'racing') return;
    const humans = this.karts.filter(k => k.human >= 0);
    const allKarts = this.karts.every(k => k.finished);
    const humansDone = humans.length > 0 ? humans.every(k => k.finished) : allKarts;
    if (!humansDone) return;
    const graceTicks = 6 * TICK_HZ;
    if (allKarts || this.config.mode === 'tt' || (this.lastHumanFinishTick >= 0 && this.tick - this.lastHumanFinishTick >= graceTicks)) {
      this.phase = 'done';
      this.doneTick = this.tick;
      this.events.push({ t: 'raceDone' });
    }
  }

  /** Final (or live) results in position order. Unfinished karts get an estimate. */
  results(): RaceResult[] {
    const L = this.track.length;
    const rt = this.raceTicks();
    const rows = this.karts.map(k => {
      let ticks = k.finishTick;
      let estimated = false;
      if (!k.finished) {
        const remaining = Math.max(0, this.laps * L - k.progress);
        const pace = Math.max(8, k.maxSpeed * 0.86);
        ticks = rt + Math.round((remaining / pace) * TICK_HZ);
        estimated = true;
      }
      const best = k.lapTicks.length ? Math.min(...k.lapTicks) : 0;
      return { kart: k.index, charId: k.charId, human: k.human, position: 0, ticks, estimated, lapTicks: [...k.lapTicks], bestLapTicks: best };
    });
    rows.sort((a, b) => {
      const ka = this.karts[a.kart]!, kb = this.karts[b.kart]!;
      if (ka.finished !== kb.finished) return ka.finished ? -1 : 1;
      return a.ticks - b.ticks || a.kart - b.kart;
    });
    rows.forEach((r, i) => { r.position = i + 1; });
    return rows;
  }
}
