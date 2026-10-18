#!/usr/bin/env bash
# One-command setup for a new developer machine.
# Usage: bash scripts/setup.sh [--with-browsers]
#   --with-browsers  also download Playwright Chromium (needed by npm run qa:screens and
#                    tools/verify-live-pwa.mjs; not needed for npm test)

set -euo pipefail

cd "$(dirname "$0")/.."

WITH_BROWSERS=false
for arg in "$@"; do
    case "$arg" in
        --with-browsers) WITH_BROWSERS=true ;;
        -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

echo "=== TURBO PALS GRAND PRIX setup ==="

command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js >= 22.12 is required (package.json engines)" >&2; exit 1; }

# package.json "engines": { "node": ">=22.12.0" }
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'; then
    echo "ERROR: Node.js $(node -v) found; >= 22.12.0 is required" >&2
    exit 1
fi
echo "Node.js $(node -v)"

echo "Installing dependencies (npm ci, exact versions from package-lock.json)..."
npm ci

if $WITH_BROWSERS; then
    echo "Installing Playwright Chromium..."
    npx playwright install chromium
fi

# The server reads plain environment variables; nothing loads a .env file automatically.
# .env.example documents every variable and its default.
echo "Configuration: see .env.example (all variables are optional for local development)."

chmod +x .claude/hooks/*.sh scripts/*.sh test/harness/run-all.sh 2>/dev/null || true
echo "Claude Code hooks are executable"

if git rev-parse --git-dir >/dev/null 2>&1; then
    bash scripts/install-hooks.sh
fi

echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. npm run typecheck && npm test        # verify the toolchain"
echo "  2. npm run dev                          # http://localhost:8200 (API on 8201)"
echo "  3. Read CLAUDE.md and docs/onboarding.md"
