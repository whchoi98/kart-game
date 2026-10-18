#!/usr/bin/env bash
# Claude Code hooks: files, registration in .claude/settings.json, and behaviour with real hook JSON.
# Sourced by test/harness/run-all.sh (cwd = project root, assertion helpers in scope).

H=.claude/hooks

# --- Existence, permissions, syntax ---
for hook in check-doc-sync secret-scan session-context notify; do
    assert_file_exists "$hook.sh exists" "$H/$hook.sh"
    assert_file_executable "$hook.sh is executable" "$H/$hook.sh"
    assert_bash_syntax "$hook.sh is valid bash" "$H/$hook.sh"
done

# --- Registration (parsed, not grepped) ---
assert_file_exists "settings.json exists" ".claude/settings.json"
assert_json_valid "settings.json is valid JSON" ".claude/settings.json"

hook_info() {   # $1 = event → "<matcher>\t<if>\t<command>" per handler
    node -e '
      const s = JSON.parse(require("fs").readFileSync(".claude/settings.json", "utf8"));
      for (const group of s.hooks?.[process.argv[1]] ?? [])
        for (const h of group.hooks ?? [])
          console.log([group.matcher ?? "", h.if ?? "", h.command ?? ""].join("\t"));
    ' "$1"
}

SESSION=$(hook_info SessionStart)
PRE=$(hook_info PreToolUse)
POST=$(hook_info PostToolUse)
NOTE=$(hook_info Notification)
assert_contains "SessionStart runs session-context.sh" "$SESSION" "session-context.sh"
assert_contains "PreToolUse runs secret-scan.sh" "$PRE" "secret-scan.sh"
assert_contains "PreToolUse matcher is Bash" "$(cut -f1 <<< "$PRE")" "Bash"
assert_contains "PreToolUse only fires for git commit (if field)" "$(cut -f2 <<< "$PRE")" "Bash(git commit *)"
assert_contains "PostToolUse runs check-doc-sync.sh" "$POST" "check-doc-sync.sh"
assert_contains "PostToolUse matcher is Write|Edit" "$(cut -f1 <<< "$POST")" "Write|Edit"
assert_contains "Notification runs notify.sh" "$NOTE" "notify.sh"

ALL_COMMANDS=$(printf '%s\n%s\n%s\n%s\n' "$SESSION" "$PRE" "$POST" "$NOTE")
assert_contains "Hook commands are anchored at CLAUDE_PROJECT_DIR" "$ALL_COMMANDS" '$CLAUDE_PROJECT_DIR'
# exit 2 is the only blocking exit code; `|| true` would swallow it.
assert_not_contains "secret-scan exit code is not swallowed" "$PRE" "|| true"
# Hooks receive JSON on stdin; these variables do not exist.
assert_not_contains "No fictional TOOL_INPUT_PATH variable" "$ALL_COMMANDS" "TOOL_INPUT_PATH"
assert_not_contains "No fictional EVENT/MESSAGE variables" "$ALL_COMMANDS" '$MESSAGE'

DENY=$(node -e 'console.log((JSON.parse(require("fs").readFileSync(".claude/settings.json","utf8")).permissions?.deny ?? []).join("\n"))')
for rule in 'Bash(rm -rf *)' 'Bash(git push --force *)' 'Bash(git reset --hard *)' 'Bash(npx cdk destroy*)'; do
    assert_contains "deny list has $rule" "$DENY" "$rule"
done

# --- check-doc-sync behaviour ---
doc_sync() {   # $1 = project-relative path → additionalContext text ("" when silent)
    printf '{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"%s/%s"}}' "$PROJECT_ROOT" "$1" \
        | CLAUDE_PROJECT_DIR="$PROJECT_ROOT" bash "$H/check-doc-sync.sh" 2>&1
}

OUTPUT=$(bash "$H/check-doc-sync.sh" "" < /dev/null 2>&1)
assert_eq "check-doc-sync: empty path is silent" "" "$OUTPUT"

OUTPUT=$(printf '{"tool_input":{"file_path":"/tmp/elsewhere/x.ts"}}' | CLAUDE_PROJECT_DIR="$PROJECT_ROOT" bash "$H/check-doc-sync.sh" 2>&1)
assert_eq "check-doc-sync: file outside the project is silent" "" "$OUTPUT"

OUTPUT=$(doc_sync src/sim/race.ts)
if node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(j.hookSpecificOutput?.hookEventName==="PostToolUse"&&typeof j.hookSpecificOutput.additionalContext==="string"?0:1)' <<< "$OUTPUT" 2>/dev/null; then
    pass "check-doc-sync: emits PostToolUse additionalContext JSON"
else
    fail "check-doc-sync: emits PostToolUse additionalContext JSON" "got: ${OUTPUT:0:120}"
fi
assert_contains "check-doc-sync: src/sim edit reminds about the version bump" "$OUTPUT" "[sim-version]"
assert_not_contains "check-doc-sync: src/sim is documented" "$OUTPUT" "CLAUDE.md is missing"

OUTPUT=$(doc_sync src/client/render/themes/neon.ts)
assert_not_contains "check-doc-sync: nested src module is documented" "$OUTPUT" "CLAUDE.md is missing"

OUTPUT=$(doc_sync src/brand-new-module/thing.ts)
assert_contains "check-doc-sync: new src module needs CLAUDE.md" "$OUTPUT" "src/brand-new-module/CLAUDE.md is missing"

OUTPUT=$(doc_sync src/brand-new-module/CLAUDE.md)
assert_eq "check-doc-sync: writing the CLAUDE.md itself is silent" "" "$OUTPUT"

OUTPUT=$(doc_sync infra/lib/service.ts)
assert_contains "check-doc-sync: service.ts reminds about the Docker context mirror" "$OUTPUT" "[docker-context]"
assert_contains "check-doc-sync: infra edit points at the IaC docs" "$OUTPUT" "docs/reference/iac.md"
assert_not_contains "check-doc-sync: infra/ is documented" "$OUTPUT" "CLAUDE.md is missing"

OUTPUT=$(doc_sync src/shared/api.ts)
assert_contains "check-doc-sync: API contract edit points at api-reference" "$OUTPUT" "docs/api-reference.md"

OUTPUT=$(doc_sync README.md)
assert_eq "check-doc-sync: unrelated file is silent" "" "$OUTPUT"

# --- secret-scan behaviour (in a throwaway repository) ---
SCAN="$PROJECT_ROOT/$H/secret-scan.sh"
TMP_REPO=$(mktemp -d)
(
    cd "$TMP_REPO" || exit 1
    git init -q . && git config user.email t@example.invalid && git config user.name test
    printf 'export const region = "ap-northeast-2";\n' > clean.ts
    git add clean.ts
) >/dev/null 2>&1

run_scan() {   # $1 = shell command Claude is about to run → "<exit code>|<stderr>"
    local err rc
    err=$(cd "$TMP_REPO" && printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1" \
        | env -u CLAUDE_PROJECT_DIR bash "$SCAN" 2>&1 >/dev/null)
    rc=$?
    printf '%s|%s' "$rc" "$err"
}

RESULT=$(run_scan 'git commit -m clean')
assert_eq "secret-scan: clean staged change is allowed (exit 0)" "0" "${RESULT%%|*}"

# Token assembled at runtime so no literal key sits in this repository.
( cd "$TMP_REPO" && printf 'const key = "%s%s";\n' "AKIA" "IOSFODNN7EXAMPLE" > leak.ts && git add leak.ts ) >/dev/null 2>&1
RESULT=$(run_scan 'git commit -m leak')
assert_eq "secret-scan: staged AWS key blocks the commit (exit 2)" "2" "${RESULT%%|*}"
assert_contains "secret-scan: reason names the file" "${RESULT#*|}" "leak.ts"
assert_contains "secret-scan: reason says BLOCKED" "${RESULT#*|}" "BLOCKED"
assert_not_contains "secret-scan: reason never echoes the value" "${RESULT#*|}" "IOSFODNN7EXAMPLE"

RESULT=$(run_scan 'git -C . commit --amend --no-edit')
assert_eq "secret-scan: git -C ... commit is recognised" "2" "${RESULT%%|*}"

RESULT=$(run_scan 'ls -la')
assert_eq "secret-scan: non-commit command is ignored" "0" "${RESULT%%|*}"

RESULT=$(run_scan 'git log --grep commit')
assert_eq "secret-scan: git log mentioning commit is ignored" "0" "${RESULT%%|*}"

# Working-tree content that is not staged must not block (only the index is committed).
( cd "$TMP_REPO" && git rm -q --cached leak.ts ) >/dev/null 2>&1
RESULT=$(run_scan 'git commit -m clean-again')
assert_eq "secret-scan: unstaged secret does not block" "0" "${RESULT%%|*}"
rm -rf "$TMP_REPO"

# The project itself must pass its own scan (tracked + untracked, non-ignored files).
TREE_HITS=$(bash "$SCAN" --all 2>&1)
assert_eq "secret-scan: no project file matches a secret pattern" "" "$TREE_HITS"

# --- session-context behaviour ---
OUTPUT=$(printf '{"hook_event_name":"SessionStart","source":"startup"}' | CLAUDE_PROJECT_DIR="$PROJECT_ROOT" bash "$H/session-context.sh" 2>&1)
assert_contains "session-context: prints the header" "$OUTPUT" "=== Project Context ==="
assert_contains "session-context: names the package" "$OUTPUT" "turbo-pals-grand-prix"
assert_contains "session-context: states the sim version rule" "$OUTPUT" "src/sim/"
LINES=$(wc -l <<< "$OUTPUT" | tr -d ' ')
if [ "$LINES" -le 20 ]; then pass "session-context: stays short ($LINES lines)"; else fail "session-context: stays short" "$LINES lines"; fi

# --- notify behaviour ---
OUTPUT=$(printf '{"message":"hi"}' | CLAUDE_NOTIFY_WEBHOOK="" CLAUDE_NOTIFY_DRY_RUN="" bash "$H/notify.sh" 2>&1)
assert_eq "notify: no webhook configured is silent" "" "$OUTPUT"

OUTPUT=$(printf '{"hook_event_name":"Notification","message":"Needs \\"approval\\"\\nnow","notification_type":"permission_prompt"}' \
    | CLAUDE_NOTIFY_DRY_RUN=1 bash "$H/notify.sh" 2>&1)
if node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(j.event==="permission_prompt"&&j.text.includes("Needs \"approval\"\nnow")?0:1)' <<< "$OUTPUT" 2>/dev/null; then
    pass "notify: payload is valid JSON and keeps quotes/newlines"
else
    fail "notify: payload is valid JSON and keeps quotes/newlines" "got: ${OUTPUT:0:160}"
fi
