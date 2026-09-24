import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../../src/sim/characters.js';
import { RaceWorld } from '../../src/sim/race.js';
import { HudModel } from '../../src/client/game/hud-model.js';

describe('HudModel', () => {
  it('tracks countdown, GO timeout, positions and toasts', () => {
    const world = new RaceWorld({
      trackId: 'sunny-meadow', mode: 'vs', cc: 150, cpuLevel: 'normal', mirror: false, items: true, seed: 5,
      racers: CHARACTER_IDS.map((charId, i) => ({ charId, human: i === 7 ? 0 : -1 })),
    });
    const hud = new HudModel(world, [7]);
    hud.onEvents(world.drainEvents(), null);
    expect(hud.snapshot(0, false)!.countdown).toBe(3);
    expect(hud.snapshot(0, true)!.phase).toBe('intro');
    const perfect = { throttle: false, brake: false, steer: 0, drift: false, item: false, back: false };
    for (let t = 0; t < 181; t++) {
      world.step([{ ...perfect, throttle: t >= 135 }]);
      hud.onEvents(world.drainEvents(), null);
      hud.advance(1 / 60);
    }
    const s = hud.snapshot(0, false)!;
    expect(s.countdown).toBe(0);
    expect(s.toast?.text).toBe('완벽한 스타트!');
    expect(s.racers).toBe(8);
    expect(s.standings).toHaveLength(8);
    for (let t = 0; t < 90; t++) hud.advance(1 / 60);
    expect(hud.snapshot(0, false)!.countdown).toBeNull();
    expect(hud.snapshot(1, false)).toBeNull();
  });
});
