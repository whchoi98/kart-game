#!/usr/bin/env bash
# SessionStart: print a short project briefing. Plain stdout from SessionStart is added to Claude's context.
# Keep it fast (no network, no AWS calls) and short.

set -u
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
[ ! -t 0 ] && cat > /dev/null   # drain the hook JSON; nothing in it is needed here

pkg_field() {
    if command -v jq >/dev/null 2>&1; then
        jq -r ".$1 // empty" package.json 2>/dev/null
    else
        node -p "require('./package.json').$1 ?? ''" 2>/dev/null
    fi
}

echo "=== Project Context ==="
if [ -f package.json ]; then
    echo "Project: $(pkg_field name) v$(pkg_field version) (Node.js $(pkg_field engines.node), TypeScript, three.js, Fastify, AWS CDK)"
else
    echo "Project: $(basename "$(pwd)")"
fi

BRANCH=$(git branch --show-current 2>/dev/null)
[ -n "$BRANCH" ] && echo "Branch: $BRANCH"
LAST_COMMIT=$(git log -1 --format='%h %s (%cr)' 2>/dev/null)
[ -n "$LAST_COMMIT" ] && echo "Last commit: $LAST_COMMIT"
CHANGES=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
[ "${CHANGES:-0}" -gt 0 ] && echo "Uncommitted changes: $CHANGES file(s)"

CLAUDE_COUNT=$(git ls-files --cached --others --exclude-standard -- 'CLAUDE.md' '*/CLAUDE.md' 2>/dev/null | wc -l | tr -d ' ')
echo "CLAUDE.md files: $CLAUDE_COUNT"

# Live deployment (cdk-outputs.json is written by `npm run deploy` and is git-ignored).
if [ -f cdk-outputs.json ] && command -v jq >/dev/null 2>&1; then
    SITE=$(jq -r '.. | objects | .SiteUrl? // empty' cdk-outputs.json 2>/dev/null | head -1)
    [ -n "$SITE" ] && echo "Deployed site (last local deploy): $SITE"
fi

echo "Rules: trajectory-changing edits under src/sim/ need a package.json version bump (server re-simulates time trials)."
echo "       Deploy = docs/runbooks/deploy-production.md; never destroy TurboPalsStack without the user's explicit request."
echo "======================"
exit 0
