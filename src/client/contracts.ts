/**
 * Client module contracts. Each subsystem is implemented in its own directory:
 *   audio/  → AudioSystem            (createAudioSystem())
 *   input/  → InputManager           (createInputManager())
 *   ui/     → app shell, menus, HUD  (startApp(deps))
 *   game/   → GameView / RaceRunner  (createGameView())  — sim + render + audio glue
 *   render/ → three.js scene building used by game/
 */
import type {
  BuiltTrack, CharacterId, CpuLevel, CupId, ItemId, KartInput, KartState, ProjectileKind,
  RaceConfig, RaceEvent, RaceResult, SpeedClass,
} from '../sim/types.js';

// ───────────────────────────── Settings ─────────────────────────────

export type QualityLevel = 'auto' | 'low' | 'medium' | 'high';

export interface Settings {
  master: number;          // 0..1
  music: number;           // 0..1
  sfx: number;             // 0..1
  quality: QualityLevel;
  /** Camera shake and screen effects. */
  shake: boolean;
  cameraDistance: 'near' | 'normal' | 'far';
  showFps: boolean;
  /** Throttle held automatically (accessibility / touch). */
  autoAccelerate: boolean;
  /** Show speedometer on HUD. */
  showSpeed: boolean;
  /** Gamepad vibration on hits, walls and boosts. */
  rumble: boolean;
  playerName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  master: 0.8, music: 0.6, sfx: 0.8,
  quality: 'auto', shake: true, cameraDistance: 'normal', showFps: false,
  autoAccelerate: false, showSpeed: true, rumble: true, playerName: '',
};

// ───────────────────────────── Input ─────────────────────────────

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause' | 'tabPrev' | 'tabNext';

export interface InputManager {
  /** Current race input for human player 0 or 1 (duo: P1 = WASD/gamepad 0, P2 = arrows/gamepad 1). */
  poll(player: number, dtSeconds: number): KartInput;
  /** Subscribe to menu navigation (keyboard arrows/Enter/Esc, gamepad D-pad/A/B/Start). Returns unsubscribe. */
  onMenu(handler: (action: MenuAction, source: 'keyboard' | 'gamepad' | 'touch', player?: number) => void): () => void;
  /** 'single' → P1 may use every keyboard binding; 'duo' → split bindings. */
  setMode(mode: 'single' | 'duo'): void;
  /** Show/hide on-screen touch controls (auto when a touch is detected). */
  setTouchVisible(visible: boolean): void;
  /** True once any touch event has been seen. */
  readonly touchDetected: boolean;
  /** Vibrate gamepad if supported (strength 0..1, ms). */
  rumble(player: number, strength: number, ms: number): void;
  /** Settings affect auto-accelerate. */
  applySettings(s: Settings): void;
  dispose(): void;
}

// ───────────────────────────── Audio ─────────────────────────────

export type MusicCue = string | 'title' | 'menu' | 'results' | 'podium' | 'gameover';
export type UiSound = 'move' | 'select' | 'back' | 'start' | 'error' | 'toggle' | 'unlock';

export interface Listener { x: number; y: number; z: number; yaw: number }

export interface AudioSystem {
  /** Must be called from a user gesture (click/keydown); resumes the AudioContext. */
  unlock(): Promise<void>;
  readonly unlocked: boolean;
  setVolumes(v: { master: number; music: number; sfx: number }): void;
  /** Track id (e.g. 'sunny-meadow') or a menu cue. Crossfades from the current cue. */
  playMusic(cue: MusicCue): void;
  /** Final lap: music speeds up (tempo ×1.12) and adds an intensity layer. */
  setFinalLap(on: boolean): void;
  stopMusic(fadeSeconds?: number): void;
  ui(sound: UiSound): void;
  /** Called once per rendered frame with all events produced by the sim since the last call. */
  handleEvents(events: readonly RaceEvent[], karts: readonly KartState[], humanKarts: readonly number[]): void;
  /** Continuous sounds: engines, drift screech, star music loop, boost roar. */
  update(karts: readonly KartState[], listeners: readonly Listener[], humanKarts: readonly number[], dtSeconds: number): void;
  /** Pause menu / hidden tab. */
  suspend(): void;
  resume(): void;
  /** Stop every race sound (engines, loops) when leaving a race. */
  stopRace(): void;
}

// ───────────────────────────── HUD ─────────────────────────────

export interface HudSnapshot {
  player: number;
  kart: number;
  charId: CharacterId;
  phase: 'intro' | 'countdown' | 'racing' | 'finished';
  /** 3,2,1 during countdown, 0 = "GO!" (shown for ~1 s), null otherwise. */
  countdown: 3 | 2 | 1 | 0 | null;
  position: number;
  racers: number;
  lap: number;             // 1..laps (clamped for display)
  laps: number;
  raceMs: number;
  currentLapMs: number;
  lapMs: number[];         // completed laps
  bestLapMs: number | null;
  item: ItemId | null;
  itemUses: number;
  roulette: boolean;       // item roulette spinning
  coins: number;
  speedKmh: number;
  driftLevel: 0 | 1 | 2 | 3;
  boosting: boolean;
  starActive: boolean;
  shrunk: boolean;
  wrongWay: boolean;
  /** 0..1 ink coverage (fades out). */
  ink: number;
  /** Final lap banner visible. */
  finalLapBanner: boolean;
  finished: boolean;
  finishPosition: number | null;
  /** Time trial: ghost delta in ms at the last split (negative = ahead). */
  ghostDeltaMs: number | null;
  /** Short transient message, e.g. '완벽한 스타트!' */
  toast: { text: string; tone: 'good' | 'bad' | 'info'; id: number } | null;
  standings: Array<{ kart: number; charId: CharacterId; human: number; position: number; finished: boolean }>;
  minimap: {
    karts: Array<{ x: number; z: number; charId: CharacterId; human: number; position: number; kart: number }>;
    projectiles: Array<{ x: number; z: number; kind: ProjectileKind }>;
    /** Time-trial ghost position (null when racing without a ghost). */
    ghost?: { x: number; z: number; charId: CharacterId } | null;
  };
}

// ───────────────────────────── Game view (sim + 3D) ─────────────────────────────

export interface GhostData {
  label: string;           // e.g. '내 최고 기록' / '세계 1위 · 닉네임'
  charId: CharacterId;
  log: string;             // encoded input log
  ticks: number;
}

export interface TimeTrialRecord {
  trackId: string;
  cc: SpeedClass;
  charId: CharacterId;
  ticks: number;
  lapTicks: number[];
  log: string;
}

export interface RaceSummary {
  config: RaceConfig;
  results: RaceResult[];
  timeTrial: TimeTrialRecord | null;
}

export interface RaceStartOptions {
  config: RaceConfig;
  ghost?: GhostData | null;
  /** Called once the race is over and the finish celebration has played. */
  onFinish(summary: RaceSummary): void;
}

export interface GameView {
  /** Mount the WebGL canvas into this element (once). */
  mount(container: HTMLElement): void;
  applySettings(s: Settings): void;
  /** 3D backdrop for menus. 'garage' shows the given character's kart on a turntable. */
  showBackdrop(kind: 'title' | 'garage', charId?: CharacterId): void;
  /** Podium ceremony for GP end (top three character ids, 1st first). */
  showPodium(top3: CharacterId[]): void;
  startRace(opts: RaceStartOptions): Promise<void>;
  skipIntro(): void;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  readonly inRace: boolean;
  restartRace(): void;
  /** Leave the race and return to backdrop mode. */
  endRace(): void;
  /** HUD data for human player (0/1); null outside races. */
  hud(player: number): HudSnapshot | null;
  /** Built track of the running race (for the minimap). */
  readonly track: BuiltTrack | null;
  /** Current smoothed FPS. */
  readonly fps: number;
}

// ───────────────────────────── App shell setup types ─────────────────────────────

export interface GrandPrixSetup { cup: CupId; cc: SpeedClass; charId: CharacterId; cpuLevel: CpuLevel; mirror: boolean }
export interface VersusSetup { trackId: string; cc: SpeedClass; charId: CharacterId; cpuLevel: CpuLevel; items: boolean; mirror: boolean; cpuCount: number }
export interface TimeTrialSetup { trackId: string; cc: SpeedClass; charId: CharacterId; ghost: 'none' | 'best' | 'world' }
export interface DuoSetup { trackId: string; cc: SpeedClass; charIds: [CharacterId, CharacterId]; cpuLevel: CpuLevel; items: boolean; cpuCount: number }
