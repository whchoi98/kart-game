/**
 * Song registry. Every track id from the course catalog has its own theme; menu cues
 * cover the title screen, menus, results, podium and the game-over sting.
 */
import type { SongDef } from '../pattern.js';
import { SUNNY_MEADOW } from './sunny-meadow.js';
import { PALM_BEACH } from './palm-beach.js';
import { CANYON_RALLY } from './canyon-rally.js';
import { NEON_CITY } from './neon-city.js';
import { FROST_PEAK } from './frost-peak.js';
import { JUNGLE_RUINS } from './jungle-ruins.js';
import { LAVA_FORTRESS } from './lava-fortress.js';
import { STARLIGHT_ROAD } from './starlight-road.js';
import { TITLE } from './title.js';
import { MENU } from './menu.js';
import { RESULTS } from './results.js';
import { PODIUM } from './podium.js';
import { GAMEOVER } from './gameover.js';
import { STAR } from './star.js';

export const TRACK_SONGS: readonly SongDef[] = [
  SUNNY_MEADOW, PALM_BEACH, CANYON_RALLY, NEON_CITY, FROST_PEAK, JUNGLE_RUINS, LAVA_FORTRESS, STARLIGHT_ROAD,
];

export const MENU_CUES = ['title', 'menu', 'results', 'podium', 'gameover'] as const;
export type MenuCueId = typeof MENU_CUES[number];

export const MENU_SONGS: Record<MenuCueId, SongDef> = {
  title: TITLE, menu: MENU, results: RESULTS, podium: PODIUM, gameover: GAMEOVER,
};

/** Power-up layer played over the track music while a human has the Super Star. */
export const STAR_SONG: SongDef = STAR;

/** Every playable cue id → song. */
export const SONGS: Readonly<Record<string, SongDef>> = Object.freeze({
  ...Object.fromEntries(TRACK_SONGS.map(s => [s.id, s])),
  ...MENU_SONGS,
});

/** Resolve a music cue; unknown cues fall back to the menu theme. */
export function resolveCue(cue: string): SongDef {
  return Object.prototype.hasOwnProperty.call(SONGS, cue) ? SONGS[cue]! : MENU;
}

export const ALL_SONGS: readonly SongDef[] = [...TRACK_SONGS, ...Object.values(MENU_SONGS), STAR];
