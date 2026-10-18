#!/usr/bin/env bash
# PreToolUse (Bash, `if: Bash(git commit *)`): block a commit whose staged content contains secrets.
#
# Modes:
#   (hook)            hook JSON on stdin; acts only when tool_input.command runs `git commit`.
#   --staged          scan the staged changes of the current repository (manual / pre-commit use).
#   --check-stdin     scan text on stdin; exit 1 and print the matching labels (used by test/harness).
#   --all             audit every tracked + untracked (non-ignored) file; exit 1 when anything matched.
#
# Blocking contract: exit 2 + reason on stderr (exit 1 would NOT block a tool call).
# Matched values are never printed, only file names and pattern labels.
# Patterns are POSIX ERE so the hook also works with BSD grep (no grep -P).

set -u

# label|flags|regex   (flags: "-i" for case-insensitive, "-" for none)
PATTERNS=(
    'AWS access key id|-|(AKIA|ASIA)[0-9A-Z]{16}'
    'AWS secret access key|-i|aws_?secret_?access_?key["'\'']?[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9/+=]{40}'
    'OpenAI API key|-|sk-(proj-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})'
    'Anthropic API key|-|sk-ant-[A-Za-z0-9_-]{90,}'
    'GitHub token|-|(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}'
    'GitHub fine-grained token|-|github_pat_[A-Za-z0-9_]{82}'
    'Slack token|-|xox[abposr]-[0-9]+-[A-Za-z0-9-]+'
    'Stripe live key|-|(sk|rk)_live_[A-Za-z0-9]{24,}'
    'Google API key|-|AIza[A-Za-z0-9_-]{35}'
    'Google OAuth token|-|ya29\.[A-Za-z0-9_-]{50,}'
    'Azure connection string|-|DefaultEndpointsProtocol=https;AccountName=[^;[:space:]]+;AccountKey='
    'Private key block|-|-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----'
    'Hardcoded password|-i|(^|[^A-Za-z0-9])(password|passwd|pwd)[[:space:]]*[:=][[:space:]]*["'\''][^"'\''[:space:]]{8,}["'\'']'
    'Hardcoded secret|-|(^|[^A-Za-z0-9])(secret|client_secret|SECRET|CLIENT_SECRET)[[:space:]]*[:=][[:space:]]*["'\''][^"'\''[:space:]]{8,}["'\'']'
    'Hardcoded API key|-i|(^|[^A-Za-z0-9])api[_-]?key[[:space:]]*[:=][[:space:]]*["'\''][^"'\''[:space:]]{8,}["'\'']'
)

# Files whose job is to contain secret-shaped text (fixtures, the patterns themselves).
SKIP_GLOBS=(
    'package-lock.json'
    '*.example'
    '.claude/hooks/secret-scan.sh'
    'test/harness/hooks/test-secret-patterns.sh'
    'test/harness/fixtures/*'
)

split_entry() {   # sets LABEL FLAGS REGEX from one PATTERNS entry
    LABEL="${1%%|*}"
    local rest="${1#*|}"
    FLAGS="${rest%%|*}"
    REGEX="${rest#*|}"
}

# Print the label of every pattern that matches stdin; exit 0 when clean, 1 when anything matched.
scan_text() {
    local tmp found=0 entry
    tmp=$(mktemp) || return 0
    cat > "$tmp"
    for entry in "${PATTERNS[@]}"; do
        split_entry "$entry"
        if [ "$FLAGS" = "-i" ]; then
            grep -I -E -i -q -e "$REGEX" "$tmp" 2>/dev/null && { printf '%s\n' "$LABEL"; found=1; }
        else
            grep -I -E -q -e "$REGEX" "$tmp" 2>/dev/null && { printf '%s\n' "$LABEL"; found=1; }
        fi
    done
    rm -f "$tmp"
    return "$found"
}

skipped() {
    local file="$1" glob
    for glob in "${SKIP_GLOBS[@]}"; do
        # shellcheck disable=SC2053
        [[ "$file" == $glob ]] && return 0
    done
    return 1
}

# Scan the staged content (the index, i.e. exactly what will be committed) with `git grep --cached`.
# Binary files are skipped (-I). Returns 1 and reports on stderr when anything matched.
scan_staged() {
    local file entry hit blocked=0
    local files=()
    git rev-parse --git-dir >/dev/null 2>&1 || return 0
    while IFS= read -r -d '' file; do
        skipped "$file" || files+=("$file")
    done < <(git diff --cached --name-only -z --diff-filter=ACMR 2>/dev/null)
    [ ${#files[@]} -eq 0 ] && return 0
    for entry in "${PATTERNS[@]}"; do
        split_entry "$entry"
        local args=(--literal-pathspecs grep --cached -I -l -E)
        [ "$FLAGS" = "-i" ] && args+=(-i)
        while IFS= read -r hit; do
            [ -n "$hit" ] || continue
            printf '[secret-scan] %s: possible %s\n' "$hit" "$LABEL" >&2
            blocked=1
        done < <(git "${args[@]}" -e "$REGEX" -- "${files[@]}" 2>/dev/null)
    done
    return "$blocked"
}

# Scan every tracked and untracked (not ignored) file in the working tree. Audit mode.
scan_tree() {
    local entry hit hits=0
    local excludes=()
    git rev-parse --git-dir >/dev/null 2>&1 || return 0
    for glob in "${SKIP_GLOBS[@]}"; do excludes+=(":(exclude,glob)$glob" ":(exclude,glob)**/$glob"); done
    for entry in "${PATTERNS[@]}"; do
        split_entry "$entry"
        local args=(grep --untracked -I -l -E)
        [ "$FLAGS" = "-i" ] && args+=(-i)
        while IFS= read -r hit; do
            [ -n "$hit" ] || continue
            printf '[secret-scan] %s: possible %s\n' "$hit" "$LABEL" >&2
            hits=1
        done < <(git "${args[@]}" -e "$REGEX" -- . "${excludes[@]}" 2>/dev/null)
    done
    return "$hits"
}

block() {
    {
        echo ""
        echo "[secret-scan] BLOCKED: staged changes contain values that look like secrets."
        echo "[secret-scan] Remove them (runtime config lives in Secrets Manager / environment variables, see .env.example),"
        echo "[secret-scan] then stage again. If a hit is a false positive, adjust the pattern in .claude/hooks/secret-scan.sh"
        echo "[secret-scan] and add the line to test/harness/fixtures/false-positives.txt."
    } >&2
    exit 2
}

case "${1:-}" in
    --check-stdin)
        scan_text
        exit $?
        ;;
    --staged)
        scan_staged || block
        exit 0
        ;;
    --all)
        scan_tree || exit 1
        exit 0
        ;;
esac

# Hook mode. Defense in depth: `if: Bash(git commit *)` already filters, but older Claude Code
# versions ignore `if`, so the command is checked here too.
INPUT=""
[ ! -t 0 ] && INPUT=$(cat)
if [ -n "$INPUT" ]; then
    if command -v jq >/dev/null 2>&1; then
        COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
    else
        COMMAND=$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).tool_input?.command??""))}catch{}})' 2>/dev/null)
    fi
    printf '%s' "$COMMAND" | grep -Eq '(^|[;&|(`[:space:]])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)' || exit 0
    if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
        cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0
    fi
fi

scan_staged || block
exit 0
