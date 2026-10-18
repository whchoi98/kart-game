#!/usr/bin/env bash
# Install the Git hooks this project relies on (Claude Code hooks live in .claude/ and need no install).
# Usage: bash scripts/install-hooks.sh
#
# commit-msg: strips Co-Authored-By trailers (any case) so AI assistants are not listed as contributors.
# Respects core.hooksPath and worktrees (git rev-parse --git-path hooks). An existing hook that this
# script did not write is kept as commit-msg.local-backup.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "ERROR: not a git repository. Run 'git init' first." >&2
    exit 1
fi

HOOKS_DIR=$(git rev-parse --git-path hooks)
mkdir -p "$HOOKS_DIR"
TARGET="$HOOKS_DIR/commit-msg"
MARKER="managed-by: scripts/install-hooks.sh"

if [ -f "$TARGET" ] && ! grep -q "$MARKER" "$TARGET"; then
    mv "$TARGET" "$TARGET.local-backup"
    echo "Existing commit-msg hook moved to $TARGET.local-backup"
fi

cat > "$TARGET" << 'HOOK'
#!/bin/sh
# managed-by: scripts/install-hooks.sh
# Remove Co-Authored-By trailers (Co-Authored-By, Co-authored-by, co-authored-by, ...) and the
# blank lines they leave at the end of the message. POSIX sh + grep + awk: works with GNU and BSD tools.
msg="$1"
tmp="$msg.tmp.$$"
grep -v -i '^co-authored-by:' "$msg" \
    | awk '{ line[NR] = $0 } END { n = NR; while (n > 0 && line[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print line[i] }' \
    > "$tmp" && mv "$tmp" "$msg"
HOOK
chmod +x "$TARGET"

echo "Installed $TARGET (removes Co-Authored-By trailers)"
echo "=== Git hooks installed ==="
