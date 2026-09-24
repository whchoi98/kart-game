/**
 * Mode flows: setup screen chains and race sessions (GP / VS / Duo / Time trial).
 */
import { getCharacter } from '../../sim/characters.js';
import { createTimeTrialConfig } from '../../sim/replay.js';
import { CUPS, getTrackMeta, tracksOfCup } from '../../sim/tracks/catalog.js';
import type { CharacterId, RaceConfig, SpeedClass } from '../../sim/types.js';
import type { LeaderboardEntry } from '../../shared/api.js';
import { browserOffline, errorMessage, fetchGhost } from '../api.js';
import type {
  DuoSetup, GhostData, GrandPrixSetup, RaceSummary, TimeTrialSetup, VersusSetup,
} from '../contracts.js';
import type { App } from './app.js';
import { applyRaceResults, gridFromStandings, initialStandings, rankOf, trophyForRank, type GpEntry } from './gp.js';
import { buildGrid, makeDuoConfig, makeGrandPrixConfig, makeVersusConfig, randomSeed, seededRandom } from './grid.js';
import type { Screen } from './screen.js';
import { createCharSelect, createDuoCharSelect } from './screens/char-select.js';
import { CPU_LABEL, createClassScreen } from './screens/class-select.js';
import { createCupSelect, createTrackSelect } from './screens/course-select.js';
import { createTimeTrialOptions, createVersusOptions, type GhostChoice } from './screens/options.js';
import { RaceScreen } from './screens/race.js';
import { createGrandPrixResults, createPodium, createTimeTrialResults, createVersusResults } from './screens/results.js';

const STEPS = {
  gp: ['클래스', '캐릭터', '컵'],
  vs: ['클래스', '캐릭터', '코스', '규칙'],
  tt: ['클래스', '캐릭터', '코스', '고스트'],
  duo: ['클래스', '캐릭터', '코스', '규칙'],
};

// ───────────────────────── Grand Prix ─────────────────────────

export function startGrandPrix(app: App): void {
  app.push(createClassScreen(app, {
    mode: 'gp', steps: STEPS.gp,
    onNext: sel => app.push(createCharSelect(app, {
      kicker: '그랑프리', steps: STEPS.gp, step: 1,
      onNext: charId => app.push(createCupSelect(app, {
        cc: sel.cc, steps: STEPS.gp, step: 2,
        onNext: cup => new GrandPrixSession(app, { cup, cc: sel.cc, charId, cpuLevel: sel.cpuLevel, mirror: sel.mirror }).start(),
      })),
    })),
  }));
}

class GrandPrixSession {
  private readonly tracks: string[];
  private readonly race: RaceScreen;
  private standings: GpEntry[] = [];
  private raceIndex = 0;
  private readonly cupName: string;

  constructor(private readonly app: App, private readonly setup: GrandPrixSetup) {
    this.tracks = tracksOfCup(setup.cup).map(t => t.id);
    this.cupName = CUPS.find(c => c.id === setup.cup)?.name ?? '';
    this.race = new RaceScreen(app, {
      mode: 'gp', duo: false,
      quitTitle: '그랑프리를 그만둘까요?',
      quitMessage: '지금까지 얻은 점수는 사라져요.',
      onQuit: () => app.toMainMenu(),
    });
  }

  start(): void {
    const seed = randomSeed();
    const grid = buildGrid([this.setup.charId], 7, seededRandom(seed));
    this.standings = initialStandings(grid);
    this.raceIndex = 0;
    this.app.push(this.race);
    this.runRace(grid);
  }

  private runRace(grid: ReturnType<typeof buildGrid>): void {
    const trackId = this.tracks[this.raceIndex]!;
    const config = makeGrandPrixConfig(this.setup, trackId, grid, randomSeed());
    void this.race.run({
      config,
      subtitle: `레이스 ${this.raceIndex + 1}/${this.tracks.length} · ${this.setup.cc}cc${this.setup.mirror ? ' 미러' : ''}`,
      onFinish: s => this.onFinish(s),
    });
  }

  private onFinish(summary: RaceSummary): void {
    const human = summary.results.find(r => r.human >= 0);
    this.app.storage.recordRace({ position: human?.position ?? null, mode: 'gp', racers: summary.results.length });
    const before = this.standings;
    const { standings, awards } = applyRaceResults(before, summary.results);
    this.standings = standings;
    const final = this.raceIndex >= this.tracks.length - 1;
    this.app.push(createGrandPrixResults(this.app, {
      raceIndex: this.raceIndex, totalRaces: this.tracks.length, cupName: this.cupName, summary,
      awards, before, after: standings, final,
      onNext: () => (final ? this.finale() : this.next()),
    }));
  }

  private next(): void {
    this.raceIndex++;
    this.app.popTo(this.race);
    this.runRace(gridFromStandings(this.standings));
  }

  private finale(): void {
    const rank = rankOf(this.standings, this.setup.charId);
    const trophy = trophyForRank(rank);
    const { improved, newUnlocks } = this.app.storage.recordTrophy(this.setup.cup, this.setup.cc, trophy);
    this.app.storage.recordGrandPrixCompleted();
    const top3 = this.standings.slice(0, 3).map(e => e.charId);
    this.race.leaveRace();
    try { this.app.view.showPodium(top3); } catch (err) { console.error('[ui] podium failed', err); }
    const podium = createPodium(this.app, {
      cup: this.setup.cup, cupName: this.cupName, cc: this.setup.cc, standings: this.standings,
      trophy, improved, newUnlocks,
      onMenu: () => this.app.toMainMenu(),
      onRetry: () => {
        this.app.toMainMenu();
        new GrandPrixSession(this.app, this.setup).start();
      },
    });
    this.app.push(podium);
  }
}

// ───────────────────────── VS / Duo ─────────────────────────

export function startVersus(app: App): void {
  app.push(createClassScreen(app, {
    mode: 'vs', steps: STEPS.vs,
    onNext: sel => app.push(createCharSelect(app, {
      kicker: 'VS 레이스', steps: STEPS.vs, step: 1,
      onNext: charId => {
        const trackScreen = createTrackSelect(app, {
          mode: 'vs', cc: sel.cc, mirror: sel.mirror, steps: STEPS.vs, step: 2,
          onNext: trackId => app.push(createVersusOptions(app, {
            duo: false, trackId, cc: sel.cc, cpuLevel: sel.cpuLevel, mirror: sel.mirror, chars: [charId],
            steps: STEPS.vs, step: 3,
            onStart: rules => new VersusSession(app, {
              kind: 'vs',
              setup: { trackId, cc: sel.cc, charId, cpuLevel: sel.cpuLevel, items: rules.items, mirror: sel.mirror, cpuCount: rules.cpuCount },
              trackScreen,
            }).start(),
          })),
        });
        app.push(trackScreen);
      },
    })),
  }));
}

export function startDuo(app: App): void {
  app.push(createClassScreen(app, {
    mode: 'duo', steps: STEPS.duo,
    onNext: sel => app.push(createDuoCharSelect(app, {
      steps: STEPS.duo, step: 1,
      onNext: charIds => {
        const trackScreen = createTrackSelect(app, {
          mode: 'duo', cc: sel.cc, mirror: false, steps: STEPS.duo, step: 2,
          onNext: trackId => app.push(createVersusOptions(app, {
            duo: true, trackId, cc: sel.cc, cpuLevel: sel.cpuLevel, mirror: false, chars: charIds,
            steps: STEPS.duo, step: 3,
            onStart: rules => new VersusSession(app, {
              kind: 'duo',
              setup: { trackId, cc: sel.cc, charIds, cpuLevel: sel.cpuLevel, items: rules.items, cpuCount: rules.cpuCount },
              trackScreen,
            }).start(),
          })),
        });
        app.push(trackScreen);
      },
    })),
  }));
}

type VersusArgs =
  | { kind: 'vs'; setup: VersusSetup; trackScreen: Screen }
  | { kind: 'duo'; setup: DuoSetup; trackScreen: Screen };

class VersusSession {
  private readonly race: RaceScreen;

  constructor(private readonly app: App, private readonly a: VersusArgs) {
    const duo = a.kind === 'duo';
    this.race = new RaceScreen(app, {
      mode: a.kind, duo,
      quitTitle: '레이스를 그만둘까요?',
      quitMessage: '메뉴로 돌아가요. 이번 레이스 기록은 남지 않아요.',
      onQuit: () => app.toMainMenu(),
    });
  }

  start(): void {
    const seed = randomSeed();
    const rand = seededRandom(seed);
    const a = this.a;
    const config = a.kind === 'vs'
      ? makeVersusConfig(a.setup, buildGrid([a.setup.charId], a.setup.cpuCount, rand), randomSeed())
      : makeDuoConfig(a.setup, buildGrid(a.setup.charIds, a.setup.cpuCount, rand), randomSeed());
    const extra = a.kind === 'vs'
      ? `${a.setup.cc}cc${a.setup.mirror ? ' 미러' : ''} · CPU ${a.setup.cpuCount === 0 ? '없음' : `${a.setup.cpuCount}명 (${CPU_LABEL[a.setup.cpuLevel]})`}`
      : `${a.setup.cc}cc · ${getCharacter(a.setup.charIds[0]).name} vs ${getCharacter(a.setup.charIds[1]).name}`;
    this.app.push(this.race);
    void this.race.run({
      config,
      subtitle: `${a.kind === 'vs' ? 'VS 레이스' : '2인 대전'} · ${extra}`,
      onFinish: s => this.onFinish(s),
    });
  }

  private onFinish(summary: RaceSummary): void {
    // Profile stats belong to player 1 (duo: P2 winning is not the profile's win). recordRace
    // itself ignores wins / podiums that the field size makes automatic (solo run, 2-player duel).
    const p1 = summary.results.find(r => r.human === 0);
    this.app.storage.recordRace({ position: p1?.position ?? null, mode: this.a.kind, racers: summary.results.length });
    this.app.push(createVersusResults(this.app, {
      summary, duo: this.a.kind === 'duo',
      onRetry: () => { this.app.popTo(this.race); this.race.restart(); },
      onOtherTrack: () => {
        this.race.leaveRace();
        this.app.popTo(this.a.trackScreen);
      },
      onMenu: () => { this.race.leaveRace(); this.app.toMainMenu(); },
    }));
  }
}

// ───────────────────────── Time trial ─────────────────────────

export function startTimeTrial(app: App): void {
  app.push(createClassScreen(app, {
    mode: 'tt', steps: STEPS.tt,
    onNext: sel => app.push(createCharSelect(app, {
      kicker: '타임 어택', steps: STEPS.tt, step: 1,
      onNext: charId => {
        const trackScreen = createTrackSelect(app, {
          mode: 'tt', cc: sel.cc, mirror: false, steps: STEPS.tt, step: 2,
          onNext: trackId => app.push(createTimeTrialOptions(app, {
            trackId, cc: sel.cc, charId, steps: STEPS.tt, step: 3,
            onStart: (choice, world) => void beginTimeTrial(app, { trackId, cc: sel.cc, charId, ghost: choice }, world, trackScreen),
          })),
        });
        app.push(trackScreen);
      },
    })),
  }));
}

/** Leaderboard → "이 기록 고스트와 대결": fetch the ghost, pick a character, race. */
export async function challengeGhost(app: App, entry: LeaderboardEntry): Promise<void> {
  const ghost = await loadWorldGhost(app, entry, `세계 ${entry.rank}위 · ${entry.name}`);
  if (!ghost) return;
  app.push(createCharSelect(app, {
    kicker: `고스트 대결 · ${getTrackMeta(entry.trackId).name}`, steps: ['캐릭터'], step: 0, initial: app.memory.charId,
    onNext: charId => new TimeTrialSession(app, { trackId: entry.trackId, cc: entry.cc, charId, ghost: 'world' }, ghost, null).start(),
  }));
}

async function loadWorldGhost(app: App, entry: LeaderboardEntry, label: string): Promise<GhostData | null> {
  if (browserOffline()) {
    app.sound('error');
    await app.modal({
      title: '오프라인이에요', tone: 'info', dismiss: true, buttons: [{ label: '확인', value: true }],
      message: '세계 기록 고스트는 인터넷에 연결되어 있을 때만 받을 수 있어요. 고스트 없이 달리거나 내 최고 기록 고스트와 겨뤄 보세요.',
    });
    return null;
  }
  const busy = app.busy('고스트 데이터를 받는 중…', true);
  const ctrl = new AbortController();
  void busy.cancelled.then(() => ctrl.abort());
  try {
    const g = await fetchGhost(entry.id, { signal: ctrl.signal });
    busy.close();
    return { label, charId: g.charId, log: g.log, ticks: g.ticks };
  } catch (err) {
    busy.close();
    if (ctrl.signal.aborted) return null;
    app.sound('error');
    await app.modal({ title: '고스트를 불러오지 못했어요', message: errorMessage(err), tone: 'danger', dismiss: true, buttons: [{ label: '확인', value: true }] });
    return null;
  }
}

async function beginTimeTrial(app: App, setup: TimeTrialSetup, world: LeaderboardEntry | null, trackScreen: Screen): Promise<void> {
  let ghost: GhostData | null = null;
  let choice: GhostChoice = setup.ghost;
  if (choice === 'best') {
    const best = app.storage.getBest(setup.trackId, setup.cc);
    ghost = best && best.log ? { label: '내 최고 기록', charId: best.charId, log: best.log, ticks: best.ticks } : null;
  } else if (choice === 'world' && world) {
    ghost = await loadWorldGhost(app, world, `세계 1위 · ${world.name}`);
    if (!ghost) {
      const go = await app.confirm({ title: '고스트 없이 출발할까요?', yes: '고스트 없이 출발', no: '돌아가기' });
      if (!go) return;
      choice = 'none';
    }
  }
  new TimeTrialSession(app, { ...setup, ghost: choice }, ghost, trackScreen).start();
}

class TimeTrialSession {
  private readonly race: RaceScreen;

  constructor(
    private readonly app: App,
    private readonly setup: TimeTrialSetup,
    private ghost: GhostData | null,
    private readonly trackScreen: Screen | null,
  ) {
    this.race = new RaceScreen(app, {
      mode: 'tt', duo: false,
      quitTitle: '타임 어택을 그만둘까요?',
      quitMessage: '이번 주행 기록은 저장되지 않아요.',
      onQuit: () => app.toMainMenu(),
    });
  }

  private config() {
    return createTimeTrialConfig(this.setup.trackId, this.setup.cc as SpeedClass, this.setup.charId as CharacterId);
  }

  start(): void {
    this.app.push(this.race);
    this.run();
  }

  private run(): void {
    void this.race.run({
      config: this.config(),
      ghost: this.ghost,
      subtitle: `타임 어택 · ${this.setup.cc}cc${this.ghost ? ` · 고스트: ${this.ghost.label}` : ''}`,
      onFinish: s => this.onFinish(s),
    });
  }

  private onFinish(summary: RaceSummary): void {
    this.app.storage.recordRace({ position: null, mode: 'tt' });
    // timeTrial === null: the run was (partly) bot-driven — never a personal best, never submitted.
    const assisted = summary.timeTrial === null;
    const rec = summary.timeTrial ?? fallbackRecord(summary, this.setup);
    const { newRecord, previous } = assisted
      ? { newRecord: false, previous: this.app.storage.getBest(this.setup.trackId, this.setup.cc) }
      : this.app.storage.saveBestIfFaster(rec);
    this.app.push(createTimeTrialResults(this.app, {
      record: rec, previous, newRecord, ghostLabel: this.ghost?.label ?? null, assisted,
      onRetry: () => { this.app.popTo(this.race); this.race.restart(); },
      onGhostRetry: () => {
        const best = this.app.storage.getBest(this.setup.trackId, this.setup.cc);
        this.ghost = best && best.log
          ? { label: '내 최고 기록', charId: best.charId, log: best.log, ticks: best.ticks }
          : rec.log ? { label: '방금 주행', charId: rec.charId, log: rec.log, ticks: rec.ticks } : null;
        this.app.popTo(this.race);
        this.run();
      },
      onMenu: () => {
        this.race.leaveRace();
        this.app.toMainMenu();
      },
      onOtherTrack: this.trackScreen ? () => {
        this.race.leaveRace();
        this.app.popTo(this.trackScreen!);
      } : null,
    }));
  }
}

function fallbackRecord(summary: RaceSummary, setup: TimeTrialSetup) {
  const r = summary.results.find(x => x.human === 0) ?? summary.results[0];
  return {
    trackId: setup.trackId, cc: setup.cc, charId: setup.charId,
    ticks: r?.ticks ?? 0, lapTicks: r?.lapTicks ?? [], log: '',
  };
}


// ───────────────────────── debug / QA ─────────────────────────

/** Run an arbitrary RaceConfig through the real race screen + HUD (used by the ?debug hook). */
export function runDebugRace(app: App, config: RaceConfig, ghost: GhostData | null = null): Promise<boolean> {
  const duo = config.racers.filter(r => r.human >= 0).length > 1;
  const race = new RaceScreen(app, {
    mode: config.mode, duo,
    quitTitle: '레이스를 그만둘까요?', quitMessage: '메뉴로 돌아가요.',
    onQuit: () => app.toMainMenu(),
  });
  app.toMainMenu();
  app.push(race);
  return race.run({
    config, ghost, subtitle: `디버그 · ${config.cc}cc`,
    onFinish: summary => app.push(createVersusResults(app, {
      summary, duo,
      onRetry: () => { app.popTo(race); race.restart(); },
      onOtherTrack: () => { race.leaveRace(); app.toMainMenu(); },
      onMenu: () => { race.leaveRace(); app.toMainMenu(); },
    })),
  });
}
