# Leash dashboard

Read only view of one Leash agent name: its owner, expiry countdown, agent address, policy (quote token, daily cap, allowed tokens), today's spend and the last swaps. It polls the chain every 5 seconds so cutting the leash shows up live during the demo. No wallet, no backend, plain Vite + React + viem.

## Run locally

```bash
cd dashboard
bun install
bun run sync-deployments   # copies ../deployments/${LEASH_ENV:-anvil}.json to public/deployments.json
bun run dev                # http://localhost:5173
```

`sync-deployments` fails loudly when the JSON is missing: run the Forge deploy scripts against anvil first, or set `LEASH_ENV=sepolia` to use the committed Sepolia record.

Local anvil demo URL (defaults, nothing to type):

```
http://localhost:5173/app?label=trader-1
```

Against the live Sepolia deployment, with the demo controls and the feed: `LEASH_NETWORK=sepolia script/demo.sh dashboard`
from the repo root. It copies `deployments/sepolia.json`, and points both the browser and the demo controls at
`SEPOLIA_RPC_URL`.

## Hosted build (Vercel)

`vercel.json` at the repo root builds this folder with `LEASH_ENV=sepolia`, so the site reads the committed
`deployments/sepolia.json`. `.env.production` sets the default RPC to a public Sepolia endpoint (`VITE_LEASH_RPC`):
never a keyed RPC, it ships in the bundle. `.vercelignore` uploads only `dashboard/` and `deployments/`. The hosted
site is read only: no dev server, so no demo controls and no activity feed. Deploy with `vercel --prod` from the
repo root.

## Demo mode (dev server only)

`scripts/demo-server.ts` is a Vite plugin active under `bun run dev`. It keeps an in-memory activity feed
(`/api/agent-events`, fed by the agent's MCP server) and performs the two human actions of the demo with the
keys from the repo root `.env`: `/api/demo/tighten` (risk-manager, `setText(leash.dailyNotional)`),
`/api/demo/forbid` (risk-manager tries to revoke, must revert) and `/api/demo/cut` (owner, `unregister`).
Keys never reach the browser. The static build has no plugin: the feed shows offline and the controls hide.

## URL parameters

| Param         | Default                                        | Meaning                                                                  |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `rpc`         | `VITE_LEASH_RPC`, else `http://127.0.0.1:8545` | JSON-RPC endpoint (anvil, or a Sepolia RPC for the public deployment)    |
| `deployments` | `/deployments.json`                            | Path or URL of the deployments JSON described in `deployments/README.md` |
| `label`       | `trader-1`                                     | Agent subname label. The full name is `<label>.<parentName from JSON>`   |

The settings drawer (top right) edits the same values and also accepts a pasted deployments JSON blob, stored in the browser and used instead of the URL. Chain id comes from the JSON.

## What it reads

- Registry: `getOwner(labelId)`, `getExpiry(labelId)`, `getResolver(label)` with `labelId = uint256(keccak256(label))`.
- Hook: `policy(label)`, `spentToday(node)`, `nonces(node)`, and `LeashSwap` logs over the last 5000 blocks (chunked by 1000, then incremental per poll).
- Resolver fallback: when `policy()` reverts (revoked or expired name) the last known records are read through `resolve(dnsName, text(...) | addr(...))` and marked "last known".

Status pill: LIVE, EXPIRING (under 10 minutes left), REVOKED (expiry at or before chain time, or the hook reverts `LeashRevoked`). Remaining is computed as `cap - spentToday` client side.

## Checks

```bash
bun test                 # pure helpers: DNS encoding, namehash, config, status, formatting, block chunking
bun run typecheck        # tsc --noEmit
bun run build            # static build in dist/
```

## Record the demo video

```bash
bun run record-demo        # Playwright drives docs/demo.md acts 1 to 5, writes ../docs/demo/leash-demo.webm
```

Needs a fresh anvil fork (`trader-1` LIVE, nothing spent) and the dev server on `http://localhost:5173`. See "Record the demo as a video" in `docs/demo.md`.

## Deploy on Vercel

Static build, no server functions.

- Root directory: `dashboard`
- Install command: `bun install`
- Build command: `LEASH_ENV=sepolia bun run sync-deployments && bun run build`
- Output directory: `dist`

Then open `https://<project>.vercel.app/?rpc=<sepolia rpc url>&label=trader-1`. Public Sepolia RPCs rate limit `eth_getLogs`, so use a dedicated endpoint (Alchemy, Infura, dRPC) in the `rpc` parameter. Nothing is stored server side, the RPC URL only ever lives in the visitor's address bar.
