# ADR-007: Claude Code Harness Adapted to Current Claude Code Behaviour

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Status
Accepted (2026-10-18)

## Context
- On 2026-10-18 the repository was published on GitHub (public) and a Claude Code harness was scaffolded with the `project-init` plugin (2.2.0): hooks, `.claude/settings.json`, skills, commands, agents, scripts and a shell test suite.
- The plugin templates were checked against the official Claude Code documentation (hooks, hooks guide, permissions, subagents, skills, MCP) for Claude Code 2.1.301. Several template constructs do not work as written:
  - Hook commands pass `"$TOOL_INPUT_PATH"`, `"$EVENT"` and `"$MESSAGE"`. Claude Code sets no such variables; a hook receives its input as JSON on stdin, so these hooks would silently do nothing.
  - The secret scan exits 1 and is registered as `... 2>/dev/null || true`. Only exit code 2 blocks a tool call, so it could never block a commit.
  - The secret scan uses `grep -P` (not available in BSD grep), reads working-tree files instead of the staged content, skips every `*.md` file and runs on every Bash command.
  - Plain stdout of a PostToolUse hook is not shown to Claude, so doc-sync reminders printed that way are lost.
  - Agents are generated as `.claude/agents/*.yml`; Claude Code loads only Markdown files with YAML frontmatter.
  - The deny rule `Bash(curl*| bash*)` can never match, because permission rules are evaluated per sub-command of a pipeline.
  - The commit-msg hook uses `sed -i` in its GNU-only form.
  - The test suite goes to `tests/`, while this project already uses `test/` for vitest.
- Project-specific: the new root files (`scripts/`, `LICENSE`, `.editorconfig`, `.mcp.json`, `.mcp.json.example`) and the nested `CLAUDE.md` files would enter the Docker build context of the production image. `.dockerignore` had only `*.md`, which in Docker ignore syntax matches the root directory only.

## Options Considered

### Option 1: Use the plugin templates verbatim
- **Pros**: No divergence from the plugin; easy to re-scaffold.
- **Cons**: Hooks silently do nothing, the secret scan cannot block, the agents are not loaded and the deny rule never matches; the harness would look protective without protecting anything.

### Option 2: Git hooks with husky and lint-staged
- **Pros**: Runs for every committer, not only for Claude Code sessions.
- **Cons**: Adds npm dev dependencies and an install step; gives Claude no context (doc-sync reminders, session briefing); `git commit --no-verify` skips it.

### Option 3: No harness (CLAUDE.md instructions and vitest only)
- **Pros**: Nothing extra to maintain.
- **Cons**: No automatic reminder for the simulation version bump ([ADR-001](ADR-001-deterministic-simulation-server-verification.md)) or for documentation updates, no secret guard before commits to a public repository, and the documentation format is never checked.

### Option 4: Keep the plugin's structure, adapt every piece to documented behaviour (chosen)
- **Pros**: The hooks really run and block; reminders reach Claude; the harness tests itself.
- **Cons**: Diverges from the plugin templates, so re-running the scaffolder can overwrite the adaptations; must be re-checked when Claude Code changes its hook or permission behaviour.

## Decision
Adopt option 4.

### Hooks (`.claude/hooks/`, registered in `.claude/settings.json`)
- Every hook reads its input as JSON on stdin (with `jq` when available, otherwise `node`). Commands are written as `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.sh`, each with a timeout.
- `check-doc-sync.sh` (PostToolUse, matcher `Write|Edit`) never blocks. It prints its reminders as `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`, the form that reaches Claude: missing module `CLAUDE.md`, `[sim-version]` for `src/sim/`, API, data and security doc updates, `[docker-context]`, infrastructure docs, and missing ADRs or runbooks.
- `secret-scan.sh` (PreToolUse, matcher `Bash`) runs only for `git commit`, through the hook `if` field shown below; the script re-checks the command itself for Claude Code versions that ignore `if`. It scans the staged index with `git grep --cached -I` using POSIX ERE patterns only (15 pattern families, so BSD grep works too), skips `package-lock.json`, `*.example`, its own pattern file, the pattern test and `test/harness/fixtures/*`, and blocks with exit 2. Its report names only files and pattern labels, never the matched value.
- `session-context.sh` (SessionStart) prints plain text, which SessionStart adds to Claude's context: name, version, branch, last commit, the number of uncommitted files and of `CLAUDE.md` files, the deployed site URL from the git-ignored `cdk-outputs.json` (when `jq` is installed), and the two project rules (simulation version bump; deploy through the runbook, never destroy `TurboPalsStack` without an explicit request).
- `notify.sh` (Notification) posts a Slack-compatible `{"text": ...}` payload to `$CLAUDE_NOTIFY_WEBHOOK` in the background with a 5 s timeout; `CLAUDE_NOTIFY_DRY_RUN=1` prints it instead.

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "if": "Bash(git commit *)",
      "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/secret-scan.sh",
      "timeout": 30
    }
  ]
}
```

### Permissions, agents and MCP
- Deny rules use the space form (`Bash(rm -rf *)`). The bare shells `Bash(bash)` and `Bash(sh)` are denied, which catches `curl ... | bash`. Project-specific denies cover `npx cdk destroy*`, `cdk destroy*`, `aws cloudformation delete-stack *`, `aws dynamodb delete-table *` and `aws secretsmanager delete-secret *`. Deny rules are a guard rail, not a security boundary.
- Agents are Markdown files with YAML frontmatter (`.claude/agents/code-reviewer.md`, `.claude/agents/security-auditor.md`); `tools` lists tool names only (`Read, Glob, Grep, Bash`), and command restrictions live in the agent body.
- `.mcp.json` is committed with an empty `mcpServers` object; `.mcp.json.example` shows servers with `${VAR}` token references.

### Git hook, test suite and Docker context
- `scripts/install-hooks.sh` installs a `commit-msg` hook (POSIX `sh`, `grep`, `awk`) that removes `Co-Authored-By` trailers in any letter case; `scripts/setup.sh` runs it after checking git and Node.js 22.12 or later and running `npm ci`.
- The harness suite lives in `test/harness/` (shell and Node.js, no vitest). vitest includes only `test/**/*.test.ts`, so it never picks up the shell files, and `test` is already excluded from the Docker context. It covers hook behaviour with real hook JSON, the secret patterns (fixtures store token prefixes as markers expanded at runtime, so no complete token is committed), the project structure and the documentation format.
- `.dockerignore` and `IMAGE_CONTEXT_EXCLUDE` (`infra/lib/service.ts`) both add `scripts`, `LICENSE`, `.editorconfig`, `.mcp.json`, `.mcp.json.example` and `**/*.md`; `test/harness/structure/check-docs.mjs` asserts that both lists are identical, in the same order.

```bash
npm run test:harness
bash test/harness/run-all.sh hooks
bash .claude/hooks/secret-scan.sh --all
```

## Consequences

### Positive
- A staged secret blocks `git commit` from Claude Code (`test/harness/hooks/test-hooks.sh` asserts exit 2 in a throwaway repository).
- Claude is reminded of the version bump rule and of the documents to update right after each edit.
- The documentation contracts (bilingual parity, Mermaid, links, ADR numbering) and the Docker context parity are checked by `npm run test:harness`.
- Harness and documentation edits stay out of the image build context.

### Negative
- The harness diverges from the `project-init` templates; re-running the scaffolder or its commands can overwrite these adaptations, so review such changes against this ADR.
- The behaviour depends on Claude Code details (stdin JSON, exit 2, `additionalContext`, the `if` field) that must be re-checked after Claude Code upgrades.
- The secret patterns are heuristics; false positives are handled by editing the pattern and adding the line to `test/harness/fixtures/false-positives.txt`.
- The `commit-msg` hook must be installed in every clone (`bash scripts/install-hooks.sh`), and the Claude Code hooks protect only Claude Code sessions.
- The harness work also edited files that stay in the image build context (`package.json` gained the `test:harness` script; `.dockerignore` and `.gitignore` changed), so the image asset hash differs from the deployed one: a local synth on 2026-10-18 produced `APP_VERSION` `1.0.0+68271b5436f7` against the live `1.0.0+bc87c1a48e07`. The next deploy therefore builds and rolls out a new image although no runtime code changed.

## References
- [.claude/settings.json](../../.claude/settings.json), [.claude/hooks/check-doc-sync.sh](../../.claude/hooks/check-doc-sync.sh), [.claude/hooks/secret-scan.sh](../../.claude/hooks/secret-scan.sh), [.claude/hooks/session-context.sh](../../.claude/hooks/session-context.sh), [.claude/hooks/notify.sh](../../.claude/hooks/notify.sh)
- [.claude/agents/code-reviewer.md](../../.claude/agents/code-reviewer.md), [.claude/agents/security-auditor.md](../../.claude/agents/security-auditor.md), [.mcp.json.example](../../.mcp.json.example)
- [scripts/setup.sh](../../scripts/setup.sh), [scripts/install-hooks.sh](../../scripts/install-hooks.sh)
- [test/harness/run-all.sh](../../test/harness/run-all.sh), [test/harness/hooks/test-hooks.sh](../../test/harness/hooks/test-hooks.sh), [test/harness/hooks/test-secret-patterns.sh](../../test/harness/hooks/test-secret-patterns.sh), [test/harness/structure/check-docs.mjs](../../test/harness/structure/check-docs.mjs)
- [.dockerignore](../../.dockerignore), [infra/lib/service.ts](../../infra/lib/service.ts), [vitest.config.ts](../../vitest.config.ts)
- [CLAUDE.md](../../CLAUDE.md) (Auto-Sync Rules)
- Claude Code documentation: [hooks](https://code.claude.com/docs/en/hooks), [hooks guide](https://code.claude.com/docs/en/hooks-guide), [permissions](https://code.claude.com/docs/en/permissions), [subagents](https://code.claude.com/docs/en/sub-agents), [skills](https://code.claude.com/docs/en/skills), [MCP](https://code.claude.com/docs/en/mcp)

---

<a id="korean"></a>

# 한국어

## 상태
승인됨 (2026-10-18)

## 배경
- 2026-10-18에 저장소를 GitHub에 공개로 올렸고, `project-init` 플러그인(2.2.0)으로 Claude Code harness를 구성했습니다. hook, `.claude/settings.json`, skill, command, agent, 스크립트, 셸 테스트 묶음이 포함됩니다.
- 플러그인 템플릿을 Claude Code 2.1.301 기준 공식 문서(hooks, hooks guide, permissions, subagents, skills, MCP)와 대조해 보니, 템플릿 그대로는 동작하지 않는 부분이 여럿 있었습니다.
  - hook 명령이 `"$TOOL_INPUT_PATH"`, `"$EVENT"`, `"$MESSAGE"`를 넘깁니다. Claude Code는 이런 변수를 설정하지 않고 hook 입력을 stdin JSON으로 주므로, 이 hook들은 아무 일도 하지 않은 채 조용히 끝납니다.
  - secret scan은 exit 1로 끝나고 `... 2>/dev/null || true` 형태로 등록됩니다. 도구 호출을 막는 종료 코드는 2뿐이라 커밋을 절대 막을 수 없습니다.
  - secret scan이 `grep -P`(BSD grep에 없음)를 쓰고, 스테이징된 내용이 아니라 작업 트리 파일을 읽으며, `*.md`를 모두 건너뛰고, 모든 Bash 명령마다 실행됩니다.
  - PostToolUse hook의 일반 stdout은 Claude에게 보이지 않으므로, 그렇게 출력한 문서 동기화 알림은 사라집니다.
  - agent를 `.claude/agents/*.yml`로 만듭니다. Claude Code는 YAML frontmatter가 있는 Markdown 파일만 불러옵니다.
  - deny 규칙 `Bash(curl*| bash*)`는 절대 일치하지 않습니다. 권한 규칙은 파이프라인의 하위 명령마다 따로 평가되기 때문입니다.
  - commit-msg hook이 GNU 전용 형태의 `sed -i`를 씁니다.
  - 테스트 묶음을 `tests/`에 두는데, 이 프로젝트는 이미 vitest용으로 `test/`를 씁니다.
- 프로젝트 고유 문제: 새 루트 파일(`scripts/`, `LICENSE`, `.editorconfig`, `.mcp.json`, `.mcp.json.example`)과 하위 디렉터리의 `CLAUDE.md` 파일이 프로덕션 이미지의 Docker 빌드 컨텍스트에 들어갑니다. `.dockerignore`에는 `*.md`만 있었는데, Docker ignore 문법에서 이 패턴은 루트 디렉터리에만 적용됩니다.

## 검토한 옵션

### 옵션 1: 플러그인 템플릿을 그대로 사용
- **장점**: 플러그인과 차이가 없어 다시 생성하기 쉽습니다.
- **단점**: hook은 조용히 아무 일도 하지 않고, secret scan은 막지 못하며, agent는 로드되지 않고, deny 규칙은 일치하지 않습니다. 보호하는 것처럼 보이지만 실제로는 아무것도 보호하지 않습니다.

### 옵션 2: husky와 lint-staged를 쓰는 git hook
- **장점**: Claude Code 세션뿐 아니라 모든 커밋 작성자에게 적용됩니다.
- **단점**: npm 개발 의존성과 설치 단계가 늘어납니다. Claude에게 문맥(문서 동기화 알림, 세션 브리핑)을 주지 못하고, `git commit --no-verify`로 건너뛸 수 있습니다.

### 옵션 3: harness 없음(CLAUDE.md 지침과 vitest만)
- **장점**: 따로 유지보수할 것이 없습니다.
- **단점**: 시뮬레이션 버전 bump([ADR-001](ADR-001-deterministic-simulation-server-verification.md))나 문서 갱신을 자동으로 알려 주지 않고, 공개 저장소에 커밋하기 전 비밀 값 검사도 없으며, 문서 형식도 검사하지 않습니다.

### 옵션 4: 플러그인 구조는 유지하고 모든 구성 요소를 문서화된 동작에 맞게 수정 (채택)
- **장점**: hook이 실제로 실행되고 막아야 할 때 막습니다. 알림이 Claude에게 전달되고, harness가 스스로를 테스트합니다.
- **단점**: 플러그인 템플릿과 달라지므로 scaffolder를 다시 실행하면 수정 사항을 덮어쓸 수 있습니다. Claude Code의 hook이나 권한 동작이 바뀌면 다시 확인해야 합니다.

## 결정
옵션 4를 채택합니다.

### Hook (`.claude/hooks/`, `.claude/settings.json`에 등록)
- 모든 hook은 입력을 stdin JSON으로 읽습니다(`jq`가 있으면 `jq`, 없으면 `node`). 명령은 `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.sh` 형태이고 각각 타임아웃이 있습니다.
- `check-doc-sync.sh`(PostToolUse, matcher `Write|Edit`)는 절대 막지 않습니다. 알림을 Claude에게 전달되는 형태인 `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`로 출력합니다. 알림 내용은 모듈 `CLAUDE.md` 누락, `src/sim/`의 `[sim-version]`, API·데이터·보안 문서 갱신, `[docker-context]`, 인프라 문서, ADR과 runbook 누락입니다.
- `secret-scan.sh`(PreToolUse, matcher `Bash`)는 아래의 hook `if` 필드로 `git commit`일 때만 실행됩니다. `if`를 무시하는 Claude Code 버전에 대비해 스크립트가 명령을 한 번 더 확인합니다. `git grep --cached -I`로 스테이징된 index를 POSIX ERE 패턴만으로 검사하고(패턴 15종, BSD grep에서도 동작), `package-lock.json`, `*.example`, 자기 패턴 파일, 패턴 테스트, `test/harness/fixtures/*`는 건너뛰며, exit 2로 막습니다. 보고에는 파일 이름과 패턴 이름만 나오고 일치한 값은 나오지 않습니다.
- `session-context.sh`(SessionStart)는 일반 텍스트를 출력하고, SessionStart는 이를 Claude의 문맥에 더합니다. 이름, 버전, 브랜치, 마지막 커밋, 커밋하지 않은 파일 수와 `CLAUDE.md` 파일 수, git에서 제외된 `cdk-outputs.json`의 배포 사이트 URL(`jq`가 설치된 경우), 그리고 프로젝트 규칙 두 가지(시뮬레이션 버전 bump, runbook으로 배포하고 명시적 요청 없이 `TurboPalsStack`을 지우지 않기)가 들어갑니다.
- `notify.sh`(Notification)는 Slack 호환 `{"text": ...}` payload를 백그라운드에서 5 s 타임아웃으로 `$CLAUDE_NOTIFY_WEBHOOK`에 보냅니다. `CLAUDE_NOTIFY_DRY_RUN=1`이면 보내지 않고 출력만 합니다.

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "if": "Bash(git commit *)",
      "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/secret-scan.sh",
      "timeout": 30
    }
  ]
}
```

### 권한, agent, MCP
- deny 규칙은 공백 형식(`Bash(rm -rf *)`)을 씁니다. 맨 셸인 `Bash(bash)`와 `Bash(sh)`를 막아 `curl ... | bash`를 잡습니다. 프로젝트 전용으로 `npx cdk destroy*`, `cdk destroy*`, `aws cloudformation delete-stack *`, `aws dynamodb delete-table *`, `aws secretsmanager delete-secret *`를 막습니다. deny 규칙은 안전장치일 뿐 보안 경계가 아닙니다.
- agent는 YAML frontmatter가 있는 Markdown 파일입니다(`.claude/agents/code-reviewer.md`, `.claude/agents/security-auditor.md`). `tools`에는 도구 이름만 적고(`Read, Glob, Grep, Bash`), 명령 제한은 agent 본문에 둡니다.
- `.mcp.json`은 빈 `mcpServers` 객체로 커밋하고, `.mcp.json.example`에 `${VAR}` 토큰 참조를 쓰는 서버 예시를 둡니다.

### Git hook, 테스트 묶음, Docker 컨텍스트
- `scripts/install-hooks.sh`는 대소문자와 상관없이 `Co-Authored-By` trailer를 지우는 `commit-msg` hook(POSIX `sh`, `grep`, `awk`)을 설치합니다. `scripts/setup.sh`는 git과 Node.js 22.12 이상을 확인하고 `npm ci`를 실행한 뒤 이 스크립트를 실행합니다.
- harness 테스트는 `test/harness/`에 있습니다(셸과 Node.js, vitest 아님). vitest는 `test/**/*.test.ts`만 포함하므로 셸 파일을 집어 가지 않고, `test`는 이미 Docker 컨텍스트에서 빠져 있습니다. 실제 hook JSON으로 hook 동작을, 비밀 값 패턴을(fixture는 토큰 접두어를 런타임에 펼치는 표식으로 저장하므로 완전한 토큰이 커밋되지 않습니다), 프로젝트 구조와 문서 형식을 검사합니다.
- `.dockerignore`와 `IMAGE_CONTEXT_EXCLUDE`(`infra/lib/service.ts`)에 `scripts`, `LICENSE`, `.editorconfig`, `.mcp.json`, `.mcp.json.example`, `**/*.md`를 함께 추가했습니다. `test/harness/structure/check-docs.mjs`가 두 목록이 순서까지 같은지 확인합니다.

```bash
npm run test:harness
bash test/harness/run-all.sh hooks
bash .claude/hooks/secret-scan.sh --all
```

## 영향

### 긍정적
- 스테이징된 비밀 값이 있으면 Claude Code의 `git commit`이 막힙니다(`test/harness/hooks/test-hooks.sh`가 임시 저장소에서 exit 2를 단언).
- 파일을 고친 직후 Claude에게 버전 bump 규칙과 갱신할 문서를 알려 줍니다.
- 문서 계약(두 언어의 구조 일치, Mermaid, 링크, ADR 번호)과 Docker 컨텍스트 일치를 `npm run test:harness`가 검사합니다.
- harness와 문서를 고쳐도 이미지 빌드 컨텍스트에는 들어가지 않습니다.

### 부정적
- harness가 `project-init` 템플릿과 달라졌습니다. scaffolder나 그 명령을 다시 실행하면 이 수정 사항을 덮어쓸 수 있으므로, 그런 변경은 이 ADR과 대조해 검토합니다.
- 동작이 Claude Code 세부 사항(stdin JSON, exit 2, `additionalContext`, `if` 필드)에 기대므로 Claude Code를 올린 뒤에는 다시 확인해야 합니다.
- 비밀 값 패턴은 휴리스틱입니다. 오탐은 패턴을 고치고 그 줄을 `test/harness/fixtures/false-positives.txt`에 추가해 처리합니다.
- `commit-msg` hook은 clone마다 설치해야 하고(`bash scripts/install-hooks.sh`), Claude Code hook은 Claude Code 세션만 보호합니다.
- harness 작업에서 이미지 빌드 컨텍스트에 그대로 남는 파일도 고쳤습니다(`package.json`에 `test:harness` 스크립트 추가, `.dockerignore`와 `.gitignore` 변경). 그래서 이미지 asset 해시가 배포된 것과 다릅니다. 2026-10-18에 로컬에서 synth한 `APP_VERSION`은 `1.0.0+68271b5436f7`이고 라이브는 `1.0.0+bc87c1a48e07`입니다. 런타임 코드는 바뀌지 않았지만 다음 배포는 새 이미지를 빌드해 내보냅니다.

## 참고 자료
- [.claude/settings.json](../../.claude/settings.json), [.claude/hooks/check-doc-sync.sh](../../.claude/hooks/check-doc-sync.sh), [.claude/hooks/secret-scan.sh](../../.claude/hooks/secret-scan.sh), [.claude/hooks/session-context.sh](../../.claude/hooks/session-context.sh), [.claude/hooks/notify.sh](../../.claude/hooks/notify.sh)
- [.claude/agents/code-reviewer.md](../../.claude/agents/code-reviewer.md), [.claude/agents/security-auditor.md](../../.claude/agents/security-auditor.md), [.mcp.json.example](../../.mcp.json.example)
- [scripts/setup.sh](../../scripts/setup.sh), [scripts/install-hooks.sh](../../scripts/install-hooks.sh)
- [test/harness/run-all.sh](../../test/harness/run-all.sh), [test/harness/hooks/test-hooks.sh](../../test/harness/hooks/test-hooks.sh), [test/harness/hooks/test-secret-patterns.sh](../../test/harness/hooks/test-secret-patterns.sh), [test/harness/structure/check-docs.mjs](../../test/harness/structure/check-docs.mjs)
- [.dockerignore](../../.dockerignore), [infra/lib/service.ts](../../infra/lib/service.ts), [vitest.config.ts](../../vitest.config.ts)
- [CLAUDE.md](../../CLAUDE.md) (Auto-Sync Rules)
- Claude Code 공식 문서: [hooks](https://code.claude.com/docs/en/hooks), [hooks guide](https://code.claude.com/docs/en/hooks-guide), [permissions](https://code.claude.com/docs/en/permissions), [subagents](https://code.claude.com/docs/en/sub-agents), [skills](https://code.claude.com/docs/en/skills), [MCP](https://code.claude.com/docs/en/mcp)
