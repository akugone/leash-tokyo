# Leash agent

Small bun + viem package: the demo agent that signs EIP-712 `SwapIntent`s and swaps through the Uniswap v4
`PoolSwapTest` router with the intent in `hookData`. It also produces the cross language fixture that
`test/LeashIntentFixture.t.sol` checks against `LeashIntentLib`.

```
agent/
  src/intent.ts       typed data, signing, hookData codec, namehash / dnsEncode helpers
  src/abi.ts          hand written LeashHook, WrappedError, PoolSwapTest and ERC20 ABIs
  src/errors.ts       unwraps v4-core WrappedError and explains hook errors in one line
  src/bot.ts          the CLI loop (ticket L-16)
  src/leash.ts        LeashClient: read the enforced policy, swap with a signed intent, report to the dashboard feed
  src/mcp.ts          MCP server exposing leash_policy and leash_swap, the agent terminal of the demo
  prompt.md           persona appended to Claude Code's system prompt by script/demo.sh agent
  mcp.json            MCP config loaded by script/demo.sh agent
  src/bot.test.ts     bun tests, no network
  scripts/gen-fixture.ts  writes test/fixtures/intent.json (ticket L-09)
```

## Setup

```bash
cd agent
bun install
```

Environment (read from `agent/.env`, then the repo root `.env`, see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RPC_URL` | `SEPOLIA_RPC_URL`, else `http://127.0.0.1:8545` | JSON-RPC endpoint |
| `AGENT_PK` | required | key whose address is the `addr` record of the agent name |
| `LEASH_DEPLOYMENTS_FILE` | `../deployments/anvil.json` | JSON written by the Forge scripts (see `deployments/README.md`). Absolute, cwd relative, or repo root relative paths all work |

## Claude Code as the agent

```bash
script/demo.sh agent          # from the repo root: claude --mcp-config agent/mcp.json --append-system-prompt "$(cat agent/prompt.md)" ...
```

Claude gets exactly two tools, both signed with `AGENT_PK`: `leash_policy` (what the hook enforces right now) and
`leash_swap` (exact input swap of the quote token). The prompt tells it to attempt any order as given and report
what the chain answered, never to clamp or refuse on its own: the hook is the enforcement point. Every call is
posted to the dashboard feed (`LEASH_FEED_URL`, default `http://localhost:5173/api/agent-events`, `off` to disable).

## Scripts

### Run the bot

```bash
bun run src/bot.ts                 # loop every 15 s, spend 10% of the cap per swap
bun run src/bot.ts --once          # one attempt then exit
bun run src/bot.ts --misbehave     # request remaining + 1 so the hook answers DailyCapExceeded
bun run src/bot.ts --force --once  # send even when the policy read reverts or nothing is left today
bun run src/bot.ts --amount 5000000 --label trader-1 --interval 5
```

Modes:

| Flag | Amount | Behaviour when `policy(label)` reverts or `remainingToday` is 0 |
| --- | --- | --- |
| none | min(`--amount` or 10% of cap, remaining) | prints the reason and skips the tick |
| `--misbehave` | remaining + 1, or cap + 1 when nothing is left | skips when the policy read reverts |
| `--slippage-bps <n>` | price move the swap may allow; defaults to the policy's `leash.maxSlippageBps` (full range when unset), never clamped | a wider value than the policy goes out as is and the hook answers `SlippageTooLoose` |
| `--force` | exactly `--amount`, default 1e18 wei, never clamped | still signs and sends, so the audience sees the on chain rejection (`LeashRevoked`, `DailyCapExceeded`, ...). Falls back to the last nonce it read if `nonces(node)` fails, and derives the direction from `quote == token0` in the deployments JSON |

Each tick prints one status line (agent, cap, remaining today, nonce, expiry), then either the tx hash and
the new `spentToday`, or the decoded hook revert, for example:

```
[2026-09-21 18:04:11] trader-1.leashdemo.eth agent=0x3C44...93BC cap=1000 USDC remaining=400 USDC nonce=3 expires 2026-10-19T18:00:00.000Z
  MISBEHAVE swap 400.000001 USDC exact in, 0->1, deadline 1758477251
  REVERT DailyCapExceeded: trader-1.leashdemo.eth would reach 1000000001 of cap 1000000000 today
```

The swap is always simulated first (`simulateContract`) so a revert costs no gas and the reason is decoded
from the ERC-7751 `WrappedError` the PoolManager bubbles up. The first successful run approves
`PoolSwapTest` for the quote token.

### Regenerate the EIP-712 fixture

```bash
bun run scripts/gen-fixture.ts
cd .. && forge test --match-path test/LeashIntentFixture.t.sol -vvv
```

The fixture is deterministic (anvil key #0, chain 11155111, verifying contract `0x1000...0001`). Regenerate
it only when the `SwapIntent` struct or the domain changes, and keep the Foundry test green.

### Tests and typecheck

```bash
bun test
bunx tsc --noEmit
```
