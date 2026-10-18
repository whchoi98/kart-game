# ADR-005: Procedural, Original Game Content

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Status
Accepted (2026-09-24)

## Context
- The goal is a commercial-quality arcade kart racer in the Mario Kart style of play, with characters, tracks, items, art and music that are entirely original. No third-party game IP may appear.
- The repository is public on GitHub under "All rights reserved" (`LICENSE`), so anything committed is redistributed with it.
- The PWA precaches the whole game for offline play ([ADR-006](ADR-006-offline-first-pwa-race-safe-updates.md)); every asset adds to the first download and to the offline cache.

## Options Considered

### Option 1: Procedural content generated in code (chosen)
- **Pros**: No asset licences, attribution or redistribution limits; small text sources that review well in diffs; seeded generation reproduces the same output; one consistent style.
- **Cons**: Visual and audio quality depend on code; generation costs CPU and GPU time at runtime; every art change needs programming.

### Option 2: Licensed or free stock asset packs
- **Pros**: Faster route to detailed models, textures and recorded music.
- **Cons**: Per-asset licence terms and attribution to track; redistribution in a public repository may be restricted; binary files grow the repository and the precache; mixed styles.

### Option 3: Commissioned, hand-authored binary assets (glTF models, image textures, recorded audio)
- **Pros**: Full artistic control and ownership.
- **Cons**: Production cost and an asset pipeline (export, compression, loading); large binaries in git and in the offline cache.

## Decision
Adopt option 1.

### Graphics
- `src/client/render/track-mesh.ts` builds the road, shoulders, barriers, ramps, boost pads, landmarks and crowds from the simulation's `BuiltTrack`. Terrain, sky dome, karts, the 8 drivers, items and particles are generated three.js geometry (`src/client/render/`).
- Textures are drawn on canvases in code: the shared generators in `src/client/render/textures.ts` (canvases of at most 1024 px, seeded randomness so the same inputs give the same pixels), plus canvases drawn by the theme helpers and the kart decal atlas. There are no image assets.
- Each of the 8 themes has a scenery module in `src/client/render/themes/`.
- UI art is built in code: inline SVG icons, item icons and character portraits, a styled-text logo and canvas track thumbnails (`src/client/ui/art/`, `src/client/ui/thumb.ts`).
- Trackside sponsor banners use invented brands (`BRANDS` in `track-mesh.ts`, for example `ZOOM COLA` and `SPROUT TYRES`).

### Audio
- `src/client/audio/` synthesises everything with the Web Audio API and ships no audio files: 14 songs written in a pattern DSL and compiled at runtime (8 track songs, 5 menu cues, the star layer), 63 sound-effect ids, engine, drift and boost loops, and character voice chirps. Without Web Audio a silent implementation is used.
- `test/client/audio-songs.test.ts` fails when a song title matches `/mario|kart|nintendo|rainbow road|koopa|bowser|luigi|peach/i`.

### Remaining third-party content
- Code libraries: three.js (client) and Fastify with its `@fastify/*` plugins (server), all MIT, plus the AWS SDK for JavaScript v3 (server, Apache-2.0). Fonts: Black Han Sans and Jua through `@fontsource` (SIL Open Font License 1.1). The credits screen lists three.js, Fastify and both fonts (`src/client/ui/screens/credits.ts`).
- The only raster images in the client sources are the PWA icons in `public/icons/`, rendered from `public/favicon.svg`:

```bash
npx tsx tools/gen-icons.ts
```

## Consequences

### Positive
- Art and audio need no licence or IP review, and the credits stay short.
- The release build `0e18641074f0a351` precaches 176 files of about 3.4 MiB in total; 164 of them (about 1.4 MiB) are the woff2 subsets of the two fonts.
- Track and theme changes are reviewable code, and seeded generation keeps scenes reproducible for screenshot QA (`npm run qa:screens`).

### Negative
- A race scene is built on the CPU at race start (`RaceSession` construction, profiled by `tools/perf-build.ts`), and shader compilation is warmed up for up to 8 s (`WARMUP_CAP_MS` in `src/client/game/index.ts`).
- The generators are large source files: `track-mesh.ts` has 2473 lines, `themes/props-b.ts` 1859 and `kart-model.ts` 1501.
- No unit test exercises the theme builders or `track-mesh.ts` (the game tests mock them). Visual regressions are caught only with the dev pages under `src/client/dev/`, `npm run qa:screens` and the `tools/perf-*.ts` probes.
- Every art or music change needs a programmer.

## References
- [src/client/render/track-mesh.ts](../../src/client/render/track-mesh.ts), [src/client/render/textures.ts](../../src/client/render/textures.ts), [src/client/render/kart-model.ts](../../src/client/render/kart-model.ts), [src/client/render/themes/index.ts](../../src/client/render/themes/index.ts)
- [src/client/ui/art/portraits.ts](../../src/client/ui/art/portraits.ts), [src/client/ui/screens/credits.ts](../../src/client/ui/screens/credits.ts)
- [src/client/audio/index.ts](../../src/client/audio/index.ts), [src/client/audio/songs/index.ts](../../src/client/audio/songs/index.ts), [src/client/audio/event-map.ts](../../src/client/audio/event-map.ts)
- [test/client/audio-songs.test.ts](../../test/client/audio-songs.test.ts), [tools/gen-icons.ts](../../tools/gen-icons.ts), [tools/build.mjs](../../tools/build.mjs)
- [docs/design.md](../design.md), [docs/architecture.md](../architecture.md)

---

<a id="korean"></a>

# 한국어

## 상태
승인됨 (2026-09-24)

## 배경
- 목표는 마리오 카트 스타일의 플레이를 갖춘 상용 수준의 아케이드 카트 레이서이고, 캐릭터, 트랙, 아이템, 그래픽, 음악은 모두 새로 만든 것이어야 합니다. 제3자의 게임 IP는 들어갈 수 없습니다.
- 저장소는 GitHub에 "All rights reserved"(`LICENSE`)로 공개되어 있어, 커밋한 것은 모두 저장소와 함께 배포됩니다.
- PWA가 오프라인 플레이를 위해 게임 전체를 프리캐시하므로([ADR-006](ADR-006-offline-first-pwa-race-safe-updates.md)), 에셋이 늘어날수록 첫 다운로드와 오프라인 캐시가 커집니다.

## 검토한 옵션

### 옵션 1: 코드로 생성하는 절차적 콘텐츠 (채택)
- **장점**: 에셋 라이선스, 저작자 표시, 재배포 제한이 없습니다. diff로 검토하기 쉬운 작은 텍스트 소스이고, 시드 기반 생성이라 같은 결과가 재현되며, 스타일이 하나로 통일됩니다.
- **단점**: 그래픽과 사운드 품질이 코드에 달려 있습니다. 생성에 런타임 CPU와 GPU 시간이 들고, 그래픽을 바꿀 때마다 프로그래밍이 필요합니다.

### 옵션 2: 유료 또는 무료 스톡 에셋 팩
- **장점**: 정교한 모델, 텍스처, 녹음된 음악을 빨리 얻을 수 있습니다.
- **단점**: 에셋마다 라이선스 조건과 저작자 표시를 관리해야 합니다. 공개 저장소에서 재배포가 제한될 수 있고, 바이너리 파일이 저장소와 프리캐시를 키우며, 스타일이 섞입니다.

### 옵션 3: 직접 제작하거나 의뢰한 바이너리 에셋(glTF 모델, 이미지 텍스처, 녹음 오디오)
- **장점**: 예술적 통제와 소유권을 모두 가집니다.
- **단점**: 제작 비용과 에셋 파이프라인(내보내기, 압축, 로딩)이 필요하고, git과 오프라인 캐시에 큰 바이너리가 들어갑니다.

## 결정
옵션 1을 채택합니다.

### 그래픽
- `src/client/render/track-mesh.ts`가 시뮬레이션의 `BuiltTrack`에서 도로, 갓길, 배리어, 램프, 부스트 패드, 랜드마크, 관중을 만듭니다. 지형, 하늘 돔, 카트, 드라이버 8명, 아이템, 파티클도 모두 코드로 생성한 three.js 지오메트리입니다(`src/client/render/`).
- 텍스처는 코드에서 캔버스에 그립니다. `src/client/render/textures.ts`의 공용 생성기(캔버스 최대 1024 px, 시드 기반 난수라 같은 입력이면 같은 픽셀)에 더해 테마 헬퍼와 카트 데칼 아틀라스가 자체 캔버스를 그립니다. 이미지 에셋은 없습니다.
- 8개 테마마다 `src/client/render/themes/`에 배경 모듈이 하나씩 있습니다.
- UI 아트도 코드로 만듭니다. 아이콘, 아이템 아이콘, 캐릭터 초상화는 인라인 SVG이고, 로고는 스타일을 입힌 텍스트, 트랙 썸네일은 캔버스입니다(`src/client/ui/art/`, `src/client/ui/thumb.ts`).
- 트랙 옆 스폰서 배너는 지어낸 브랜드를 씁니다(`track-mesh.ts`의 `BRANDS`, 예: `ZOOM COLA`, `SPROUT TYRES`).

### 오디오
- `src/client/audio/`는 모든 소리를 Web Audio API로 합성하며 오디오 파일을 하나도 싣지 않습니다. 패턴 DSL로 작성해 런타임에 컴파일하는 곡 14개(트랙 곡 8개, 메뉴 cue 5개, 스타 레이어), 효과음 ID 63개, 엔진·드리프트·부스트 루프, 캐릭터 음성 chirp가 있습니다. Web Audio가 없으면 무음 구현을 씁니다.
- `test/client/audio-songs.test.ts`는 곡 제목이 `/mario|kart|nintendo|rainbow road|koopa|bowser|luigi|peach/i`에 걸리면 실패합니다.

### 남아 있는 제3자 콘텐츠
- 코드 라이브러리: three.js(클라이언트)와 Fastify 및 `@fastify/*` 플러그인(서버)은 모두 MIT이고, AWS SDK for JavaScript v3(서버)는 Apache-2.0입니다. 글꼴: `@fontsource`로 넣은 Black Han Sans와 Jua(SIL Open Font License 1.1). 크레딧 화면에는 three.js, Fastify, 두 글꼴이 표시됩니다(`src/client/ui/screens/credits.ts`).
- 클라이언트 소스에 있는 래스터 이미지는 `public/icons/`의 PWA 아이콘뿐이며, `public/favicon.svg`에서 렌더링합니다.

```bash
npx tsx tools/gen-icons.ts
```

## 영향

### 긍정적
- 그래픽과 오디오에 라이선스나 IP 검토가 필요 없고 크레딧도 짧습니다.
- 릴리스 빌드 `0e18641074f0a351`은 파일 176개, 합계 약 3.4 MiB를 프리캐시합니다. 그중 164개(약 1.4 MiB)는 두 글꼴의 woff2 서브셋입니다.
- 트랙과 테마 변경을 코드로 검토할 수 있고, 시드 기반 생성 덕분에 스크린샷 QA(`npm run qa:screens`)에서 장면이 재현됩니다.

### 부정적
- 레이스 장면을 레이스 시작 시점에 CPU로 만들고(`RaceSession` 생성, `tools/perf-build.ts`로 프로파일), 셰이더 컴파일을 최대 8 s 동안 예열합니다(`src/client/game/index.ts`의 `WARMUP_CAP_MS`).
- 생성기 소스 파일이 큽니다. `track-mesh.ts`는 2473줄, `themes/props-b.ts`는 1859줄, `kart-model.ts`는 1501줄입니다.
- 테마 빌더나 `track-mesh.ts`를 직접 검증하는 단위 테스트가 없습니다(게임 테스트는 이들을 mock합니다). 시각적 회귀는 `src/client/dev/`의 dev 페이지, `npm run qa:screens`, `tools/perf-*.ts` 프로브로만 잡을 수 있습니다.
- 그래픽이나 음악을 바꾸려면 항상 프로그래머가 필요합니다.

## 참고 자료
- [src/client/render/track-mesh.ts](../../src/client/render/track-mesh.ts), [src/client/render/textures.ts](../../src/client/render/textures.ts), [src/client/render/kart-model.ts](../../src/client/render/kart-model.ts), [src/client/render/themes/index.ts](../../src/client/render/themes/index.ts)
- [src/client/ui/art/portraits.ts](../../src/client/ui/art/portraits.ts), [src/client/ui/screens/credits.ts](../../src/client/ui/screens/credits.ts)
- [src/client/audio/index.ts](../../src/client/audio/index.ts), [src/client/audio/songs/index.ts](../../src/client/audio/songs/index.ts), [src/client/audio/event-map.ts](../../src/client/audio/event-map.ts)
- [test/client/audio-songs.test.ts](../../test/client/audio-songs.test.ts), [tools/gen-icons.ts](../../tools/gen-icons.ts), [tools/build.mjs](../../tools/build.mjs)
- [docs/design.md](../design.md), [docs/architecture.md](../architecture.md)
