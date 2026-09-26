#!/usr/bin/env bash
# Scripted operator for the recorded demo: shows orders being typed to Claude Code (as trader-1) and
# Claude's tool calls and answers. Orders arrive one per line on a FIFO, a token goes out on another
# FIFO when Claude is done, so dashboard/scripts/record-live.ts can interleave the dashboard clicks.
#
#   script/agent-session.sh <orders-fifo> <done-fifo>
#
# Same Claude Code flags as `script/demo.sh agent`, plus one fixed session id so every order continues
# the same conversation.
set -euo pipefail
cd "$(dirname "$0")/.."
ORDERS="$1"; DONE="$2"
# iTerm may start us outside a login shell: make sure bun and claude are reachable, and keep the window
# open long enough to read an error instead of vanishing.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
trap 'printf "\n  agent-session.sh failed at line %s\n" "$LINENO"; sleep 120' ERR
command -v claude >/dev/null || { echo "claude not found on PATH"; sleep 120; exit 1; }
command -v bun >/dev/null || { echo "bun not found on PATH"; sleep 120; exit 1; }
[ -f .env ] && set -a && . ./.env && set +a
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
SESSION_ID="$(uuidgen | tr 'A-Z' 'a-z')"

G=$'\033[1;32m'; B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; R=$'\033[0m'

clear
printf '%s' "${D}"
printf '  Leash · agent terminal\n'
printf '  Claude Code as %s.%s, tools: leash_policy, leash_swap\n' "${AGENT_LABEL:-trader-1}" "${PARENT_LABEL:-leash}.eth"
printf '  The agent holds the trader key. It cannot change its own limits.\n'
printf '%s\n' "${R}"

first=1
while true; do
    order=""
    IFS= read -r order < "$ORDERS" || true
    [ -z "$order" ] && continue
    [ "$order" = "__quit__" ] && break

    # Operator prompt, typed one character at a time.
    printf '\n%s›%s %s' "$G" "$R" "$B"
    for ((i = 0; i < ${#order}; i++)); do
        printf '%s' "${order:i:1}"
        sleep 0.045
    done
    printf '%s\n\n' "$R"

    if [ "$first" = 1 ]; then session=(--session-id "$SESSION_ID"); first=0; else session=(--resume "$SESSION_ID"); fi
    claude -p "$order" "${session[@]}" \
        --mcp-config agent/mcp.json --strict-mcp-config \
        --allowedTools "mcp__leash__leash_policy,mcp__leash__leash_swap" \
        --disallowedTools "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Agent" \
        --append-system-prompt "$(cat agent/prompt.md)" \
        --output-format stream-json --verbose 2>/dev/null \
        | bun run agent/scripts/render-stream.ts || printf '  %s(claude exited with an error)%s\n' "$C" "$R"

    echo done > "$DONE"
done
printf '\n%s  end of session%s\n' "$D" "$R"
