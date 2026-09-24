import type { TrackDef } from '../types.js';
import { TRACK_CATALOG } from './catalog.js';
import { sunnyMeadow } from './sunny-meadow.js';
import { palmBeach } from './palm-beach.js';
import { canyonRally } from './canyon-rally.js';
import { neonCity } from './neon-city.js';
import { frostPeak } from './frost-peak.js';
import { jungleRuins } from './jungle-ruins.js';
import { lavaFortress } from './lava-fortress.js';
import { starlightRoad } from './starlight-road.js';

/** Every playable track definition, in catalog order. */
const ALL: TrackDef[] = [
  sunnyMeadow, palmBeach, canyonRally, neonCity,
  frostPeak, jungleRuins, lavaFortress, starlightRoad,
];

export const TRACK_DEFS: readonly TrackDef[] = TRACK_CATALOG
  .map(meta => ALL.find(d => d.id === meta.id))
  .filter((d): d is TrackDef => !!d);

export function hasTrackDef(id: string): boolean {
  return TRACK_DEFS.some(d => d.id === id);
}

export function getTrackDef(id: string): TrackDef {
  const def = TRACK_DEFS.find(d => d.id === id);
  if (!def) throw new Error(`Unknown track ${id}`);
  return def;
}
