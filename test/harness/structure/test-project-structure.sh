#!/usr/bin/env bash
# Project structure: root files, CLAUDE.md coverage, .claude/ components, scripts, docs layout,
# and the document contracts checked by check-docs.mjs. Sourced by test/harness/run-all.sh.

# --- Root files ---
for f in CLAUDE.md README.md CHANGELOG.md LICENSE .gitignore .env.example .editorconfig .mcp.json .mcp.json.example; do
    assert_file_exists "root: $f" "$f"
done
assert_json_valid ".mcp.json is valid JSON" ".mcp.json"
assert_json_valid ".mcp.json.example is valid JSON" ".mcp.json.example"
if node -e 'const j=JSON.parse(require("fs").readFileSync(".mcp.json","utf8"));process.exit(j&&typeof j.mcpServers==="object"&&!Array.isArray(j.mcpServers)?0:1)' 2>/dev/null; then
    pass ".mcp.json has an mcpServers object"
else
    fail ".mcp.json has an mcpServers object" "expected {\"mcpServers\": {...}}"
fi
if bash .claude/hooks/secret-scan.sh --check-stdin < .mcp.json >/dev/null; then pass ".mcp.json holds no secrets"; else fail ".mcp.json holds no secrets" "secret pattern matched"; fi
if grep -qE '\$\{[A-Z_]+\}' .mcp.json.example; then pass ".mcp.json.example uses \${VAR} references for tokens"; else fail ".mcp.json.example uses \${VAR} references" "no \${VAR}"; fi

GITIGNORE=$(cat .gitignore)
assert_contains ".gitignore excludes .env" "$GITIGNORE" ".env"
assert_contains ".gitignore excludes settings.local.json" "$GITIGNORE" "settings.local.json"
if git check-ignore -q .claude/settings.local.json; then pass ".claude/settings.local.json is ignored"; else fail ".claude/settings.local.json is ignored" "git check-ignore"; fi
if git check-ignore -q .claude/settings.json; then fail ".claude/settings.json is committed (not ignored)" "ignored"; else pass ".claude/settings.json is committed (not ignored)"; fi

ENV_EXAMPLE=$(cat .env.example)
for var in NODE_ENV HOST PORT STATIC_DIR TABLE_NAME AWS_REGION PUBLIC_ORIGIN ALLOWED_ORIGINS APP_VERSION LOG_LEVEL TURBO_DEBUG_HOOK DYNAMODB_TEST_ENDPOINT CLAUDE_NOTIFY_WEBHOOK; do
    assert_contains ".env.example documents $var" "$ENV_EXAMPLE" "$var"
done
if bash .claude/hooks/secret-scan.sh --check-stdin < .env.example >/dev/null; then pass ".env.example holds no secret values"; else fail ".env.example holds no secret values" "secret pattern matched"; fi

# --- Root CLAUDE.md ---
for section in "Overview" "Tech Stack" "Project Structure" "Conventions" "Key Commands" "Auto-Sync Rules" "Implementation References"; do
    if grep -qE "^## $section\$" CLAUDE.md 2>/dev/null; then pass "CLAUDE.md: ## $section"; else fail "CLAUDE.md: ## $section" "not found"; fi
done
ROOT_LINES=$(wc -l < CLAUDE.md 2>/dev/null | tr -d ' ')
if [ "${ROOT_LINES:-0}" -gt 0 ] && [ "$ROOT_LINES" -lt 500 ]; then pass "CLAUDE.md: under 500 lines ($ROOT_LINES)"; else fail "CLAUDE.md: under 500 lines" "${ROOT_LINES:-0} lines"; fi
# Every command in Key Commands must exist (npm scripts and referenced files).
for script in dev build start typecheck test test:harness synth deploy qa:screens verify:live; do
    if node -e 'process.exit(require("./package.json").scripts?.[process.argv[1]]?0:1)' "$script"; then
        pass "package.json script exists: $script"
    else
        fail "package.json script exists: $script" "missing"
    fi
done

# --- Module CLAUDE.md coverage: every directory under src/, plus infra/, test/, tools/ ---
while IFS= read -r dir; do
    assert_file_exists "module doc: $dir/CLAUDE.md" "$dir/CLAUDE.md"
done < <(find src -mindepth 1 -type d | sort)
for dir in infra test tools; do
    assert_file_exists "module doc: $dir/CLAUDE.md" "$dir/CLAUDE.md"
done
while IFS= read -r doc; do
    for section in "## Role" "## Key Files" "## Rules"; do
        if grep -qF -- "$section" "$doc"; then pass "$doc: $section"; else fail "$doc: $section" "section missing"; fi
    done
done < <(find src infra test tools -name CLAUDE.md | sort)

# --- .claude/ components ---
frontmatter_has() {   # $1 = file, $2 = key → true when the YAML frontmatter (first block) defines key
    awk -v key="$2" 'NR==1 && $0!="---" {exit 1} NR>1 && $0=="---" {exit found?0:1} NR>1 && index($0, key":")==1 {found=1} END {if (NR<2) exit 1}' "$1"
}
for skill in code-review refactor release sync-docs; do
    f=".claude/skills/$skill/SKILL.md"
    assert_file_exists "skill: $skill" "$f"
    if [ -f "$f" ] && frontmatter_has "$f" name && frontmatter_has "$f" description; then pass "skill $skill: frontmatter name + description"; else fail "skill $skill: frontmatter name + description" "missing"; fi
done
for cmd in review test-all deploy; do
    f=".claude/commands/$cmd.md"
    assert_file_exists "command: /$cmd" "$f"
    if [ -f "$f" ] && frontmatter_has "$f" description && frontmatter_has "$f" allowed-tools; then pass "command $cmd: frontmatter description + allowed-tools"; else fail "command $cmd: frontmatter description + allowed-tools" "missing"; fi
done
for agent in code-reviewer security-auditor; do
    f=".claude/agents/$agent.md"
    assert_file_exists "agent: $agent (Markdown + YAML frontmatter)" "$f"
    if [ -f "$f" ] && frontmatter_has "$f" name && frontmatter_has "$f" description && frontmatter_has "$f" tools; then pass "agent $agent: frontmatter name + description + tools"; else fail "agent $agent: frontmatter" "missing"; fi
done
STRAY_YML=$(find .claude/agents -name '*.yml' -o -name '*.yaml' 2>/dev/null)
assert_eq "no .yml agent files (Claude Code loads only .md agents)" "" "$STRAY_YML"

# --- Scripts ---
for script in scripts/setup.sh scripts/install-hooks.sh test/harness/run-all.sh; do
    assert_file_executable "$script is executable" "$script"
    assert_bash_syntax "$script is valid bash" "$script"
done
COMMIT_MSG_HOOK="$(git rev-parse --git-path hooks 2>/dev/null)/commit-msg"
if [ -x "$COMMIT_MSG_HOOK" ] && grep -q 'managed-by: scripts/install-hooks.sh' "$COMMIT_MSG_HOOK"; then
    TMP_MSG=$(mktemp)
    printf 'feat: x\n\nbody\n\nCo-Authored-By: Someone <a@b.c>\nco-authored-by: Other <d@e.f>\n\n' > "$TMP_MSG"
    sh "$COMMIT_MSG_HOOK" "$TMP_MSG"
    assert_eq "commit-msg hook strips Co-Authored-By trailers" "$(printf 'feat: x\n\nbody')" "$(cat "$TMP_MSG")"
    rm -f "$TMP_MSG"
else
    skip "commit-msg hook behaviour" "not installed (run bash scripts/install-hooks.sh)"
fi

# --- docs/ layout ---
for f in docs/architecture.md docs/onboarding.md docs/api-reference.md docs/decisions/.template.md docs/runbooks/.template.md docs/reference/INDEX.md \
         docs/decisions/ADR-001-deterministic-simulation-server-verification.md docs/runbooks/deploy-production.md; do
    assert_file_exists "docs: $f" "$f"
done
ADR_COUNT=$(find docs/decisions -name 'ADR-*.md' 2>/dev/null | wc -l | tr -d ' ')
RUNBOOK_COUNT=$(find docs/runbooks -name '*.md' ! -name '.template.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "$ADR_COUNT" -ge 1 ]; then pass "docs/decisions has ADRs ($ADR_COUNT)"; else fail "docs/decisions has ADRs" "none"; fi
if [ "$RUNBOOK_COUNT" -ge 1 ]; then pass "docs/runbooks has runbooks ($RUNBOOK_COUNT)"; else fail "docs/runbooks has runbooks" "none"; fi
# ADR numbering: ADR-NNN-kebab-title.md, consecutive from 001.
EXPECTED=1
while IFS= read -r adr; do
    name=$(basename "$adr")
    num=$(printf '%03d' "$EXPECTED")
    if [[ "$name" =~ ^ADR-${num}-[a-z0-9]+(-[a-z0-9]+)*\.md$ ]]; then pass "ADR numbering: $name"; else fail "ADR numbering: $name" "expected ADR-$num-<kebab-title>.md"; fi
    EXPECTED=$((EXPECTED + 1))
done < <(find docs/decisions -name 'ADR-*.md' | sort)

# --- Document contracts (bilingual structure, links, reference docs, README/CHANGELOG, Docker context) ---
while IFS=$'\t' read -r status desc detail; do
    case "$status" in
        PASS) pass "$desc" ;;
        FAIL) fail "$desc" "$detail" ;;
    esac
done < <(node "$HARNESS_DIR/structure/check-docs.mjs" 2>&1 || echo "FAIL	check-docs.mjs ran	exit $?")
