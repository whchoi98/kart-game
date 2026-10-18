#!/usr/bin/env bash
# Harness test runner: Claude Code hooks, secret patterns and project/documentation structure.
# (Application tests are vitest: npm test. This suite is shell-only and needs bash, git, node.)
#
# Usage: bash test/harness/run-all.sh [filter]
#   bash test/harness/run-all.sh            # every test-*.sh under test/harness/
#   bash test/harness/run-all.sh hooks      # only files whose name contains "hooks"
#
# Test files are sourced (not run in a subshell), so they share the assertion helpers below.
# No `set -e`: a failing command inside a test must be reported by an assertion, not abort the run.

set -uo pipefail

if [ -t 1 ]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0
FAILURES=()

export TEST_RUNNER_ACTIVE=1

pass() {
    TOTAL=$((TOTAL + 1)); PASSED=$((PASSED + 1))
    printf '  %s✓%s %s\n' "$GREEN" "$NC" "$1"
}

fail() {
    TOTAL=$((TOTAL + 1)); FAILED=$((FAILED + 1))
    FAILURES+=("$1: $2")
    printf '  %s✗%s %s\n    %s→ %s%s\n' "$RED" "$NC" "$1" "$RED" "$2" "$NC"
}

skip() {
    TOTAL=$((TOTAL + 1)); SKIPPED=$((SKIPPED + 1))
    printf '  %s○%s %s (skipped: %s)\n' "$YELLOW" "$NC" "$1" "$2"
}

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then pass "$desc"; else fail "$desc" "expected '$expected', got '$actual'"; fi
}

# Fixed-string containment (here-string: no pipe, so no SIGPIPE false negatives under pipefail).
assert_contains() {
    local desc="$1" haystack="$2" needle="$3"
    if grep -qF -- "$needle" <<< "$haystack"; then pass "$desc"; else fail "$desc" "output does not contain '$needle'"; fi
}

assert_not_contains() {
    local desc="$1" haystack="$2" needle="$3"
    if grep -qF -- "$needle" <<< "$haystack"; then fail "$desc" "output unexpectedly contains '$needle'"; else pass "$desc"; fi
}

assert_file_exists() {
    local desc="$1" filepath="$2"
    if [ -f "$filepath" ]; then pass "$desc"; else fail "$desc" "file not found: $filepath"; fi
}

assert_file_executable() {
    local desc="$1" filepath="$2"
    if [ -x "$filepath" ]; then pass "$desc"; else fail "$desc" "file not executable: $filepath"; fi
}

assert_json_valid() {
    local desc="$1" filepath="$2"
    if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$filepath" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc" "invalid JSON: $filepath"
    fi
}

assert_bash_syntax() {
    local desc="$1" filepath="$2"
    if bash -n "$filepath" 2>/dev/null; then pass "$desc"; else fail "$desc" "bash syntax error in: $filepath"; fi
}

# Extended-regex match against a string (same engine family the hooks use).
assert_grep_match() {
    local desc="$1" pattern="$2" input="$3"
    if grep -qE -- "$pattern" <<< "$input"; then pass "$desc"; else fail "$desc" "pattern '$pattern' did not match"; fi
}

assert_grep_no_match() {
    local desc="$1" pattern="$2" input="$3"
    if grep -qE -- "$pattern" <<< "$input"; then fail "$desc" "pattern '$pattern' matched (expected no match)"; else pass "$desc"; fi
}

FILTER="${1:-}"
HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$HARNESS_DIR/../.." && pwd)"
export HARNESS_DIR PROJECT_ROOT
cd "$PROJECT_ROOT"

printf '%s=== Harness Test Suite ===%s\n\n' "$CYAN" "$NC"

while IFS= read -r test_file; do
    test_name=$(basename "$test_file" .sh)
    if [ -n "$FILTER" ] && [[ "$test_name" != *"$FILTER"* ]]; then
        continue
    fi
    printf '%s▸ %s%s\n' "$CYAN" "$test_name" "$NC"
    # shellcheck source=/dev/null
    source "$test_file"
    cd "$PROJECT_ROOT"
    echo ""
done < <(find "$HARNESS_DIR" -name 'test-*.sh' -type f | sort)

printf '%s=== Results ===%s\n' "$CYAN" "$NC"
echo "  Total:   $TOTAL"
printf '  %sPassed:  %s%s\n' "$GREEN" "$PASSED" "$NC"
if [ "$FAILED" -gt 0 ]; then printf '  %sFailed:  %s%s\n' "$RED" "$FAILED" "$NC"; else echo "  Failed:  0"; fi
if [ "$SKIPPED" -gt 0 ]; then printf '  %sSkipped: %s%s\n' "$YELLOW" "$SKIPPED" "$NC"; else echo "  Skipped: 0"; fi

if [ "$TOTAL" -eq 0 ]; then
    printf '\n%sNo tests ran (filter: %s).%s\n' "$RED" "${FILTER:-none}" "$NC"
    exit 1
fi

if [ "$FAILED" -gt 0 ]; then
    printf '\n%s=== Failures ===%s\n' "$RED" "$NC"
    for f in "${FAILURES[@]}"; do
        printf '  %s✗%s %s\n' "$RED" "$NC" "$f"
    done
    exit 1
fi

printf '\n%sAll tests passed.%s\n' "$GREEN" "$NC"
