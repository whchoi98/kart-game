/**
 * Headless race diagnostics: runs full CPU races and a bot time trial per track.
 *   npx tsx tools/sim-report.ts [trackId ...] [--cc 150] [--level hard]
 */
import { CHARACTER_IDS } from '../src/sim/characters.js';
import { COUNTDOWN_TICKS } from '../src/sim/constants.js';
import { computeAiInput, createAiState } from '../src/sim/ai.js';
import { InputRecorder } from '../src/sim/input-log.js';
import { RaceWorld } from '../src/sim/race.js';
import { createTimeTrialConfig, verifyTimeTrial } from '../src/sim/replay.js';
import { Rng } from '../src/sim/rng.js';
import { TRACK_DEFS } from '../src/sim/tracks/index.js';
import type { CpuLevel, RaceEvent, SpeedClass } from '../src/sim/types.js';

const fmt = (ticks: number) => {
  const ms = Math.round(ticks * 1000 / 60);
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
};

export function runCpuRace(trackId: string, cc: SpeedClass, level: CpuLevel, seed: number) {
  const world = new RaceWorld({
    trackId, mode: 'vs', cc, cpuLevel: level, mirror: false, items: true, seed,
    racers: CHARACTER_IDS.map(charId => ({ charId, human: -1 })),
  });
  const counts: Record<string, number> = {};
  const maxTicks = COUNTDOWN_TICKS + 60 * 60 * 6;
  while (world.phase !== 'done' && world.tick < maxTicks) {
    world.step([]);
    for (const e of world.drainEvents()) counts[e.t] = (counts[e.t] ?? 0) + 1;
  }
  return { world, counts };
}

/** A bot time trial: CPU logic drives a 'human' kart; the log is then verified. */
export function runBotTimeTrial(trackId: string, cc: SpeedClass, charId = CHARACTER_IDS[4]!) {
  const world = new RaceWorld(createTimeTrialConfig(trackId, cc, charId));
  const kart = world.karts[0]!;
  const ai = createAiState(new Rng(99), 'hard');
  const rec = new InputRecorder();
  const maxTicks = COUNTDOWN_TICKS + 60 * 60 * 6;
  const events: RaceEvent[] = [];
  while (!kart.finished && world.tick < maxTicks) {
    const scale = kart.speedScale;
    const input = computeAiInput(world, kart, ai);
    kart.speedScale = scale; // humans are never rubber-banded
    rec.push(input);
    world.step([input]);
    events.push(...world.drainEvents());
  }
  const log = rec.encode();
  const verified = verifyTimeTrial({ trackId, cc, charId, log });
  return { world, kart, log, verified, events };
}

function main(): void {
  const args = process.argv.slice(2);
  const ccIdx = args.indexOf('--cc');
  const cc = (ccIdx >= 0 ? Number(args[ccIdx + 1]) : 150) as SpeedClass;
  const lvIdx = args.indexOf('--level');
  const level = (lvIdx >= 0 ? args[lvIdx + 1] : 'hard') as CpuLevel;
  const ids = args.filter((a, i) => !a.startsWith('--') && !['--cc', '--level'].includes(args[i - 1] ?? ''));
  const defs = ids.length ? TRACK_DEFS.filter(d => ids.includes(d.id)) : TRACK_DEFS;
  for (const def of defs) {
    const t0 = performance.now();
    const { world, counts } = runCpuRace(def.id, cc, level, 12345);
    const ms = performance.now() - t0;
    console.log(`\n■ ${def.id} ${cc}cc ${level} — ${world.tick} ticks simulated in ${ms.toFixed(0)} ms, phase ${world.phase}`);
    for (const r of world.results()) {
      const k = world.karts[r.kart]!;
      console.log(`  ${r.position}. ${k.charId.padEnd(6)} ${fmt(r.ticks)}${r.estimated ? ' (est)' : ''}  laps ${r.lapTicks.map(fmt).join(' / ')}  coins ${k.coins}`);
    }
    console.log('  events:', JSON.stringify(counts));
    const tt = runBotTimeTrial(def.id, cc);
    console.log(`  bot TT: finished=${tt.kart.finished} ${fmt(tt.kart.finishTick)} laps ${tt.kart.lapTicks.map(fmt).join(' / ')}  log ${tt.log.length} B  verify=${JSON.stringify(tt.verified.ok ? { ok: true, ticks: tt.verified.ticks } : tt.verified)}`);
    const walls = tt.events.filter(e => e.t === 'wall').length;
    const drifts = tt.events.filter(e => e.t === 'boost' && (e.kind === 'mini1' || e.kind === 'mini2' || e.kind === 'mini3')).length;
    console.log(`  bot TT: walls ${walls}, mini-turbos ${drifts}, falls ${tt.events.filter(e => e.t === 'fall').length}`);
  }
}

if (process.argv[1]?.endsWith('sim-report.ts')) main();
