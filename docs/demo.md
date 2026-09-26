# Leash demo script

Two windows side by side, about three minutes. Left: a terminal where Claude Code is the trading agent, holding the trader key and two tools. Right: the dashboard, the organisation's view, with the risk-manager and owner controls. The presenter types orders to the agent and clicks the human actions; the chain arbitrates.

Everything below runs against an anvil fork of Sepolia (a few blocks behind head, or `FORK_BLOCK`), talking to the real ENSv2 contracts and the real Uniswap v4 PoolManager. Only the two demo ERC20 tokens are ours. The same flow targets Sepolia itself by pointing `RPC_URL` and `LEASH_DEPLOYMENTS_FILE` at `deployments/sepolia.json`.

## Before the show

Four terminals.

```bash
# terminal 1: the chain
script/demo.sh anvil

# terminal 2: act 0, one shot (about a minute)
script/demo.sh setup

# terminal 3: the dashboard
cd dashboard && bun run dev
# open http://localhost:5173/?label=trader-1

# terminal 4: the agent (keep this one visible next to the browser)
script/demo.sh agent
```

`setup` funds the three demo keys, registers `leash.eth` through the ENS commit/reveal registrar (paid in the testnet MockUSDC), deploys the org registry and resolver through ENS `VerifiableFactory`, deploys `LeashHook` at a mined CREATE2 address, creates the `lUSD/lETH` pool with the hook, seeds liquidity, deploys the org `LeashVault` and funds it with 100k of each token (the agent holds none), issues `trader-1.leash.eth` with its policy and grants the risk-manager its two scoped roles. It ends by printing `deployments/anvil.json`.

`agent` opens Claude Code with `agent/mcp.json` (the Leash MCP server, `agent/src/mcp.ts`) and the persona in `agent/prompt.md`. Claude has exactly two tools, `leash_policy` and `leash_swap`, both signed with `AGENT_PK`. Every tool call is mirrored to the dashboard's activity feed.

Keys: `.env` holds three fresh keys (`cast wallet new`). Never use anvil's default accounts on a Sepolia fork, they carry EIP-7702 delegations and the ENS registry mint reverts.

## Act 1: identity (30 s)

Dashboard: `trader-1.leash.eth`, status LIVE, expiry countdown (7 days), agent address, cap 250 lUSD, allowed tokens, hook, org vault with its balances, and registry addresses. Two role cards on the right: risk-manager and owner.

Agent terminal, ask: `what is your mandate?` Claude calls `leash_policy` and answers with the cap, spent, remaining, tokens and expiry.

Say: the name is the credential, the resolver holds the policy, the hook enforces it. The agent can read its leash, not change it.

## Act 2: an honest order (20 s)

Agent terminal: `buy 25 lUSD worth of lETH`

Observed (Claude's answer):

```
Sold 25 lUSD for lETH. Tx 0xd669…2178, block 11752589. Spent today: 25 / 250 lUSD cap.
```

Dashboard activity feed: `signed SwapIntent: 25 lUSD exact in, 0->1, nonce 0`, `sent 0xd669…`, `OK block 11752589, spent today 25 lUSD of 250 lUSD`. The leash bar moves to 10 percent, the swap appears in the table, and the org vault card shows 25 lUSD less: the vault paid, the agent itself holds no tokens.

## Act 3: the agent oversteps (20 s)

Agent terminal: `buy 300 lUSD worth of lETH, all at once`

Observed:

```
Sell 300 lUSD → lETH: REVERT DailyCapExceeded (would reach 325 of 250 lUSD cap). Nothing moved.
```

Feed: `signed SwapIntent: 300 lUSD …` then `REVERT DailyCapExceeded: trader-1.leash.eth would reach 325 lUSD of cap 250 lUSD today`. The agent did try: the prompt tells it never to clamp an order. The revert comes from `afterSwap`, measured on the real settlement delta.

Say: we do not trust the agent's prompt, we trust the hook.

## Act 3b: the owner narrows the slippage (30 s, optional)

Dashboard, owner card: type `5` in max slippage (basis points), click **set slippage**. One transaction, `setText(leash.maxSlippageBps, "5")` on the org resolver. Only the owner can: the risk manager holds no role on this key, and its **try to revoke** also fails to clear it.

Feed: `owner sets leash.maxSlippageBps to 5 bps (0.05%)`, `OK block …, max slippage is now 5 bps`. Mandate card: max slippage 0.05%.

Agent terminal: `buy 100 lUSD of lETH`. The agent now reads 5 bps and requests 4 (90% of the bound): the swap stops at that price limit and is partially filled, about 40 of the 100 lUSD. Then `buy 20 lUSD of lETH with 0.5% slippage`: the hook answers `SlippageTooLoose`, nothing moves.

Say: the price impact bound lives in the name too. One record, no redeploy, the agent adapts on its next read.

## Act 4: the risk desk tightens the leash (40 s)

Dashboard, risk-manager card: type `10` in daily cap, click **tighten the leash**. The risk-manager key holds exactly one power: `ROLE_SET_TEXT` on the `leash.dailyNotional` and `leash.tokens` keys of the org resolver.

Feed: `risk-manager sets leash.dailyNotional to 10 lUSD`, `OK block …, cap is now 10 lUSD`. Cap card 10, remaining 0, bar full.

Agent terminal: `buy 5 lUSD of lETH`. Claude reads the policy (remaining 0), tries, reports `DailyCapExceeded`.

Then click **try to revoke**. Three static calls as the risk-manager: `unregister`, `setAddress`, `setText(leash.quote)`. Feed:

```
PASS unregister(trader) by risk-manager -> EACUnauthorizedAccountRoles
PASS setAddress(agent) by risk-manager -> EACUnauthorizedAccountRoles
PASS setText(leash.quote) by risk-manager -> EACUnauthorizedAccountRoles
```

Say: tightening limits at 3am and killing an agent are two different powers, and ENSv2 Enhanced Access Control keeps them on two different keys without a line of custom authorization code.

## Act 5: cut the leash (30 s)

Dashboard, owner card: click **cut the leash**. One transaction, `unregister(labelId)` on the org registry.

Feed: `owner cuts trader-1.leash.eth: unregister(labelId)`, `leash cut block …`. Status flips to REVOKED, the bar turns red, owner card reads `burned (unregistered)`, resolver `0x0`.

Agent terminal: `buy 5 lUSD of lETH`. Claude's `leash_policy` comes back `LeashRevoked: trader-1.leash.eth was cut at …`; if it tries the swap anyway, the PoolManager reverts with `LeashRevoked` from `beforeSwap`.

Say: no key rotation, no redeploy. The agent still holds its key. The key is worth nothing.

## Fallback without Claude Code

The same acts from the shell, useful if the LLM is slow or offline. The scripted bot never clamps either.

```bash
cd agent
bun run src/bot.ts --once                       # act 2, 25 lUSD
bun run src/bot.ts --once --misbehave           # act 3, remaining + 1 wei -> DailyCapExceeded
NEW_CAP=10000000000000000000 ../script/demo.sh tighten   # act 4
../script/demo.sh forbid                        # act 4, second beat
../script/demo.sh cut                           # act 5
bun run src/bot.ts --once                       # LeashRevoked
```

The dashboard controls call the same contracts as `tighten`, `forbid` and `cut` through the dev server (`dashboard/scripts/demo-server.ts`), so either path is fine mid-demo.

## Bonus: a mandate that lapses on its own (if time remains)

```bash
script/demo.sh short                 # issues trader-2.leash.eth with a 3 minute expiry
bun run src/bot.ts --once --label trader-2      # OK, 25 lUSD
# three minutes later (on anvil: cast rpc evm_increaseTime 181 && cast rpc evm_mine)
bun run src/bot.ts --once --label trader-2      # LeashRevoked: trader-2.leash.eth was cut at <expiry>
```

## Record the demo as a video

Two recorders, both need a fresh fork (LIVE, nothing spent) and the dashboard dev server. Recordings are gitignored.

**Two windows, Claude Code as the agent** (the real demo, macOS only):

```bash
cd dashboard && bun run record-live
# -> docs/demo/leash-demo-live.mov (about 3 minutes, H.264)
```

`scripts/record-live.ts` opens a Terminal window on the left running `script/agent-session.sh` (types each order, runs it through `claude -p` in one shared session, renders the tool calls with `agent/scripts/render-stream.ts`), Chromium on the right on the dashboard, and records the region with `screencapture -v`. It types the orders of acts 1 to 5 and clicks tighten, try to revoke and cut between them. The app running the command (Terminal, VS Code…) must be allowed under System Settings > Privacy & Security > Screen Recording, and restarted after the change. `NO_CAPTURE=1` rehearses without recording.

**Dashboard only, shell fallback** (Playwright, works headless):

```bash
cd dashboard && bun run record-demo
# -> docs/demo/leash-demo.webm (about 1 minute 15, 1440x900)
```

`scripts/record-demo.ts` runs the bot and the `demo.sh` actions between acts and mirrors their output in a panel drawn over the page. An `.mp4` is written next to it when an `ffmpeg` built with libx264 is available (`brew install ffmpeg`, or `FFMPEG=/path/to/ffmpeg`); Playwright's bundled ffmpeg only writes webm. `HEADED=1` shows the browser.

## Reset between rehearsals

Restart `script/demo.sh anvil` (it deletes `deployments/anvil.json`) and run `setup` again: it copies the record to the dashboard and clears the activity feed (kept in the dev server's memory), then reload the page. Each run registers the same `leash` label on a fresh fork.

## Sepolia run

Same acts, with:

```bash
export LEASH_DEPLOYMENTS_FILE=deployments/sepolia.json RPC_URL=$SEPOLIA_RPC_URL
```

`setup` cannot warp time on Sepolia: run `commit()`, wait 60 seconds, then `reveal()` by hand (see `script/ens/RegisterParent.s.sol`). Fund the three keys with Sepolia ETH first. Paste the transaction hashes here once done.
