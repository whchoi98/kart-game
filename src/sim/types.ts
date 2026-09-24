/**
 * TURBO PALS GRAND PRIX — shared simulation contracts.
 *
 * Everything under src/sim is pure, deterministic TypeScript: no DOM, no three.js,
 * no Math.random / Date. The browser and the server run the same code, which is
 * what lets the server re-simulate a time-trial input log and verify the result.
 *
 * Coordinate system (matches three.js): right-handed, +Y up, track lies on XZ.
 *  - A kart with yaw = 0 faces +Z. forward = (sin yaw, 0, cos yaw).
 *  - right = (-cos yaw, 0, sin yaw). steer = +1 turns right, i.e. yaw decreases.
 *  - three.js: object.rotation.y = yaw renders a model built facing +Z correctly.
 *  - Track lateral offset d > 0 is to the right of the travel direction.
 * Units: metres, seconds, radians. The simulation runs at a fixed 60 Hz tick.
 */

export interface Vec3 { x: number; y: number; z: number }

// ───────────────────────────── Characters ─────────────────────────────

export type CharacterId =
  | 'pip' | 'bruno' | 'mochi' | 'rex' | 'kiki' | 'taro' | 'hana' | 'bolt';

/** Species drives the procedural driver model (ears, beak, snout...). */
export type Species =
  | 'penguin' | 'bear' | 'rabbit' | 'dino' | 'fox' | 'raccoon' | 'cat' | 'robot';

export interface CharacterStats {
  /** 1..5 each. Balanced total = 14 (except none). */
  speed: number;
  accel: number;
  weight: number;
  handling: number;
}

export interface CharacterDef {
  id: CharacterId;
  name: string;        // Korean display name
  nameEn: string;
  species: Species;
  /** Primary kart body color, secondary accent, driver fur/skin color (CSS hex). */
  colors: { body: string; accent: string; fur: string; detail: string };
  stats: CharacterStats;
  weightClass: 'light' | 'medium' | 'heavy';
  tagline: string;     // Korean one-liner
}

// ───────────────────────────── Tracks (authoring) ─────────────────────────────

export type ThemeId =
  | 'meadow' | 'beach' | 'canyon' | 'city' | 'snow' | 'jungle' | 'volcano' | 'galaxy';

export type CupId = 'sprout' | 'thunder';

/**
 * Positions along the authored loop are given as `u`: control-point index plus
 * fraction (u = 3.5 is halfway between control points 3 and 4). The builder maps
 * u to arc length s. u wraps modulo the control-point count.
 */
export interface ControlPoint {
  /** [x, y, z] in metres. y is road elevation. */
  p: [number, number, number];
  /** Road half width in metres at this point (default track.halfWidth). */
  w?: number;
  /** Banking angle in radians, positive = right side lower (default 0). */
  bank?: number;
}

export type EdgeKind = 'offroad' | 'wall' | 'pit';
export type SurfaceKind = 'road' | 'dirt' | 'ice' | 'mud';

export interface EdgeRange {
  from: number; to: number;            // u range
  side: 'left' | 'right' | 'both';
  kind: EdgeKind;
  /** Off-road shoulder width in metres (kind 'offroad'). */
  shoulder?: number;
}

export interface SurfaceZone {
  from: number; to: number;            // u range
  /** Lateral band in metres (default: whole road -hw..hw). */
  dFrom?: number; dTo?: number;
  kind: SurfaceKind;
}

export interface BoostPadDef { at: number; d: number; }      // d in metres
export interface ItemRowDef { at: number; count: number; }  // boxes spread across road
export interface CoinLineDef { at: number; d: number; count: number; spacing?: number }

/** Full-width kicker. Surface rises to `height` over `length` metres and then drops. */
export interface RampDef {
  at: number;          // u where the ramp starts
  length: number;      // metres
  height: number;      // metres at the lip
  /** Glider/trick ramp: tricks off the lip give a landing boost; rendered as boost ramp. */
  trick?: boolean;
}

/** Moving hazard. Position is a pure function of race time (deterministic). */
export interface MoverDef {
  kind: 'sweep' | 'travel';
  at: number;          // u (sweep: fixed position; travel: start position)
  d: number;           // lateral centre in metres
  /** sweep: lateral amplitude in metres; travel: unused. */
  amplitude?: number;
  /** sweep: seconds per full oscillation. travel: seconds per full lap of the loop. */
  period: number;
  phase?: number;      // radians (sweep) or fraction of lap (travel)
  radius: number;      // collision radius in metres
  /** Visual flavour decided by the theme renderer (e.g. 'boulder', 'crab', 'car', 'snowball'). */
  look: string;
}

/** Hint for the scenery renderer — landmark props placed relative to the track. */
export interface LandmarkDef {
  kind: string;        // theme-specific (e.g. 'windmill', 'lighthouse', 'arch', 'volcano')
  at: number;          // u
  side: 'left' | 'right' | 'over';
  dist: number;        // metres from centreline
  scale?: number;
}

export interface TrackDef {
  id: string;
  name: string;        // Korean display name
  nameEn: string;
  cup: CupId;
  order: number;       // 1..4 within the cup
  theme: ThemeId;
  laps: number;
  /** Default road half width (m). Typical 8..11. */
  halfWidth: number;
  /** Default off-road shoulder width (m). */
  shoulder: number;
  /** Default edge kind where no EdgeRange applies. */
  defaultEdge: EdgeKind;
  /** Default off-road surface kind (grass/sand/snow render differently, physics = 'dirt'). */
  points: ControlPoint[];
  /** u of the start/finish line. Grid is placed behind it. */
  startAt: number;
  edges?: EdgeRange[];
  surfaces?: SurfaceZone[];
  boostPads?: BoostPadDef[];
  itemRows?: ItemRowDef[];
  coins?: CoinLineDef[];
  ramps?: RampDef[];
  movers?: MoverDef[];
  landmarks?: LandmarkDef[];
  /** Music tempo/mood hint for the audio module. */
  music: { bpm: number; key: string; mood: 'bright' | 'tropical' | 'western' | 'funky' | 'chill' | 'adventure' | 'intense' | 'cosmic' };
  /** Seed for procedural scenery (renderer only). */
  scenerySeed: number;
  /** Target par lap time in seconds at 150cc (authoring aid, UI shows it). */
  parLap?: number;
}

// ───────────────────────────── Tracks (built) ─────────────────────────────

/** Resolved, uniformly sampled track. Arrays are indexed by sample i in [0, n). */
export interface BuiltTrack {
  def: TrackDef;
  /** Lap length in metres (closed loop). */
  length: number;
  /** Number of samples; spacing = length / n (≈ 1 m). */
  n: number;
  spacing: number;
  /** Centreline position. */
  px: Float64Array; py: Float64Array; pz: Float64Array;
  /** Unit tangent (3D, includes slope). */
  tx: Float64Array; ty: Float64Array; tz: Float64Array;
  /** Unit right vector (includes banking). Road surface point = p + r * d. */
  rx: Float64Array; ry: Float64Array; rz: Float64Array;
  /** Unit surface normal (up). */
  ux: Float64Array; uy: Float64Array; uz: Float64Array;
  /** Road half width. */
  hw: Float64Array;
  /** Extra ramp height on top of the road at this sample (NOT included in py; surfaceAt adds it).
   *  Renderers draw the road ribbon from py and a separate ramp wedge from rampH. */
  rampH: Float64Array;
  /** 1 if sample is on a trick ramp. */
  rampTrick: Uint8Array;
  /** Signed horizontal curvature (1/m), positive = turning right. Smoothed. */
  curvature: Float64Array;
  /** Left/right edge kind per sample (EdgeKind index: 0 offroad, 1 wall, 2 pit). */
  edgeL: Uint8Array; edgeR: Uint8Array;
  /** Distance from centreline to the barrier on each side (m, positive). For 'pit' = hw. */
  wallL: Float64Array; wallR: Float64Array;
  /** Surface zones resolved to s ranges. */
  surfaces: Array<{ s0: number; s1: number; d0: number; d1: number; kind: SurfaceKind }>;
  /** s of start line. */
  startS: number;
  boostPads: Array<{ s: number; d: number; x: number; y: number; z: number; yaw: number }>;
  itemBoxes: Array<{ s: number; d: number; x: number; y: number; z: number }>;
  coins: Array<{ s: number; d: number; x: number; y: number; z: number }>;
  ramps: Array<{ s0: number; s1: number; height: number; trick: boolean }>;
  movers: Array<MoverDef & { s: number }>;
  landmarks: Array<LandmarkDef & { s: number }>;
  /** Map an authored u (control-point index + fraction) to arc length s. */
  uToS(u: number): number;
  /** Mirror mode flag this track was built with. */
  mirrored: boolean;
  /** 8 grid slots behind the start line (index 0 = pole). */
  grid: Array<{ x: number; y: number; z: number; yaw: number; s: number; d: number; i: number }>;
}

export interface TrackProjection {
  /** Nearest sample index (use as hint next tick). */
  i: number;
  /** Arc length of the projected point (0..length). */
  s: number;
  /** Signed lateral offset (m), positive = right. */
  d: number;
  /** Road surface height at the projected lateral offset. */
  h: number;
}

export interface SurfaceInfo {
  /** Ground height; -Infinity when over a pit. */
  height: number;
  /** Surface normal (unit). */
  nx: number; ny: number; nz: number;
  kind: SurfaceKind | 'pit';
  onRoad: boolean;
}

// ───────────────────────────── Items ─────────────────────────────

export type ItemId =
  | 'banana' | 'banana3'
  | 'orb' | 'orb3'
  | 'rocket' | 'rocket3'
  | 'nitro' | 'nitro3'
  | 'star' | 'thunder' | 'ink' | 'autopilot' | 'skybomb' | 'coins';

export type ProjectileKind = 'banana' | 'orb' | 'rocket' | 'skybomb';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  owner: number;           // kart index
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Track hint index. */
  i: number;
  /** Remaining lifetime (s). Bananas: Infinity until hit. */
  life: number;
  bounces: number;
  /** Homing target kart index or -1. */
  target: number;
  /** Seconds the owner is immune to this projectile. */
  ownerGrace: number;
  /** For skybomb: phase 'cruise' | 'dive'. */
  state: 'fly' | 'rest' | 'cruise' | 'dive';
  /** Progress along track in metres (rocket/skybomb track following). */
  prog: number;
}

/** Items visually held/trailing behind or orbiting a kart (shields). */
export interface HeldItem {
  kind: 'banana' | 'orb' | 'rocket';
  /** 0 = trailing behind (held button), 1..3 = orbiting slot. */
  slot: number;
}

// ───────────────────────────── Karts ─────────────────────────────

export interface KartInput {
  throttle: boolean;
  brake: boolean;
  /** -1..1 (quantised to 1/63 steps). */
  steer: number;
  drift: boolean;
  item: boolean;
  /** Look back / aim backward modifier. */
  back: boolean;
}

export type HitKind = 'spin' | 'tumble' | 'squash' | 'bump';
export type BoostKind = 'mini1' | 'mini2' | 'mini3' | 'pad' | 'nitro' | 'trick' | 'start' | 'coin' | 'ramp';

export interface KartState {
  index: number;
  charId: CharacterId;
  /** Human player index (0/1) or -1 for CPU. */
  human: number;
  // pose
  x: number; y: number; z: number;
  yaw: number;
  /** Planar velocity (world). */
  vx: number; vz: number;
  vy: number;
  /** Signed forward speed (m/s). */
  speed: number;
  grounded: boolean;
  airTime: number;
  /** Visual body tilt (rad). pitch > 0 = nose up, roll > 0 = right side down.
   *  three.js: model.rotation.set(-pitch, yaw + driftAngle, roll, 'YXZ'). */
  pitch: number; roll: number;
  /** Visual yaw offset while drifting (rad, renderer adds to yaw). */
  driftAngle: number;
  steerVisual: number;     // smoothed -1..1 for wheels/driver lean
  // track progress
  ti: number;              // track hint index
  s: number; d: number;
  progress: number;        // continuous metres since start line (negative on grid)
  lap: number;             // 0 before crossing the line, 1..laps during race
  lapStartTick: number;
  lapTicks: number[];      // completed lap durations in ticks
  finished: boolean;
  finishTick: number;      // tick at which the kart finished (-1)
  position: number;        // 1-based race position
  wrongWay: boolean;
  lastSafe: { x: number; y: number; z: number; yaw: number; i: number; progress: number };
  surface: SurfaceKind | 'pit' | 'air';
  // drift
  driftDir: -1 | 0 | 1;
  driftCharge: number;
  driftLevel: 0 | 1 | 2 | 3;
  hopTime: number;
  // boosts
  boostTime: number;
  boostKind: BoostKind | null;
  trickReady: boolean;      // true shortly after leaving a ramp lip (trick window)
  trickPending: boolean;    // trick performed; boost granted on landing
  trickTime: number;        // >0 while trick animation plays
  // status
  spinTime: number;
  tumbleTime: number;
  shrinkTime: number;
  starTime: number;
  inkTime: number;
  autopilotTime: number;
  invulnTime: number;
  respawnTime: number;     // >0 while being carried back to track
  stallTime: number;       // >0 after a botched rocket start (engine smoke, no throttle)
  // items
  item: ItemId | null;
  /** Remaining uses of the current item (triples start at 3). */
  itemUses: number;
  rouletteTime: number;    // >0 while the item roulette spins (item already decided)
  held: HeldItem[];
  holding: boolean;        // item button currently held with a trailable item
  coins: number;
  // input memory
  prevDrift: boolean;
  prevItem: boolean;
  /** Throttle input applied on the last tick (engine audio / exhaust visuals). */
  throttle: boolean;
  throttleStartTick: number; // first tick throttle pressed during countdown (-1)
  /** Stats resolved from character + cc. */
  maxSpeed: number;
  accel: number;
  turnRate: number;
  mass: number;
  /** Hidden speed multiplier (CPU difficulty & rubber-banding). 1 for humans. */
  speedScale: number;
  /** Seconds since the last hit-by-item/fall; renderer uses spin/tumble timers for animation. */
  hitTimer: number;
}

// ───────────────────────────── Race ─────────────────────────────

export type RaceMode = 'gp' | 'vs' | 'tt' | 'duo';
export type SpeedClass = 50 | 100 | 150 | 200;
export type CpuLevel = 'easy' | 'normal' | 'hard';

export interface RacerSetup {
  charId: CharacterId;
  /** Human player index 0/1, or -1 for CPU. */
  human: number;
}

export interface RaceConfig {
  trackId: string;
  mode: RaceMode;
  cc: SpeedClass;
  cpuLevel: CpuLevel;
  mirror: boolean;
  /** Karts in grid order (index 0 = pole). Humans usually start at the back in GP race 1. */
  racers: RacerSetup[];
  items: boolean;
  seed: number;
  /** Laps override (default track laps). */
  laps?: number;
}

export type RacePhase = 'countdown' | 'racing' | 'done';

export type RaceEvent =
  | { t: 'countdown'; n: 3 | 2 | 1 | 0 }
  | { t: 'lap'; kart: number; lap: number; lapTicks: number }
  | { t: 'finalLap'; kart: number }
  | { t: 'finish'; kart: number; position: number; ticks: number }
  | { t: 'itemBox'; kart: number; x: number; y: number; z: number; box: number }
  | { t: 'itemGet'; kart: number; item: ItemId }
  | { t: 'itemUse'; kart: number; item: ItemId }
  | { t: 'hit'; kart: number; kind: HitKind; by: number; source: ProjectileKind | 'mover' | 'kart' | 'star' | 'autopilot' | 'thunder' | 'fall' }
  | { t: 'blocked'; kart: number; source: ProjectileKind }
  | { t: 'boost'; kart: number; kind: BoostKind }
  | { t: 'driftLevel'; kart: number; level: 1 | 2 | 3 }
  | { t: 'driftStart'; kart: number; dir: -1 | 1 }
  | { t: 'driftEnd'; kart: number }
  | { t: 'hop'; kart: number }
  | { t: 'trick'; kart: number }
  | { t: 'land'; kart: number; hard: boolean }
  | { t: 'wall'; kart: number; impact: number; x: number; y: number; z: number }
  | { t: 'kartBump'; a: number; b: number; impact: number; x: number; y: number; z: number }
  | { t: 'coin'; kart: number; x: number; y: number; z: number; coins: number }
  | { t: 'coinLoss'; kart: number; count: number }
  | { t: 'explosion'; x: number; y: number; z: number; radius: number; source: ProjectileKind }
  | { t: 'projectileBounce'; id: number; x: number; y: number; z: number }
  | { t: 'projectileGone'; id: number; x: number; y: number; z: number; kind: ProjectileKind }
  | { t: 'thunder'; by: number }
  | { t: 'ink'; by: number; targets: number[] }
  | { t: 'fall'; kart: number }
  | { t: 'respawn'; kart: number }
  | { t: 'wrongWay'; kart: number; on: boolean }
  | { t: 'position'; kart: number; from: number; to: number }
  | { t: 'startBoost'; kart: number; good: boolean }
  | { t: 'stall'; kart: number }
  | { t: 'raceDone' };

/** Result row produced when the race is over. */
export interface RaceResult {
  kart: number;
  charId: CharacterId;
  human: number;
  position: number;
  /** Finish time in ticks (CPU karts that did not finish get an estimate). */
  ticks: number;
  estimated: boolean;
  lapTicks: number[];
  bestLapTicks: number;
}
