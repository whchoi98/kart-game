#!/usr/bin/env bash
# Secret patterns of .claude/hooks/secret-scan.sh: true positives must be flagged with the right label,
# false positives must stay clean. Samples live in test/harness/fixtures/; token prefixes are stored as
# {{MARKERS}} and expanded here, so no complete token is ever committed.

SCAN=.claude/hooks/secret-scan.sh
FIXTURES="$HARNESS_DIR/fixtures"

expand_markers() {
    local s="$1"
    s="${s//\{\{AKIA\}\}/AKIA}"
    s="${s//\{\{ASIA\}\}/ASIA}"
    s="${s//\{\{AWS_SECRET_NAME\}\}/aws_secret_access_key}"
    s="${s//\{\{SK\}\}/sk-}"
    s="${s//\{\{OPENAI_MARK\}\}/T3BlbkFJ}"
    s="${s//\{\{SK_ANT\}\}/sk-ant-}"
    s="${s//\{\{GHP\}\}/ghp_}"
    s="${s//\{\{GHS\}\}/ghs_}"
    s="${s//\{\{GITHUB_PAT\}\}/github_pat_}"
    s="${s//\{\{XOXB\}\}/xoxb-}"
    s="${s//\{\{SK_LIVE\}\}/sk_live_}"
    s="${s//\{\{AIZA\}\}/AIza}"
    s="${s//\{\{YA29\}\}/ya29.}"
    s="${s//\{\{AZURE_CONN\}\}/DefaultEndpointsProtocol=https;AccountName=}"
    s="${s//\{\{PEM_BEGIN\}\}/-----BEGIN}"
    printf '%s' "$s"
}

assert_file_exists "fixture: secret-samples.txt" "$FIXTURES/secret-samples.txt"
assert_file_exists "fixture: false-positives.txt" "$FIXTURES/false-positives.txt"

# The fixtures themselves must not contain an expanded token.
RAW_HITS=$(cat "$FIXTURES/secret-samples.txt" "$FIXTURES/false-positives.txt" | grep -v '^#' \
    | bash "$SCAN" --check-stdin | grep -v -E '^Hardcoded (password|secret|API key)$')
assert_eq "fixtures hold no complete provider token" "" "$RAW_HITS"

# --- True positives ---
TP_COUNT=0
while IFS=$'\t' read -r label sample; do
    case "$label" in ''|'#'*) continue ;; esac
    TP_COUNT=$((TP_COUNT + 1))
    expanded=$(expand_markers "$sample")
    labels=$(printf '%s\n' "$expanded" | bash "$SCAN" --check-stdin)
    rc=$?
    if [ "$rc" -eq 1 ] && grep -qxF -- "$label" <<< "$labels"; then
        pass "TP: $label (${sample:0:28}...)"
    else
        fail "TP: $label (${sample:0:28}...)" "exit $rc, labels: ${labels:-none}"
    fi
done < "$FIXTURES/secret-samples.txt"
if [ "$TP_COUNT" -ge 15 ]; then pass "TP fixture covers every pattern family ($TP_COUNT samples)"; else fail "TP fixture size" "only $TP_COUNT samples"; fi

# Every pattern label in the scanner has at least one true-positive sample.
SCANNER_LABELS=$(sed -n "/^PATTERNS=(/,/^)/p" "$SCAN" | grep -oE "^    '[^|]+" | sed "s/^    '//")
while IFS= read -r label; do
    [ -n "$label" ] || continue
    if cut -f1 "$FIXTURES/secret-samples.txt" | grep -qxF -- "$label"; then
        pass "pattern has a TP sample: $label"
    else
        fail "pattern has a TP sample: $label" "add a line to fixtures/secret-samples.txt"
    fi
done <<< "$SCANNER_LABELS"

# --- False positives ---
while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    labels=$(printf '%s\n' "$line" | bash "$SCAN" --check-stdin)
    rc=$?
    if [ "$rc" -eq 0 ]; then pass "FP: ${line:0:60}"; else fail "FP: ${line:0:60}" "flagged as: $labels"; fi
done < "$FIXTURES/false-positives.txt"

# --- Pattern hygiene ---
# No PCRE-only syntax: the hook must work with BSD grep -E (macOS) as well as GNU grep.
PCRE_ONLY=$(sed -n "/^PATTERNS=(/,/^)/p" "$SCAN" | grep -E '\\[dswb]|\(\?[<=!:]' || true)
assert_eq "patterns use POSIX ERE only (no \\d, \\s, lookarounds)" "" "$PCRE_ONLY"
