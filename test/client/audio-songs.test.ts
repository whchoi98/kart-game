import { describe, expect, it } from 'vitest';
import { TRACK_CATALOG } from '../../src/sim/tracks/catalog.js';
import { ALL_SONGS, MENU_CUES, SONGS, STAR_SONG, TRACK_SONGS, resolveCue } from '../../src/client/audio/songs/index.js';
import { bodyBars, compileSong, PART_RANGES, type SongDef } from '../../src/client/audio/pattern.js';
import { parseChord, parseNote, parsePitchClass, pcOf, scalePitchClasses, voiceLead } from '../../src/client/audio/theory.js';

const SPEC: Record<string, { bpm: number; tonic: string; mode: SongDef['mode'] }> = {
  'sunny-meadow': { bpm: 150, tonic: 'c', mode: 'major' },
  'palm-beach': { bpm: 128, tonic: 'f', mode: 'major' },
  'canyon-rally': { bpm: 140, tonic: 'e', mode: 'minor' },
  'neon-city': { bpm: 124, tonic: 'a', mode: 'minor' },
  'frost-peak': { bpm: 132, tonic: 'd', mode: 'major' },
  'jungle-ruins': { bpm: 136, tonic: 'g', mode: 'minor' },
  'lava-fortress': { bpm: 160, tonic: 'c', mode: 'minor' },
  'starlight-road': { bpm: 146, tonic: 'eb', mode: 'lydian' },
  title: { bpm: 120, tonic: 'g', mode: 'major' },
  menu: { bpm: 108, tonic: 'a', mode: 'major' },
};

describe('theory helpers', () => {
  it('parses notes, pitch classes and chords', () => {
    expect(parseNote('c4')).toBe(60);
    expect(parseNote('a4')).toBe(69);
    expect(parseNote('f#3')).toBe(54);
    expect(parseNote('bb5')).toBe(82);
    expect(parseNote('h2')).toBeNull();
    expect(parsePitchClass('eb')).toBe(3);
    const c = parseChord('F#m7')!;
    expect([...c.pcs].sort((a, b) => a - b)).toEqual([1, 4, 6, 9]);
    expect(parseChord('C/E')!.bass).toBe(4);
    expect(parseChord('Bbmaj7')!.root).toBe(10);
    expect(parseChord('Xm')).toBeNull();
  });

  it('voice-leads pads with small motion', () => {
    const a = voiceLead(parseChord('C')!, null, 55, 77);
    const b = voiceLead(parseChord('F')!, a, 55, 77);
    const motion = b.reduce((s, n) => s + Math.min(...a.map(p => Math.abs(p - n))), 0);
    expect(motion).toBeLessThanOrEqual(4);
    for (const n of b) expect(parseChord('F')!.pcs.has(pcOf(n))).toBe(true);
  });
});

describe('song catalogue', () => {
  it('has a song for every track in the catalog', () => {
    expect(TRACK_CATALOG).toHaveLength(8);
    for (const t of TRACK_CATALOG) {
      expect(SONGS[t.id], t.id).toBeDefined();
      expect(SONGS[t.id]!.id).toBe(t.id);
    }
    expect(TRACK_SONGS.map(s => s.id).sort()).toEqual(TRACK_CATALOG.map(t => t.id).sort());
  });

  it('has every menu cue and falls back to the menu theme', () => {
    for (const cue of MENU_CUES) expect(SONGS[cue]?.id).toBe(cue);
    expect(resolveCue('does-not-exist').id).toBe('menu');
    expect(resolveCue('toString').id).toBe('menu');
    expect(resolveCue('neon-city').id).toBe('neon-city');
  });

  it('matches the tempo and key brief', () => {
    for (const [id, spec] of Object.entries(SPEC)) {
      const s = SONGS[id]!;
      expect(s.bpm, id).toBe(spec.bpm);
      expect(s.tonic, id).toBe(spec.tonic);
      expect(s.mode, id).toBe(spec.mode);
    }
  });

  it('uses original titles (no borrowed branding)', () => {
    for (const s of ALL_SONGS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.title).not.toMatch(/mario|kart|nintendo|rainbow road|koopa|bowser|luigi|peach/i);
    }
  });
});

describe.each(ALL_SONGS.map(s => [s.id, s] as const))('song %s', (_id, song) => {
  const c = compileSong(song);

  it('compiles without validation errors', () => {
    expect(c.errors).toEqual([]);
  });

  it('has bar-aligned sections and a sensible length', () => {
    expect(c.totalSteps % 16).toBe(0);
    expect(c.loopStart % 16).toBe(0);
    for (const name of [...song.intro, ...song.body]) {
      const sec = song.sections[name]!;
      expect(sec, name).toBeDefined();
      expect(Number.isInteger(sec.bars) && sec.bars > 0).toBe(true);
    }
    const bars = bodyBars(song);
    if (TRACK_SONGS.includes(song) || song.id === 'title' || song.id === 'menu') {
      expect(song.intro.length).toBeGreaterThanOrEqual(1);
      expect(song.body.length).toBeGreaterThanOrEqual(2); // A + B (+ variations)
      expect(bars).toBeGreaterThanOrEqual(16);
      expect(bars).toBeLessThanOrEqual(32);
      expect(song.loop).toBe(true);
    } else if (song.id === 'results' || song.id === 'podium') {
      expect(song.loop).toBe(true);
      expect(bars).toBeGreaterThanOrEqual(8);
      if (song.id === 'podium') expect(song.intro.length).toBe(1); // fanfare first
    } else if (song.id === 'gameover') {
      expect(song.loop).toBe(false);
      expect(c.totalSteps).toBeLessThanOrEqual(4 * 16);
    } else {
      expect(song).toBe(STAR_SONG);
      expect(song.loop).toBe(true);
    }
  });

  it('keeps every note inside its instrument range and the timeline', () => {
    for (const ev of c.events) {
      expect(ev.step).toBeGreaterThanOrEqual(0);
      expect(ev.step).toBeLessThan(c.totalSteps);
      expect(ev.dur).toBeGreaterThan(0);
      expect(ev.vel).toBeGreaterThan(0);
      expect(ev.vel).toBeLessThanOrEqual(1);
      if (ev.part === 'drums') {
        expect(ev.drum).not.toBeNull();
      } else {
        const [lo, hi] = PART_RANGES[ev.part];
        expect(ev.midi, `${ev.part} @${ev.step}`).toBeGreaterThanOrEqual(lo);
        expect(ev.midi, `${ev.part} @${ev.step}`).toBeLessThanOrEqual(hi);
      }
    }
    for (let s = 0; s < c.totalSteps; s++) expect(c.index[s]!).toBeLessThanOrEqual(c.index[s + 1]!);
  });

  it('keeps melodies in key (plus declared chromatic notes)', () => {
    const scale = scalePitchClasses(parsePitchClass(song.tonic)!, song.mode);
    const extra = new Set((song.chromatic ?? []).map(p => parsePitchClass(p)!));
    for (const ev of c.events) {
      if (ev.part !== 'lead' && ev.part !== 'counter') continue;
      const pc = pcOf(ev.midi);
      expect(scale.has(pc) || extra.has(pc), `${ev.part} midi ${ev.midi} @${ev.step}`).toBe(true);
    }
  });

  it('has melody, bass and drums, plus harmony', () => {
    const parts = new Set(c.events.map(e => e.part));
    expect(parts.has('lead') || parts.has('counter')).toBe(true);
    expect(parts.has('bass')).toBe(true);
    if (song.id !== 'gameover') expect(parts.has('drums')).toBe(true);
    expect(parts.has('pad') || parts.has('arp')).toBe(true);
    expect(c.chords.length).toBeGreaterThan(0);
  });

  it('provides a final-lap intensity layer aligned to the timeline', () => {
    expect(c.intensity.length).toBeGreaterThan(0);
    expect(c.intensity.some(e => e.drum === 'hat')).toBe(true);
    expect(c.intensity.some(e => e.part === 'extra')).toBe(true);
    for (const ev of c.intensity) expect(ev.step).toBeLessThan(c.totalSteps);
    expect(c.intensityIndex[c.totalSteps]).toBe(c.intensity.length);
  });
});

describe('pattern validator', () => {
  const base: SongDef = {
    id: 'test-bad', title: 'Validator Probe', bpm: 120, tonic: 'c', mode: 'major', loop: true,
    instruments: { lead: 'pulse', bass: 'tri', pad: 'soft', arp: 'pluck', kit: 'pop' },
    sections: { A: { bars: 1, chords: 'C', lead: 'c5:4 e5 g5 c6' } },
    intro: [], body: ['A'],
  };

  it('accepts a correct bar', () => {
    expect(compileSong(base).errors).toEqual([]);
  });

  it('rejects bars that do not add up to 16 steps', () => {
    const bad = { ...base, id: 'test-bad-bar', sections: { A: { bars: 1, chords: 'C', lead: 'c5:4 e5 g5' } } };
    expect(compileSong(bad).errors.join()).toMatch(/12 steps/);
  });

  it('rejects out-of-key notes and avoid-note clashes', () => {
    const off = { ...base, id: 'test-bad-key', sections: { A: { bars: 1, chords: 'C', lead: 'c#5:4 e5 g5 c6' } } };
    expect(compileSong(off).errors.join()).toMatch(/outside the scale/);
    const clash = { ...base, id: 'test-bad-clash', sections: { A: { bars: 1, chords: 'C', lead: 'f5:8 e5:8' } } };
    expect(compileSong(clash).errors.join()).toMatch(/clashes/);
  });

  it('rejects malformed chords, drum lanes and missing sections', () => {
    const bad = {
      ...base, id: 'test-bad-misc',
      sections: { A: { bars: 1, chords: 'Q7', drums: { k: 'x..' } } },
      body: ['A', 'B'],
    };
    const errs = compileSong(bad).errors.join('\n');
    expect(errs).toMatch(/bad chord/);
    expect(errs).toMatch(/not a multiple of 16/);
    expect(errs).toMatch(/missing section 'B'/);
  });
});

describe('star layer key matching', () => {
  it('transposes the star jingle into each track key so it never clashes', async () => {
    const { starTranspose } = await import('../../src/client/audio/sequencer.js');
    for (const track of TRACK_SONGS) {
      const d = starTranspose(track);
      expect(Math.abs(d)).toBeLessThanOrEqual(6);
      const trackScale = scalePitchClasses(parsePitchClass(track.tonic)!, track.mode);
      for (const ev of compileSong(STAR_SONG).events) {
        if (ev.part !== 'lead') continue;
        expect(trackScale.has(pcOf(ev.midi + d)), `${track.id} star note ${ev.midi + d}`).toBe(true);
      }
    }
  });
});
