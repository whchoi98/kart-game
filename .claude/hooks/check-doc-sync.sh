#!/usr/bin/env bash
# PostToolUse (Write|Edit): tell Claude which docs or project rules a just-edited file touches.
#
# Input : hook JSON on stdin (tool_input.file_path, always absolute), or a path as $1 (manual/tests).
# Output: one {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":...}} object
#         when there is something to say (exit 0 + JSON is what reaches Claude); silent otherwise.
# Never blocks: the edit has already happened.

set -u

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
ROOT="${ROOT%/}"

# Read one dotted field from the JSON on stdin (jq when available, else node — a project prerequisite).
json_field() {
    if command -v jq >/dev/null 2>&1; then
        jq -r ".$1 // empty" 2>/dev/null
    else
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];if(v!=null)process.stdout.write(String(v))}catch{}})' "$1" 2>/dev/null
    fi
}

json_string() {
    if command -v jq >/dev/null 2>&1; then
        jq -Rs . 2>/dev/null
    else
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))'
    fi
}

FILE_PATH="${1:-}"
if [ $# -eq 0 ] && [ ! -t 0 ]; then
    FILE_PATH=$(json_field tool_input.file_path)
fi
[ -z "$FILE_PATH" ] && exit 0

case "$FILE_PATH" in
    "$ROOT"/*) REL="${FILE_PATH#"$ROOT"/}" ;;
    /*) exit 0 ;;                       # outside this project
    *) REL="${FILE_PATH#./}" ;;
esac

cd "$ROOT" 2>/dev/null || exit 0

MESSAGES=()
add() { MESSAGES+=("$1"); }

has_claude_md() {
    # $1 = directory to start from, $2 = stop directory, $3 = include the stop directory itself
    local dir="$1" stop="$2" include_stop="$3"
    while [ "$dir" != "." ] && [ "$dir" != "/" ]; do
        if [ "$dir" = "$stop" ]; then
            [ "$include_stop" = yes ] && [ -f "$dir/CLAUDE.md" ] && return 0
            return 1
        fi
        [ -f "$dir/CLAUDE.md" ] && return 0
        dir=$(dirname "$dir")
    done
    return 1
}

BASE=$(basename "$REL")
DIR=$(dirname "$REL")

# 1. Module documentation.
#    src/: every module directory needs its own CLAUDE.md (src/CLAUDE.md does not count).
#    infra/, test/, tools/: one CLAUDE.md at the top of the tree covers it.
if [ "$BASE" != "CLAUDE.md" ]; then
    case "$REL" in
        src/*/*)
            if ! has_claude_md "$DIR" src no; then
                add "[doc-sync] $DIR/CLAUDE.md is missing. Create module documentation (Role / Key Files / Rules) before continuing."
            fi
            ;;
        infra/*|test/*|tools/*)
            top="${REL%%/*}"
            if ! has_claude_md "$DIR" "$top" yes; then
                add "[doc-sync] $top/CLAUDE.md is missing. Create module documentation for $top/."
            fi
            ;;
    esac
fi

# 2. Project rules tied to specific paths.
case "$REL" in
    src/sim/*.md|src/sim/*/*.md) ;;
    src/sim/*)
        add "[sim-version] $REL is simulation code. The server re-simulates time-trial input logs, so any change that can alter a trajectory (physics, track geometry, items, RNG order) needs a package.json version bump and a CHANGELOG entry. See docs/architecture.md (Simulation versioning) and docs/decisions/ADR-001-deterministic-simulation-server-verification.md."
        ;;
esac

case "$REL" in
    src/shared/api.ts|src/server/app.ts|src/server/validation.ts)
        add "[doc-sync] API contract file changed ($REL). Update docs/api-reference.md and docs/reference/api.md if endpoints, payloads, limits or error codes changed."
        ;;
    src/server/repository.ts|src/server/dynamo-repository.ts|src/server/memory-repository.ts|infra/lib/data.ts)
        add "[doc-sync] Data layer changed ($REL). Update docs/reference/data.md and src/server/CLAUDE.md if the table schema, keys or access patterns changed."
        ;;
    src/shared/csp.ts|src/server/security.ts)
        add "[doc-sync] Security boundary changed ($REL). Update docs/reference/security.md."
        ;;
esac

case "$REL" in
    .dockerignore|infra/lib/service.ts)
        add "[docker-context] Keep .dockerignore and IMAGE_CONTEXT_EXCLUDE in infra/lib/service.ts identical (the CDK asset hash and the Docker build must see the same context). test/harness checks this."
        ;;
esac

case "$REL" in
    infra/*|Dockerfile|.dockerignore|cdk.json|cdk.context.json)
        add "[doc-sync] Infrastructure changed ($REL). Update docs/architecture.md (Infrastructure), docs/reference/iac.md and the affected runbooks in docs/runbooks/."
        RUNBOOKS=$(find docs/runbooks -name '*.md' ! -name '.template.md' 2>/dev/null | wc -l | tr -d ' ')
        if [ "$RUNBOOKS" -eq 0 ]; then
            add "[doc-sync] No runbooks found. Create operational runbooks for deployment and recovery in docs/runbooks/."
        fi
        ;;
esac

# 3. Architecture decisions.
case "$REL" in
    src/*|infra/*|docs/architecture.md)
        ADRS=$(find docs/decisions -name 'ADR-*.md' 2>/dev/null | wc -l | tr -d ' ')
        if [ "$ADRS" -eq 0 ]; then
            add "[doc-sync] No ADRs found. Record architectural decisions in docs/decisions/."
        fi
        ;;
esac

[ ${#MESSAGES[@]} -eq 0 ] && exit 0

CONTEXT=$(printf '%s\n' "${MESSAGES[@]}")
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$(printf '%s' "$CONTEXT" | json_string)"
exit 0
