/**
 * Pure logic behind fixes from the independent verification of the player-journey QA pass:
 *  - InputHold: results / podium screens swallow confirm / back / pause right after they appear,
 *    so mashing A / Enter (or drifting with Space = confirm) cannot skip the GP podium ceremony.
 */
import { describe, expect, it } from 'vitest';
import { GameStorage } from '../../src/client/storage.js';
import { InputHold } from '../../src/client/ui/input-hold.js';

describe('profile stats and field size', () => {
  const fresh = () => new GameStorage(null); // in-memory backend
  it('a solo run (1 racer) is neither a win nor a podium', () => {
    const s = fresh();
    s.recordRace({ position: 1, mode: 'vs', racers: 1 });
    expect(s.getStats()).toMatchObject({ races: 1, wins: 0, podiums: 0 });
  });

  it('a 2-player duel without CPUs can be won, but finishing is not a podium', () => {
    const s = fresh();
    s.recordRace({ position: 1, mode: 'duo', racers: 2 });
    s.recordRace({ position: 2, mode: 'duo', racers: 2 });
    s.recordRace({ position: 3, mode: 'vs', racers: 3 });
    expect(s.getStats()).toMatchObject({ races: 3, wins: 1, podiums: 0 });
  });

  it('a full grid counts wins and podiums as before (racers defaults to a full grid)', () => {
    const s = fresh();
    s.recordRace({ position: 1, mode: 'gp', racers: 8 });
    s.recordRace({ position: 3, mode: 'vs', racers: 4 });
    s.recordRace({ position: 2, mode: 'vs' });
    s.recordRace({ position: 4, mode: 'gp', racers: 8 });
    expect(s.getStats()).toMatchObject({ races: 4, wins: 1, podiums: 3 });
  });
});

describe('InputHold', () => {
  it('lets everything through before it is armed', () => {
    const h = new InputHold();
    expect(h.blocks('confirm', 0)).toBe(false);
    expect(h.blocks('back', 1e9)).toBe(false);
  });

  it('holds confirm / back / pause for the armed window only', () => {
    const h = new InputHold();
    h.arm(1500, 1000);
    for (const a of ['confirm', 'back', 'pause'] as const) {
      expect(h.blocks(a, 1000)).toBe(true);
      expect(h.blocks(a, 2499)).toBe(true);
      expect(h.blocks(a, 2500)).toBe(false);
    }
  });

  it('never holds movement or tab switching', () => {
    const h = new InputHold();
    h.arm(10_000, 0);
    for (const a of ['up', 'down', 'left', 'right', 'tabPrev', 'tabNext'] as const) expect(h.blocks(a, 1)).toBe(false);
  });

  it('re-arming restarts the window; a negative duration is no hold', () => {
    const h = new InputHold();
    h.arm(500, 0);
    h.arm(500, 400);
    expect(h.blocks('confirm', 850)).toBe(true);
    h.arm(-50, 1000);
    expect(h.blocks('confirm', 1000)).toBe(false);
  });
});
