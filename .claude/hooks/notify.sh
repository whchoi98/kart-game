#!/usr/bin/env bash
# Notification: forward Claude Code notifications to a webhook (Slack-compatible "text" payload).
#
# Configure:  export CLAUDE_NOTIFY_WEBHOOK="https://hooks.slack.com/services/..."
# Dry run:    CLAUDE_NOTIFY_DRY_RUN=1 prints the payload instead of sending it (used by test/harness).
# Input: hook JSON on stdin (message, optional title and notification_type), or "$1" "$2" for manual use.
# Notification hooks cannot block anything; this script always exits 0 and never waits on the network.

set -u

WEBHOOK_URL="${CLAUDE_NOTIFY_WEBHOOK:-}"
DRY_RUN="${CLAUDE_NOTIFY_DRY_RUN:-}"
[ -z "$WEBHOOK_URL" ] && [ -z "$DRY_RUN" ] && exit 0

EVENT="${1:-}"
MESSAGE="${2:-}"
if [ $# -eq 0 ] && [ ! -t 0 ]; then
    INPUT=$(cat)
    if command -v jq >/dev/null 2>&1; then
        EVENT=$(printf '%s' "$INPUT" | jq -r '.notification_type // .hook_event_name // empty' 2>/dev/null)
        MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty' 2>/dev/null)
    else
        EVENT=$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.notification_type??j.hook_event_name??""))}catch{}})' 2>/dev/null)
        MESSAGE=$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).message??""))}catch{}})' 2>/dev/null)
    fi
fi
EVENT="${EVENT:-notification}"
MESSAGE="${MESSAGE:-Claude Code event occurred}"

PROJECT=$(basename "${CLAUDE_PROJECT_DIR:-$(pwd)}")
BRANCH=$(git -C "${CLAUDE_PROJECT_DIR:-.}" branch --show-current 2>/dev/null || true)
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build the JSON with a real encoder so quotes and newlines in the message cannot break it.
if command -v jq >/dev/null 2>&1; then
    PAYLOAD=$(jq -cn --arg event "$EVENT" --arg message "$MESSAGE" --arg project "$PROJECT" \
        --arg branch "${BRANCH:-unknown}" --arg ts "$STAMP" \
        '{text: "[\($event)] \($project): \($message)", event: $event, project: $project, branch: $branch, timestamp: $ts}')
else
    PAYLOAD=$(node -e 'const [event,message,project,branch,ts]=process.argv.slice(1);process.stdout.write(JSON.stringify({text:`[${event}] ${project}: ${message}`,event,project,branch,timestamp:ts}))' \
        "$EVENT" "$MESSAGE" "$PROJECT" "${BRANCH:-unknown}" "$STAMP")
fi

if [ -n "$DRY_RUN" ]; then
    printf '%s\n' "$PAYLOAD"
    exit 0
fi

# Fire and forget: a slow webhook must never stall the session.
curl -fsS --max-time 5 -X POST "$WEBHOOK_URL" -H 'Content-Type: application/json' -d "$PAYLOAD" >/dev/null 2>&1 &
exit 0
