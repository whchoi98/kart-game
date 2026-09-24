import { describe, expect, it } from 'vitest';
import { datan2, dcos, dexp, dsin } from '../../src/sim/dmath.js';
import { decodeInputWord, decodeLog, encodeInputWord, InputRecorder, quantizeInput } from '../../src/sim/input-log.js';
import { buildTrack } from '../../src/sim/track-builder.js';
import { pointAt, projectToTrack, surfaceAt } from '../../src/sim/track-query.js';
import { TRACK_DEFS } from '../../src/sim/tracks/index.js';
import { RaceWorld } from '../../src/sim/race.js';
import { verifyTimeTrial } from '../../src/sim/replay.js';
import { CHARACTER_IDS } from '../../src/sim/characters.js';
import { runBotTimeTrial, runCpuRace } from '../../tools/sim-report.js';
import { analyzeTrack } from '../../tools/track-report.js';

describe('deterministic math', () => {
  it('matches Math within 1e-10 over a wide range', () => {
    for (let a = -50; a <= 50; a += 0.0137) {
      expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-10);
      expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-10);
    }
    for (let y = -3; y <= 3; y += 0.173) {
      for (let x = -3; x <= 3; x += 0.191) {
        expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-10);
      }
    }
    for (let x = -12; x <= 3; x += 0.07) {
      expect(Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x)).toBeLessThan(1e-10);
    }
  });
});

describe('input log', () => {
  it('round-trips words and quantises steer to 1/63', () => {
    const i = { throttle: true, brake: false, steer: 0.5012, drift: true, item: false, back: true };
    const q = decodeInputWord(encodeInputWord(i));
    expect(q.throttle && q.drift && q.back && !q.brake && !q.item).toBe(true);
    expect(Math.abs(q.steer - 32 / 63)).toBeLessThan(1e-12);
    expect(quantizeInput(q)).toEqual(q);
    expect(decodeInputWord(encodeInputWord({ ...i, steer: NaN })).steer).toBe(0);
  });
  it('run-length encodes and decodes', () => {
    const rec = new InputRecorder();
    const seq: number[] = [];
    for (let t = 0; t < 5000; t++) {
      const inp = { throttle: t > 100, brake: false, steer: Math.round(Math.sin(t / 50) * 3) / 3, drift: t % 400 > 300, item: t === 900, back: false };
      rec.push(inp);
      seq.push(encodeInputWord(inp));
    }
    const words = decodeLog(rec.encode());
    expect(Array.from(words)).toEqual(seq);
  });
  it('rejects malformed logs', () => {
    expect(() => decodeLog('')).toThrow();
    expect(() => decodeLog('!!!!')).toThrow();
    expect(() => decodeLog('AQA=')).toThrow();
  });
});

describe('track builder', () => {
  it('all tracks pass geometric validation (normal and mirror)', () => {
    for (const def of TRACK_DEFS) {
      for (const mirror of [false, true]) {
        const t = buildTrack(def, { mirror });
        const rep = analyzeTrack(t);
        expect(rep.problems, `${def.id}${mirror ? ' mirror' : ''}`).toEqual([]);
        expect(t.grid).toHaveLength(8);
      }
    }
  });
  it('projects points back to the same arc length and offset', () => {
    const t = buildTrack(TRACK_DEFS[0]!);
    for (let s = 3; s < t.length; s += 37) {
      for (const d of [-5, 0, 4]) {
        const p = pointAt(t, s, d);
        const pr = projectToTrack(t, p.x, p.z, p.i, p.y);
        expect(Math.abs(pr.s - s)).toBeLessThan(0.05);
        expect(Math.abs(pr.d - d)).toBeLessThan(0.05);
        expect(surfaceAt(t, pr).onRoad).toBe(true);
      }
    }
  });
});

describe('race world', () => {
  it('eight CPU karts finish every track with sane lap times', () => {
    for (const def of TRACK_DEFS) {
      const { world, counts } = runCpuRace(def.id, 150, 'hard', 777);
      expect(world.phase, def.id).toBe('done');
      const results = world.results();
      expect(results.every(r => !r.estimated), def.id).toBe(true);
      for (const r of results) {
        for (const lap of r.lapTicks) {
          const sec = lap / 60;
          expect(sec, `${def.id} lap`).toBeGreaterThan(12);
          expect(sec, `${def.id} lap`).toBeLessThan(90);
        }
      }
      expect(counts.lap).toBe(16);
      expect(counts.finish).toBe(8);
    }
  });

  it('is deterministic for identical seeds', () => {
    const a = runCpuRace(TRACK_DEFS[0]!.id, 100, 'normal', 4242).world;
    const b = runCpuRace(TRACK_DEFS[0]!.id, 100, 'normal', 4242).world;
    expect(a.tick).toBe(b.tick);
    expect(a.karts.map(k => [k.x, k.z, k.finishTick])).toEqual(b.karts.map(k => [k.x, k.z, k.finishTick]));
  });

  it('counts laps only forward and flags wrong way', () => {
    const w = new RaceWorld({
      trackId: TRACK_DEFS[0]!.id, mode: 'vs', cc: 100, cpuLevel: 'easy', mirror: false, items: false, seed: 1,
      racers: [{ charId: CHARACTER_IDS[0]!, human: 0 }],
    });
    const back = { throttle: false, brake: true, steer: 0, drift: false, item: false, back: false };
    let wrongWay = false;
    for (let t = 0; t < 180 + 60 * 6; t++) {
      w.step([back]);
      for (const e of w.drainEvents()) if (e.t === 'wrongWay' && e.on) wrongWay = true;
    }
    expect(w.karts[0]!.lap).toBe(0);
    expect(w.karts[0]!.progress).toBeLessThan(0);
    // travelling against the course (even in reverse gear) is flagged
    expect(wrongWay).toBe(true);
  });
});

describe('time-trial verification', () => {
  it('accepts an honest bot run and rejects tampering', () => {
    const def = TRACK_DEFS[0]!;
    const run = runBotTimeTrial(def.id, 150);
    expect(run.kart.finished).toBe(true);
    expect(run.verified.ok).toBe(true);
    if (!run.verified.ok) return;
    expect(run.verified.ticks).toBe(run.kart.finishTick);
    expect(run.verified.lapTicks).toEqual(run.kart.lapTicks);
    // wrong character or class changes physics → different or failed result
    const other = verifyTimeTrial({ trackId: def.id, cc: 150, charId: run.kart.charId === 'bruno' ? 'pip' : 'bruno', log: run.log });
    expect(other.ok && other.ticks === run.verified.ticks).toBe(false);
    // truncated log does not finish
    const words = decodeLog(run.log);
    const rec = new InputRecorder();
    for (let i = 0; i < words.length - 120; i++) rec.push(decodeInputWord(words[i]!));
    expect(verifyTimeTrial({ trackId: def.id, cc: 150, charId: run.kart.charId, log: rec.encode() }).ok).toBe(false);
    // extra ticks after the finish are rejected
    const rec2 = new InputRecorder();
    for (let i = 0; i < words.length; i++) rec2.push(decodeInputWord(words[i]!));
    for (let i = 0; i < 30; i++) rec2.push(decodeInputWord(words[words.length - 1]!));
    expect(verifyTimeTrial({ trackId: def.id, cc: 150, charId: run.kart.charId, log: rec2.encode() }).ok).toBe(false);
  });
});
