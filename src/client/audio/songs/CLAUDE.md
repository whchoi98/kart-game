# Songs Module

## Role
- Original music as data: one `SongDef` per file, compiled at play time by `../pattern.ts` (`compileSong()`) and scheduled by
  `../sequencer.ts`. No audio files, no borrowed melodies or titles.
- `index.ts` resolves every music cue to a song. Race cues are track ids (`race-session.ts` calls
  `audio.playMusic(track.def.id)`); menu cues are `title`, `menu`, `results`, `podium`, `gameover`.

## Key Files
- `index.ts` - `TRACK_SONGS` (8), `MENU_CUES` + `MENU_SONGS` (5), `STAR_SONG`, `SONGS` (13 playable cues, star excluded),
  `resolveCue()` (unknown cue -> `MENU`), `ALL_SONGS` (all 14, iterated by the tests).
- Track songs. File name = song id = track id in `src/sim/tracks/catalog.ts`; all `loop: true`, intro `INTRO`, body
  `A, B, A2, C` (28 bars):
  - `sunny-meadow.ts` Dandelion Dash, 150 bpm, C major. `palm-beach.ts` Coconut Cruise, 128, F major, swing 0.1.
  - `canyon-rally.ts` Mesa Gallop, 140, E minor. `neon-city.ts` Midnight Overdrive, 124, A minor, swing 0.06.
  - `frost-peak.ts` Snowglobe Serenade, 132, D major, swing 0.08. `jungle-ruins.ts` Temple of Vines, 136, G minor.
  - `lava-fortress.ts` Magma Bastion, 160, C minor. `starlight-road.ts` Aurora Highway, 146, Eb lydian.
- Menu songs:
  - `title.ts` Turbo Pals Anthem (120, G major, 24-bar body): title screen and main menu (`ui/screens/title.ts`,
    `ui/screens/main-menu.ts`).
  - `menu.ts` Garage Lounge (108, A major, swing 0.18, 24 bars): selection, options, settings, controls, credits and
    leaderboard screens; also the fallback for unknown cues.
  - `results.ts` Checkered Confetti (132, D major, 8 bars): race results. `podium.ts` Golden Trophy March (112, Bb major,
    `FANFARE` intro then `MARCH` loop): Grand Prix podium (`createPodium` in `ui/screens/results.ts`).
  - `gameover.ts` Try Again (100, C minor, 2-bar `STING`, `loop: false`). No screen requests the `gameover` cue at present.
- `star.ts` Invincible Sparkle (180, G major, 4-bar `LOOP`): Super Star layer over the track music, not a cue in `SONGS`.

## Rules
- DSL (`../pattern.ts` header): 4/4 bars of 16 sixteenth steps. `chords` one bar per `|`, several chords split a bar, `%`
  repeats. Melody tokens `pitch[:dur16][!]`, `r` rest, `-` tie, `~` glide, `!` accent; every bar sums to 16. Bass: chord
  degrees `1 3 5 7 8 0`, `-` hold, `.` rest. `arp`: chord-tone indices. `pad`: `hold | stab8 | stab4 | pulse`. Drum lanes
  `k s h o c t x r z g b`; `fill` replaces the section's last bar. A line repeats when its bar count divides the section.
- `SongDef` fields: `id`, `title`, `bpm`, `tonic`, `mode`, `loop`, `instruments` (preset names typed in `../pattern.ts`),
  `sections`, `intro`, `body`; optional `swing`, `chromatic`, `mix`, `arpFloor`, `bassShift`.
- `compileSong()` must return zero `errors`: notes outside the scale (declare blue notes in `chromatic`), a lead/counter note
  struck on a chord change a semitone above a chord tone (`checkHarmony`), bars not adding up to 16, bad chords, missing
  sections.
- Ids must be unique: `SONGS` keys track songs by id, the compile cache is keyed by `def.id`, and `Sequencer.play()` ignores a
  cue whose song id is already playing.
- Final lap needs nothing per song: the sequencer plays a 1.55 s sting from the song's tonic and mode, resumes at the next bar
  at tempo x1.12 and adds the compiler's intensity layer (extra hats, doubled arp). `setFinalLap(false)` restores tempo.
- The star layer is transposed into the track's parent major key (`starTranspose()` in `../sequencer.ts`); keep `star.ts`
  melodies diatonic to G major.
- Titles stay original: the test rejects `/mario|kart|nintendo|rainbow road|koopa|bowser|luigi|peach/i`.

## How to extend (new song)
1. Create `<id>.ts` exporting a `SongDef`; copy the shape of an existing track song (`INTRO` + `A`, `B`, `A2`, `C`).
2. Track song: id = track id, add it to `TRACK_SONGS`; for a new track also update `expect(TRACK_CATALOG).toHaveLength(8)` in
   `test/client/audio-songs.test.ts`. Menu cue: add it to `MENU_CUES` and `MENU_SONGS`, and to `MusicCue` in
   `src/client/contracts.ts` (typed `string`, so the compiler will not remind you).
3. Add its bpm, tonic and mode to the `SPEC` table in `test/client/audio-songs.test.ts`.
4. Run the tests below, then listen with `npm run dev`.

## Testing
- `npx vitest run test/client/audio-songs.test.ts`: catalog (a song per catalog track, menu cues, fallback, `SPEC` tempo/key,
  original titles); `describe.each` over `ALL_SONGS` (zero errors, bar alignment, track/title/menu songs with intro >= 1, a
  body of >= 2 sections totalling 16-32 bars and `loop: true`, notes inside `PART_RANGES`, melodies in key, melody, bass and
  drums (not `gameover`) plus pad or arp, intensity layer); the validator; star transposition (|d| <= 6, no clash with any
  track scale).
- `test/client/audio-system.test.ts` plays every cue through a WebAudio mock (crossfade, final-lap tempo, game-over sting).
