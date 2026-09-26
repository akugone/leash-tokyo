#!/usr/bin/env bash
# Leash demo: rehearsal on a local anvil fork of Sepolia, or the live Sepolia deployment.
#
# Usage:
#   script/demo.sh anvil     # start anvil forking Sepolia a few blocks behind head, or at FORK_BLOCK (foreground)
#   script/demo.sh fund      # give the three demo keys ETH on the fork (setup does it too)
#   script/demo.sh setup     # act 0: register parent name, deploy registry/hook/pool, issue the agent with its own
#                            #   resolver, grant risk-manager on it, then sync the record to the dashboard and clear its feed
#   script/demo.sh tighten   # act 4: risk-manager lowers the cap to NEW_CAP (default 1)
#   script/demo.sh forbid    # act 4: risk-manager tries to revoke / re-point the agent (must fail)
#   script/demo.sh cut       # act 5: owner cuts the leash
#   script/demo.sh short     # bonus: issue trader-2 with a 3 minute expiry, its own resolver, no risk-manager
#   script/demo.sh agent     # open Claude Code as the trading agent (MCP tools leash_policy, leash_swap)
#                            #   LEASH_RECORD_REFUSALS=1: send refused swaps anyway, recorded on chain (agent pays gas)
#   script/demo.sh dashboard # dashboard dev server for this network, with the demo controls and the feed
#   script/demo.sh status    # print the deployment record
#
# Live Sepolia: prefix any command with LEASH_NETWORK=sepolia (RPC is SEPOLIA_RPC_URL, record is
# deployments/sepolia.json). Two commands exist only there:
#   LEASH_NETWORK=sepolia script/demo.sh deploy   # act 0 on the real chain: same steps as setup, paid in real
#                                                 #   Sepolia ETH by OWNER_PK. PARENT_DURATION (default 365 days)
#                                                 #   and AGENT_TTL (default 30 days) in seconds
#   LEASH_NETWORK=sepolia script/demo.sh verify   # verify hook, vault and tokens on Etherscan (ETHERSCAN_API_KEY)
#
# Either network:
#   script/demo.sh migrate-vault     # deploy a fresh LeashVault and move the pool tokens over (owner signs)
#   script/demo.sh migrate-resolver  # move a live agent (LABEL, default agentLabel) off a shared resolver onto its
#                                    #   own, records copied as they are, then grant the risk-manager on it
#
# Requires: foundry, a .env with SEPOLIA_RPC_URL, OWNER_PK, RISK_MANAGER_PK, AGENT_PK (see .env.example).
set -euo pipefail

cd "$(dirname "$0")/.."
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
[ -f .env ] && set -a && . ./.env && set +a

NETWORK="${LEASH_NETWORK:-anvil}"
case "$NETWORK" in
anvil)
    RPC="${RPC_URL:-http://127.0.0.1:8545}"
    export LEASH_DEPLOYMENTS_FILE="${LEASH_DEPLOYMENTS_FILE:-deployments/anvil.json}"
    ;;
sepolia)
    : "${SEPOLIA_RPC_URL:?set SEPOLIA_RPC_URL in .env}"
    RPC="$SEPOLIA_RPC_URL"
    # Overrides the .env value, which points at the anvil record for rehearsals.
    export LEASH_DEPLOYMENTS_FILE=deployments/sepolia.json
    ;;
*)
    echo "LEASH_NETWORK must be anvil or sepolia, got $NETWORK" >&2
    exit 1
    ;;
esac
# Empty: fork a few blocks behind the Sepolia head, which a non-archive RPC can still serve.
FORK_BLOCK="${FORK_BLOCK:-}"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:5173}"

script() { # <path> [extra args]
    local path="$1"; shift
    forge script "$path" --rpc-url "$RPC" --broadcast --skip-simulation --non-interactive -vv "$@"
}

only_on() { # <network> <command>
    if [ "$NETWORK" != "$1" ]; then
        echo "'$2' runs on $1 only (LEASH_NETWORK is $NETWORK)" >&2
        exit 1
    fi
}

# Real chain: wait for each receipt before sending the next transaction.
live_script() { # <path> [extra args]
    script "$@" --slow
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
    only_on anvil anvil
    : "${SEPOLIA_RPC_URL:?set SEPOLIA_RPC_URL in .env}"
    rm -f deployments/anvil.json
    if [ -z "$FORK_BLOCK" ]; then
        FORK_BLOCK=$(( $(cast block-number --rpc-url "$SEPOLIA_RPC_URL") - 5 ))
    fi
    echo "forking Sepolia at block $FORK_BLOCK"
    exec anvil --fork-url "$SEPOLIA_RPC_URL" --fork-block-number "$FORK_BLOCK" --block-time 2
    ;;
fund)
    only_on anvil fund
    fund_all
    ;;
setup)
    only_on anvil setup
    fund_all
    echo "== 1/6 register parent name: commit"
    script script/ens/RegisterParent.s.sol --sig 'commit()'
    echo "== wait for MIN_COMMITMENT_AGE (60s) on the fork"
    cast rpc --rpc-url "$RPC" evm_increaseTime 61 >/dev/null
    cast rpc --rpc-url "$RPC" evm_mine >/dev/null
    echo "== 1/6 register parent name: reveal"
    script script/ens/RegisterParent.s.sol --sig 'reveal()'
    echo "== 2/6 deploy org registry"
    script script/ens/DeployOrgRegistry.s.sol
    echo "== 3/6 deploy hook"
    script script/DeployHook.s.sol
    echo "== 4/6 tokens, pool, liquidity"
    script script/SetupPool.s.sol
    echo "== 5/6 issue agent subname: its own resolver, holding its policy"
    script script/ens/IssueAgent.s.sol
    echo "== 6/6 grant risk-manager on the agent's resolver"
    script script/ens/GrantRiskManager.s.sol
    echo "== done"
    cat "$LEASH_DEPLOYMENTS_FILE"
    echo
    echo "== dashboard: sync deployments, clear the activity feed"
    mkdir -p dashboard/public
    cp "$LEASH_DEPLOYMENTS_FILE" dashboard/public/deployments.json
    if curl -sf -X DELETE "$DASHBOARD_URL/api/agent-events" >/dev/null; then
        echo "feed cleared, reload $DASHBOARD_URL/app?label=${AGENT_LABEL:-trader-1}"
    else
        echo "dashboard not running at $DASHBOARD_URL (start it with: cd dashboard && bun run dev)"
    fi
    ;;
deploy)
    only_on sepolia deploy
    if [ -f "$LEASH_DEPLOYMENTS_FILE" ]; then
        echo "$LEASH_DEPLOYMENTS_FILE exists: Leash is already live. Move it away to deploy again." >&2
        exit 1
    fi
    export PARENT_DURATION="${PARENT_DURATION:-31536000}"
    export AGENT_TTL="${AGENT_TTL:-2592000}"
    for pk in "$OWNER_PK" "$RISK_MANAGER_PK" "$AGENT_PK"; do
        addr=$(cast wallet address --private-key "$pk")
        echo "$addr: $(cast balance "$addr" --ether --rpc-url "$RPC") ETH"
    done
    echo "== 1/6 register ${PARENT_LABEL:-leash}.eth for $PARENT_DURATION s: commit"
    live_script script/ens/RegisterParent.s.sol --sig 'commit()'
    echo "== wait for MIN_COMMITMENT_AGE (60 s) on chain"
    sleep 75
    echo "== 1/6 register parent name: reveal"
    live_script script/ens/RegisterParent.s.sol --sig 'reveal()'
    echo "== 2/6 deploy org registry"
    live_script script/ens/DeployOrgRegistry.s.sol
    echo "== 3/6 deploy hook"
    live_script script/DeployHook.s.sol
    echo "== 4/6 tokens, pool, liquidity, vault"
    live_script script/SetupPool.s.sol
    echo "== 5/6 issue agent subname with its own resolver, $AGENT_TTL s"
    live_script script/ens/IssueAgent.s.sol
    echo "== 6/6 grant risk-manager on the agent's resolver"
    live_script script/ens/GrantRiskManager.s.sol
    echo "== done, commit $LEASH_DEPLOYMENTS_FILE"
    cat "$LEASH_DEPLOYMENTS_FILE"
    ;;
verify)
    only_on sepolia verify
    : "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY in .env}"
    get() { jq -r ".$1" "$LEASH_DEPLOYMENTS_FILE"; }
    # SepoliaAddresses.UNI_POOL_MANAGER and UNI_POOL_SWAP_TEST in script/Addresses.sol.
    pool_manager=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543
    pool_swap_test=0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe
    verify() { # <address> <contract> <constructor args>
        forge verify-contract "$1" "$2" --chain sepolia --constructor-args "$3" --watch || echo "!! $2 at $1 not verified"
    }
    verify "$(get hook)" src/LeashHook.sol:LeashHook \
        "$(cast abi-encode 'f(address,address,string)' "$pool_manager" "$(get orgRegistry)" "$(get parentName)")"
    verify "$(get vault)" src/LeashVault.sol:LeashVault \
        "$(cast abi-encode 'f(address,address,address)' "$(get hook)" "$pool_swap_test" "$(get orgOwner)")"
    for key in token0 token1; do
        token=$(get "$key")
        verify "$token" src/mocks/LeashTestToken.sol:LeashTestToken \
            "$(cast abi-encode 'f(string,string)' "$(cast call "$token" 'name()(string)' --rpc-url "$RPC" | tr -d '"')" "$(cast call "$token" 'symbol()(string)' --rpc-url "$RPC" | tr -d '"')")"
    done
    ;;
migrate-vault)
    if [ "$NETWORK" = sepolia ]; then live_script script/MigrateVault.s.sol; else script script/MigrateVault.s.sol; fi
    jq '{vault, vaultPrevious}' "$LEASH_DEPLOYMENTS_FILE"
    ;;
migrate-resolver)
    label="${LABEL:-$(jq -r .agentLabel "$LEASH_DEPLOYMENTS_FILE")}"
    run_script() { if [ "$NETWORK" = sepolia ]; then live_script "$@"; else script "$@"; fi; }
    echo "== 1/2 $label: own resolver, records copied, name re-pointed"
    run_script script/ens/MigrateAgentResolver.s.sol --sig 'migrate(string)' "$label"
    echo "== 2/2 grant risk-manager on $label's resolver"
    run_script script/ens/GrantRiskManager.s.sol --sig 'grant(string)' "$label"
    ;;
dashboard)
    # Local dev server: the browser and the demo controls both use this network's RPC and record.
    mkdir -p dashboard/public
    cp "$LEASH_DEPLOYMENTS_FILE" dashboard/public/deployments.json
    export RPC_URL="$RPC" VITE_LEASH_RPC="$RPC"
    echo "dashboard on $NETWORK: http://localhost:${PORT:-5173}/app?label=${AGENT_LABEL:-trader-1}"
    cd dashboard && exec bun run dev
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
