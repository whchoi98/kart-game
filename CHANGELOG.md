# Changelog

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Add the LICENSE file (all rights reserved)
- Add gameplay screenshots to the README: title screen, main menu and race scenes on four tracks, including 2-player split screen (`docs/images/`)
- Add bilingual (English and Korean) project documentation: README, architecture, architecture decision records, runbooks, implementation references, API reference and onboarding guide
- Add developer tooling: Claude Code hooks, skills, commands and agents in `.claude/`, the shell test harness (`npm run test:harness`), `scripts/setup.sh`, `scripts/install-hooks.sh` and `.env.example`

### Changed
- Exclude `scripts`, `LICENSE`, `.editorconfig`, `.mcp.json`, `.mcp.json.example` and Markdown files in subdirectories (`**/*.md`) from the Docker build context (`.dockerignore` and `IMAGE_CONTEXT_EXCLUDE`)

## [1.0.0] - 2026-09-24

### Added
- Add arcade 3D kart racing in the browser with deterministic 60 Hz physics, three-level drift mini-turbos, jump trick boosts, rocket starts, off-road, mud and ice surfaces, and a coin speed bonus
- Add 8 original drivers whose speed, acceleration, weight and handling stats each total 14
- Add 8 tracks in 2 cups (Sprout Cup and Thunder Cup), each raced over 3 laps
- Add 4 speed classes (50cc, 100cc, 150cc, 200cc) and mirror mode; a 150cc Grand Prix gold trophy unlocks 200cc, and gold in both 150cc cups unlocks mirror mode
- Add 14 items with position-weighted odds, including triple variants, and item shields held behind the kart or orbiting it
- Add CPU rivals with racing lines, drifting, hazard avoidance, item tactics and rubber-banding at three difficulty levels (easy, normal, hard)
- Add Grand Prix (4-race cups with points, reverse-order grids, trophies and a podium), VS Race, Time Trial and 2-player split-screen modes
- Add time-trial ghosts: race against your personal best, the world record or any leaderboard entry
- Add online time-trial rankings (top 50 per track and speed class) that the server verifies by re-simulating each submitted input log
- Add procedural three.js graphics with themed terrain, props and skies, shadows, bloom, particles and automatic quality scaling
- Add procedurally synthesized WebAudio music with an original song for every track and a final-lap tempo lift, plus engine, drift and item sound effects
- Add keyboard, standard gamepad (with rumble) and touch controls
- Add settings for volume, graphics quality, camera distance, screen shake, speedometer, FPS display, auto-accelerate, rumble and nickname
- Add PWA support: app install, offline play in every mode except online rankings, offline time-trial records queued for later submission, and updates applied only between races
- Host the game on AWS at https://my-kart.whchoi.net (Amazon CloudFront, Application Load Balancer, Amazon ECS on AWS Fargate, Amazon DynamoDB)

[Unreleased]: https://github.com/whchoi98/kart-game/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/whchoi98/kart-game/releases/tag/v1.0.0

---

<a id="korean"></a>

# 한국어

이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.
이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 기반으로 하며,
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

## [Unreleased]

### Added
- LICENSE 파일 추가 (All rights reserved)
- README에 게임 실행 화면 추가: 타이틀 화면, 메인 메뉴, 2인 분할 화면을 포함한 트랙 4곳의 레이스 장면 (`docs/images/`)
- 영어·한국어 이중 언어 프로젝트 문서 추가: README, 아키텍처, 아키텍처 결정 기록(ADR), 런북, 구현 레퍼런스, API 레퍼런스, 온보딩 가이드
- 개발 도구 추가: `.claude/`의 Claude Code hook·skill·command·agent, 셸 테스트 하네스(`npm run test:harness`), `scripts/setup.sh`, `scripts/install-hooks.sh`, `.env.example`

### Changed
- Docker 빌드 컨텍스트에서 `scripts`, `LICENSE`, `.editorconfig`, `.mcp.json`, `.mcp.json.example`, 하위 디렉터리의 Markdown 파일(`**/*.md`) 제외 (`.dockerignore`, `IMAGE_CONTEXT_EXCLUDE`)

## [1.0.0] - 2026-09-24

### Added
- 결정론적 60 Hz 물리, 3단계 드리프트 미니 터보, 점프 트릭 부스트, 로켓 스타트, 오프로드·진흙·빙판 노면, 코인 속도 보너스를 갖춘 브라우저 아케이드 3D 카트 레이싱 추가
- 속도·가속·무게·핸들링 능력치 합이 모두 14인 오리지널 드라이버 8명 추가
- 2개 컵(새싹 컵, 번개 컵)에 나뉜 8개 트랙 추가 (트랙마다 3랩)
- 4개 속도 클래스(50cc, 100cc, 150cc, 200cc)와 미러 모드 추가. 150cc 그랑프리 금 트로피로 200cc, 150cc 두 컵 모두 금 트로피로 미러 모드 해금
- 순위에 따라 확률이 달라지는 아이템 14종 추가 (×3 아이템 포함, 카트 뒤에 매달거나 주위를 도는 아이템 방패 지원)
- 레이싱 라인, 드리프트, 위험물 회피, 아이템 전술, 러버밴딩을 쓰는 3단계 난이도(easy, normal, hard) CPU 라이벌 추가
- 그랑프리(4개 레이스 컵, 포인트제, 역순 그리드, 트로피, 시상대), VS 레이스, 타임 어택, 2인 분할 화면 모드 추가
- 타임 어택 고스트 추가: 개인 최고 기록, 세계 1위 기록, 랭킹의 다른 기록과 대결
- 서버가 제출된 입력 로그를 재시뮬레이션해 검증하는 타임 어택 온라인 순위 추가 (트랙·속도 클래스별 상위 50개)
- 테마별 지형·소품·하늘, 그림자, 블룸, 파티클, 자동 화질 조절을 갖춘 three.js 절차적 그래픽 추가
- 트랙별 오리지널 곡과 마지막 랩 템포 업을 갖춘 WebAudio 절차적 음악과 엔진·드리프트·아이템 효과음 추가
- 키보드, 표준 게임패드(진동 지원), 터치 컨트롤 추가
- 음량, 그래픽 품질, 카메라 거리, 화면 흔들림, 속도계, FPS 표시, 자동 가속, 진동, 닉네임 설정 추가
- PWA 지원 추가: 앱 설치, 온라인 순위를 뺀 모든 모드의 오프라인 플레이, 오프라인 타임 어택 기록의 대기열 보관과 이후 제출, 레이스 사이에만 적용되는 업데이트
- https://my-kart.whchoi.net 에서 AWS로 서비스 시작 (Amazon CloudFront, Application Load Balancer, AWS Fargate 기반 Amazon ECS, Amazon DynamoDB)

[Unreleased]: https://github.com/whchoi98/kart-game/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/whchoi98/kart-game/releases/tag/v1.0.0
