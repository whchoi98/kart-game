/** Setup-memory restore after an update reload (pure; unit tested). */
import { isCharacterId } from '../../sim/characters.js';
import { CUPS, TRACK_CATALOG } from '../../sim/tracks/catalog.js';
import type { CpuLevel, CupId, SpeedClass } from '../../sim/types.js';
import type { SetupMemory } from './app.js';

const SPEED_CLASSES: readonly SpeedClass[] = [50, 100, 150, 200];
const CPU_LEVELS: readonly CpuLevel[] = ['easy', 'normal', 'hard'];

/** Restore setup choices saved before an update reload; anything unknown keeps the default. */
export function restoreMemory(target: SetupMemory, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const r = raw as Record<string, unknown>;
  const cc = (v: unknown) => SPEED_CLASSES.includes(v as SpeedClass);
  const track = (v: unknown) => typeof v === 'string' && TRACK_CATALOG.some(t => t.id === v);
  if (cc(r.cc)) target.cc = r.cc as SpeedClass;
  if (cc(r.ttCc)) target.ttCc = r.ttCc as SpeedClass;
  if (cc(r.lbCc)) target.lbCc = r.lbCc as SpeedClass;
  if (CPU_LEVELS.includes(r.cpuLevel as CpuLevel)) target.cpuLevel = r.cpuLevel as CpuLevel;
  if (typeof r.mirror === 'boolean') target.mirror = r.mirror;
  if (typeof r.items === 'boolean') target.items = r.items;
  if (isCharacterId(r.charId)) target.charId = r.charId;
  if (isCharacterId(r.p2CharId)) target.p2CharId = r.p2CharId;
  if (track(r.trackId)) target.trackId = r.trackId as string;
  if (track(r.lbTrack)) target.lbTrack = r.lbTrack as string;
  if (CUPS.some(c => c.id === r.cup)) target.cup = r.cup as CupId;
  if (Number.isInteger(r.cpuCount) && (r.cpuCount as number) >= 0 && (r.cpuCount as number) <= 7) target.cpuCount = r.cpuCount as number;
  if (Number.isInteger(r.duoCpuCount) && (r.duoCpuCount as number) >= 0 && (r.duoCpuCount as number) <= 6) target.duoCpuCount = r.duoCpuCount as number;
  if (r.ttGhost === 'none' || r.ttGhost === 'best' || r.ttGhost === 'world') target.ttGhost = r.ttGhost;
}
