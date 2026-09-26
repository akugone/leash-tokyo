#!/usr/bin/env bash
# Leash demo rehearsal on a local anvil fork of Sepolia.
#
# Usage:
#   script/demo.sh anvil     # start anvil forking Sepolia a few blocks behind head, or at FORK_BLOCK (foreground)
#   script/demo.sh fund      # give the three demo keys ETH on the fork (setup does it too)
#   script/demo.sh setup     # act 0: register parent name, deploy registry/resolver/hook/pool, issue agent, grant risk-manager,
#                            #   then sync the record to the dashboard and clear its activity feed
#   script/demo.sh tighten   # act 4: risk-manager lowers the cap to NEW_CAP (default 1)
#   script/demo.sh forbid    # act 4: risk-manager tries to revoke / re-point the agent (must fail)
#   script/demo.sh cut       # act 5: owner cuts the leash
#   script/demo.sh short     # bonus: issue trader-2 with a 3 minute expiry
#   script/demo.sh agent     # open Claude Code as the trading agent (MCP tools leash_policy, leash_swap)
#   script/demo.sh status    # print the deployment record
#
# Requires: foundry, a .env with SEPOLIA_RPC_URL, OWNER_PK, RISK_MANAGER_PK, AGENT_PK (see .env.example).
set -euo pipefail

cd "$(dirname "$0")/.."
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
[ -f .env ] && set -a && . ./.env && set +a

RPC="${RPC_URL:-http://127.0.0.1:8545}"
export LEASH_DEPLOYMENTS_FILE="${LEASH_DEPLOYMENTS_FILE:-deployments/anvil.json}"
# Empty: fork a few blocks behind the Sepolia head, which a non-archive RPC can still serve.
FORK_BLOCK="${FORK_BLOCK:-}"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:5173}"

script() { # <path> [extra args]
    local path="$1"; shift
    forge script "$path" --rpc-url "$RPC" --broadcast --skip-simulation --non-interactive -vv "$@"
}

fund_all() { # give the three demo accounts 100 ETH on the fork
    for pk in "$OWNER_PK" "$RISK_MANAGER_PK" "$AGENT_PK"; do
        addr=$(cast wallet address --private-key "$pk")
        code=$(cast code "$addr" --rpc-url "$RPC")
        if [ "$code" != "0x" ]; then
            echo "!! $addr has code on the fork (EIP-7702 delegated?). Generate a fresh key with 'cast wallet new'." >&2
            exit 1
        fi
        cast rpc --rpc-url "$RPC" anvil_setBalance "$addr" 0x56BC75E2D63100000 >/dev/null
        echo "funded $addr"
    done
}

case "${1:-}" in
anvil)
    : "${SEPOLIA_RPC_URL:?set SEPOLIA_RPC_URL in .env}"
    rm -f deployments/anvil.json
    if [ -z "$FORK_BLOCK" ]; then
        FORK_BLOCK=$(( $(cast block-number --rpc-url "$SEPOLIA_RPC_URL") - 5 ))
    fi
    echo "forking Sepolia at block $FORK_BLOCK"
    exec anvil --fork-url "$SEPOLIA_RPC_URL" --fork-block-number "$FORK_BLOCK" --block-time 2
    ;;
fund)
    fund_all
    ;;
setup)
    fund_all
    echo "== 1/7 register parent name: commit"
    script script/ens/RegisterParent.s.sol --sig 'commit()'
    echo "== wait for MIN_COMMITMENT_AGE (60s) on the fork"
    cast rpc --rpc-url "$RPC" evm_increaseTime 61 >/dev/null
    cast rpc --rpc-url "$RPC" evm_mine >/dev/null
    echo "== 1/7 register parent name: reveal"
    script script/ens/RegisterParent.s.sol --sig 'reveal()'
    echo "== 2/7 deploy org registry"
    script script/ens/DeployOrgRegistry.s.sol
    echo "== 3/7 deploy org resolver"
    script script/ens/DeployOrgResolver.s.sol
    echo "== 4/7 deploy hook"
    script script/DeployHook.s.sol
    echo "== 5/7 tokens, pool, liquidity"
    script script/SetupPool.s.sol
    echo "== 6/7 issue agent subname and policy"
    script script/ens/IssueAgent.s.sol
    echo "== 7/7 grant risk-manager"
    script script/ens/GrantRiskManager.s.sol
    echo "== done"
    cat "$LEASH_DEPLOYMENTS_FILE"
    echo
    echo "== dashboard: sync deployments, clear the activity feed"
    mkdir -p dashboard/public
    cp "$LEASH_DEPLOYMENTS_FILE" dashboard/public/deployments.json
    if curl -sf -X DELETE "$DASHBOARD_URL/api/agent-events" >/dev/null; then
        echo "feed cleared, reload $DASHBOARD_URL/?label=${AGENT_LABEL:-trader-1}"
    else
        echo "dashboard not running at $DASHBOARD_URL (start it with: cd dashboard && bun run dev)"
    fi
    ;;
tighten)
    script script/demo/TightenCap.s.sol
    ;;
forbid)
    forge script script/demo/RiskManagerTriesRevoke.s.sol --rpc-url "$RPC" -vv
    ;;
cut)
    script script/demo/CutLeash.s.sol
    ;;
short)
    script script/ens/IssueShortLived.s.sol
    ;;
agent)
    # Claude Code is the agent terminal: only the two Leash tools, persona from agent/prompt.md.
    export RPC_URL="$RPC"
    exec claude --mcp-config agent/mcp.json --strict-mcp-config \
        --allowedTools "mcp__leash__leash_policy,mcp__leash__leash_swap" \
        --disallowedTools "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Agent" \
        --append-system-prompt "$(cat agent/prompt.md)" "${@:2}"
    ;;
status)
    cat "$LEASH_DEPLOYMENTS_FILE"
    ;;
*)
    sed -n 2,15p "$0"
    exit 1
    ;;
esac
