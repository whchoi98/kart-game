/**
 * Pure HUD bookkeeping: turns RaceEvents + world state into HudSnapshots.
 * Kept free of three.js/DOM so it can be unit tested.
 */
import { COUNTDOWN_TICKS, SPEED_DISPLAY_FACTOR, TICK_HZ } from '../../sim/constants.js';
import type { RaceWorld } from '../../sim/race.js';
import type { KartState, RaceEvent } from '../../sim/types.js';
import type { HudSnapshot } from '../contracts.js';

const ticksToMs = (t: number) => Math.round((t * 1000) / TICK_HZ);

interface PlayerHud {
  kart: number;
  toast: HudSnapshot['toast'];
  toastUntil: number;
  finalLapUntil: number;
  ink: number;
  ghostDeltaMs: number | null;
  /** Lap the shown ghost split belongs to: a late-resolving older split never replaces a newer one. */
  splitLap: number;
  /** Laps completed by the player awaiting the ghost's split: lap → player cumulative ticks. */
  pendingSplits: Map<number, number>;
}

export class HudModel {
  private players: PlayerHud[];
  private countdown: 3 | 2 | 1 | 0 | null = null;
  private goUntil = 0;
  private toastSeq = 1;
  private time = 0;

  /** Time trial: race ticks of the run the ghost replays (GhostData.ticks), known before it crosses the line. */
  private readonly ghostTicks: number | null;

  /** `ghostKart`: the time-trial ghost's live kart state (read on every snapshot for the minimap), or null. */
  constructor(
    private readonly world: RaceWorld, humanKarts: readonly number[], ghostTicks: number | null = null,
    private readonly ghostKart: Readonly<Pick<KartState, 'x' | 'z' | 'charId'>> | null = null,
  ) {
    this.ghostTicks = ghostTicks !== null && Number.isInteger(ghostTicks) && ghostTicks > 0 ? ghostTicks : null;
    this.players = humanKarts.map(kart => ({
      kart, toast: null, toastUntil: 0, finalLapUntil: 0, ink: 0, ghostDeltaMs: null, splitLap: 0, pendingSplits: new Map(),
    }));
  }

  private split(p: PlayerHud, lap: number, deltaTicks: number): void {
    if (lap < p.splitLap) return;
    p.splitLap = lap;
    p.ghostDeltaMs = ticksToMs(deltaTicks);
  }

  private toast(kart: number, text: string, tone: 'good' | 'bad' | 'info', seconds = 1.6): void {
    for (const p of this.players) {
      if (p.kart !== kart) continue;
      p.toast = { text, tone, id: this.toastSeq++ };
      p.toastUntil = this.time + seconds;
    }
  }

  /** Feed the events of this frame; `ghostLapTicks` = the ghost's completed lap durations (time trial). */
  onEvents(events: readonly RaceEvent[], ghostLapTicks: readonly number[] | null): void {
    for (const e of events) {
      switch (e.t) {
        case 'countdown':
          this.countdown = e.n;
          if (e.n === 0) this.goUntil = this.time + 1.1;
          break;
        case 'startBoost':
          this.toast(e.kart, e.good ? '완벽한 스타트!' : '굿 스타트!', 'good');
          break;
        case 'stall':
          this.toast(e.kart, '엔진 과열! 너무 일찍 밟았어요', 'bad', 2);
          break;
        case 'finalLap':
          for (const p of this.players) if (p.kart === e.kart) p.finalLapUntil = this.time + 2.8;
          break;
        case 'lap': {
          const p = this.players.find(q => q.kart === e.kart);
          if (!p) break;
          this.toast(e.kart, `랩 ${e.lap} / ${this.world.laps}`, 'info', 1.4);
          if (ghostLapTicks) {
            const k = this.world.karts[e.kart]!;
            const mine = k.lapTicks.reduce((a, b) => a + b, 0);
            const n = k.lapTicks.length;
            if (ghostLapTicks.length >= n) {
              const g = ghostLapTicks.slice(0, n).reduce((a, b) => a + b, 0);
              this.split(p, n, mine - g);
            } else p.pendingSplits.set(n, mine);
          }
          break;
        }
        case 'blocked':
          this.toast(e.kart, '방어 성공!', 'good', 1.2);
          break;
        case 'trick':
          this.toast(e.kart, '트릭!', 'good', 0.9);
          break;
        case 'hit':
          if (e.kind !== 'bump' && e.source === 'thunder') this.toast(e.kart, '번개에 맞았어요!', 'bad', 1.4);
          break;
        case 'fall':
          this.toast(e.kart, '코스 이탈!', 'bad', 1.4);
          break;
        case 'finish': {
          const p = this.players.find(q => q.kart === e.kart);
          if (p && ghostLapTicks) {
            const laps = this.world.laps;
            if (ghostLapTicks.length >= laps) this.split(p, laps, e.ticks - ghostLapTicks.slice(0, laps).reduce((a, b) => a + b, 0));
            else {
              // beat the ghost to the line: its total is known up front, so the final split shows at the
              // line (the celebration can end long before a slow ghost arrives); the ghost's own crossing
              // re-resolves it from its lap times (the same value unless its replay desynced)
              if (this.ghostTicks !== null) this.split(p, laps, e.ticks - this.ghostTicks);
              p.pendingSplits.set(laps, e.ticks);
            }
          }
          break;
        }
        default:
          break;
      }
    }
    // resolve ghost splits that arrived after the player's
    if (ghostLapTicks) {
      for (const p of this.players) {
        for (const [n, mine] of p.pendingSplits) {
          if (ghostLapTicks.length >= n) {
            this.split(p, n, mine - ghostLapTicks.slice(0, n).reduce((a, b) => a + b, 0));
            p.pendingSplits.delete(n);
          }
        }
      }
    }
  }

  advance(dt: number): void {
    this.time += dt;
    for (const p of this.players) {
      if (p.toast && this.time > p.toastUntil) p.toast = null;
      const k = this.world.karts[p.kart]!;
      const target = k.inkTime > 0 ? Math.min(1, k.inkTime / 1.2) : 0;
      p.ink += (target - p.ink) * Math.min(1, dt * (target > p.ink ? 10 : 3));
    }
    if (this.countdown === 0 && this.time > this.goUntil) this.countdown = null;
  }

  inkAmount(player: number): number {
    return this.players[player]?.ink ?? 0;
  }

  snapshot(player: number, introActive: boolean): HudSnapshot | null {
    const p = this.players[player];
    if (!p) return null;
    const w = this.world;
    const k = w.karts[p.kart]!;
    const rt = w.raceTicks();
    const lapStart = k.lapStartTick;
    const phase: HudSnapshot['phase'] = introActive ? 'intro' : k.finished ? 'finished' : w.tick < COUNTDOWN_TICKS ? 'countdown' : 'racing';
    const lapMs = k.lapTicks.map(ticksToMs);
    return {
      player,
      kart: p.kart,
      charId: k.charId,
      phase,
      countdown: introActive ? null : this.countdown,
      position: k.position,
      racers: w.karts.length,
      lap: Math.min(w.laps, Math.max(1, k.lap)),
      laps: w.laps,
      raceMs: ticksToMs(k.finished ? k.finishTick : rt),
      currentLapMs: k.finished ? 0 : ticksToMs(Math.max(0, rt - lapStart)),
      lapMs,
      bestLapMs: lapMs.length ? Math.min(...lapMs) : null,
      item: k.item,
      itemUses: k.itemUses,
      roulette: k.rouletteTime > 0,
      coins: k.coins,
      speedKmh: Math.round(Math.abs(k.speed) * SPEED_DISPLAY_FACTOR),
      driftLevel: k.driftDir !== 0 ? k.driftLevel : 0,
      boosting: k.boostTime > 0,
      starActive: k.starTime > 0,
      shrunk: k.shrinkTime > 0,
      wrongWay: k.wrongWay && !k.finished,
      ink: p.ink,
      finalLapBanner: this.time < p.finalLapUntil,
      finished: k.finished,
      finishPosition: k.finished ? k.position : null,
      ghostDeltaMs: p.ghostDeltaMs,
      toast: p.toast,
      standings: [...w.karts]
        .sort((a, b) => a.position - b.position)
        .map(o => ({ kart: o.index, charId: o.charId, human: o.human, position: o.position, finished: o.finished })),
      minimap: {
        karts: w.karts.map(o => ({ x: o.x, z: o.z, charId: o.charId, human: o.human, position: o.position, kart: o.index })),
        projectiles: w.projectiles.map(pr => ({ x: pr.x, z: pr.z, kind: pr.kind })),
        ghost: this.ghostKart ? { x: this.ghostKart.x, z: this.ghostKart.z, charId: this.ghostKart.charId } : null,
      },
    };
  }
}
