# Leash

**ENS-native permissions for autonomous traders. Name your agent, bound it, revoke it.**

A Uniswap v4 hook that gates every swap on the trading agent's ENSv2 subname and on the risk policy stored in that name's resolver.

## Live on Sepolia

**Dashboard: [leash-omega.vercel.app/app](https://leash-omega.vercel.app/app)**. Every value on it is read from Sepolia, nothing is hard coded (the RPC is in the footer). The owner and risk-manager cards sign with a connected wallet.

The org is **`leash.eth`** on the ENSv2 beta, and its agent is **`trader-1.leash.eth`**: a daily cap of 250 lUSD, lUSD and lETH allowed, max slippage of 1% (100 bps), a mandate that ends on 2026-10-26.

| Contract | Address | |
|---|---|---|
| `LeashHook` (Uniswap v4 hook) | [`0x8c1f16B42C75190316636a956A4C85F8D1c440c0`](https://sepolia.etherscan.io/address/0x8c1f16B42C75190316636a956A4C85F8D1c440c0#code) | verified |
| `LeashVault` (org treasury the agent trades from) | [`0x3Ee1b2a02CA8a87572B6d172913Db37bd3C37022`](https://sepolia.etherscan.io/address/0x3Ee1b2a02CA8a87572B6d172913Db37bd3C37022#code) | verified |
| lUSD, the quote token (`token0`) | [`0x3EC79AB413c942159218358dfb6EB83Fa1F59C4E`](https://sepolia.etherscan.io/address/0x3EC79AB413c942159218358dfb6EB83Fa1F59C4E#code) | verified |
| lETH (`token1`) | [`0x9E63305f38825e126BBD7A9582a53bd516431C02`](https://sepolia.etherscan.io/address/0x9E63305f38825e126BBD7A9582a53bd516431C02#code) | verified |
| Org Permissioned Registry of `leash.eth` | [`0xe614c0f0D9Ce98Aaf986Fce5f5Ef46614DF64fE9`](https://sepolia.etherscan.io/address/0xe614c0f0D9Ce98Aaf986Fce5f5Ef46614DF64fE9) | ENS `VerifiableFactory` proxy |
| Org Permissioned Resolver (the policy records) | [`0x5112C1F6bF910DC0B127BE2B109Dc484168c668F`](https://sepolia.etherscan.io/address/0x5112C1F6bF910DC0B127BE2B109Dc484168c668F) | ENS `VerifiableFactory` proxy |
| ENSv2 `.eth` registry (holds `leash.eth`) | [`0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E`](https://sepolia.etherscan.io/address/0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E) | ENS |
| Uniswap v4 PoolManager | [`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`](https://sepolia.etherscan.io/address/0xE03A1074c86CFeDd5C142C4F04F1a1536e203543) | Uniswap |

| Role | Address |
|---|---|
| Owner (holds `leash.eth`, cuts the leash) | [`0x703c9e946882859A749B704AFde861D47ED4f8c2`](https://sepolia.etherscan.io/address/0x703c9e946882859A749B704AFde861D47ED4f8c2) |
| Risk manager (may only edit `leash.dailyNotional` and `leash.tokens`) | [`0x1045752bA6d1D88C6B97Ae91A3da6b91F4790E47`](https://sepolia.etherscan.io/address/0x1045752bA6d1D88C6B97Ae91A3da6b91F4790E47) |
| Agent `trader-1.leash.eth` (signs intents, holds only gas ETH) | [`0xA162DbFfd5c4171Fb7058FEAa7a28F5c63C44A0d`](https://sepolia.etherscan.io/address/0xA162DbFfd5c4171Fb7058FEAa7a28F5c63C44A0d) |

Pool: lUSD/lETH, fee 3000, tick spacing 60, id `0x74e548ef341b71b902f9f0b6ff76c3897c1b40201540b9b2ab418338ae75db32`. The full record is [`deployments/sepolia.json`](deployments/sepolia.json).

**Check it yourself**

1. On the hook's [Read Contract](https://sepolia.etherscan.io/address/0x8c1f16B42C75190316636a956A4C85F8D1c440c0#readContract) tab, call `policy("trader-1")`. It returns the agent address, quote token, cap, allowed tokens and expiry, read live from the ENS resolver. `remainingToday("trader-1")` and `maxSlippageBps("trader-1")` work the same way.
2. The first agent swap, [`0x7ca3b71b…2425e9`](https://sepolia.etherscan.io/tx/0x7ca3b71bd806aa3150fb0b3e8e4686160fa6080c97fe98025bd147fa4f2425e9): the agent calls the vault, the vault pays 25 lUSD, and the hook emits `LeashSwap` with the spend counted against the cap.
3. The agent's address holds no lUSD and no lETH: the tokens sit in the vault, which only trades on pools gated by the hook, and only the owner can withdraw from it.
4. On the dashboard, **Try to revoke** simulates the risk manager calling `unregister`, `setAddress` and the owner-only records. Each call reverts with `EACUnauthorizedAccountRoles`, the ENSv2 Enhanced Access Control error.

---

## The problem

DAOs, treasuries and trading desks are handing private keys to bots and AI agents. Today that delegation is all or nothing:

* The key holds full authority over whatever the account can touch.
* If the key leaks, or the agent misbehaves, the treasury leaves in one block.
* Revocation means rotating keys and redeploying infrastructure, not flipping a switch.

There is no onchain answer to a simple question: *is this address still allowed to trade on our behalf, and within what limits?*

## The idea

Leash turns an ENS name into the agent's credential, and a Uniswap v4 hook into the enforcement point.

1. The organisation owns `leash.eth` and deploys its own **Permissioned Registry**.
2. Each agent is issued a revocable subname with an expiry: `trader-1.leash.eth`.
3. The agent's risk policy lives in its **Permissioned Resolver**: the agent address is the name's native `addr` record, and the daily notional cap, allowed tokens and maximum price impact per swap are text records, `leash.quote`, `leash.dailyNotional`, `leash.tokens` and `leash.maxSlippageBps`.
4. **Enhanced Access Control** lets a `risk-manager` role hold `ROLE_SET_TEXT` scoped to just the `leash.dailyNotional` and `leash.tokens` keys, never the name itself, nor the owner-only `leash.maxSlippageBps`. Only the owner can revoke that role.
5. The agent signs an EIP-712 `SwapIntent` (name, pool, direction, amount, nonce, deadline). `hookData` carries the label, the intent and the signature. A **Uniswap v4 hook** recovers the signer and compares it to the name's `addr` record: `beforeSwap` checks identity and the token allowlist, `afterSwap` counts the real quote token delta against the daily cap. No trusted router, any Uniswap v4 router works.

6. The agent holds no tokens. The org's **vault** does: it only trades on pools gated by the Leash hook, only for the agent that signed the intent, and only the owner can withdraw. A leaked agent key can at worst trade inside the mandate.

Revoking the subname is an instant kill switch. No key rotation, no redeploy, one transaction.

## Flow

```mermaid
sequenceDiagram
    autonumber
    participant Ops as Ops (org owner)
    participant Risk as Risk (risk-manager)
    participant Reg as Reg (org Permissioned Registry)
    participant Res as Res (Permissioned Resolver)
    participant Agent as Agent
    participant Vault as Vault (org LeashVault)
    participant PM as PM (Uniswap v4 PoolManager)
    participant Hook as Hook (Leash Hook)

    Note over Ops,Res: Setup
    Ops->>Reg: register subname trader-1 (expiry)
    Ops->>Res: write records (addr, leash.quote, leash.dailyNotional, leash.tokens, leash.maxSlippageBps)
    Ops->>Res: grantSetterRoles(scoped ROLE_SET_TEXT, Risk)

    Note over Agent,Hook: Swap path
    Agent->>Agent: sign SwapIntent (name, pool, direction, amount, nonce, deadline)
    Agent->>Vault: swap(key, params, hookData = label + intent + signature)
    Vault->>Vault: pool uses the Leash hook, caller signed the intent
    Vault->>PM: swap through PoolSwapTest, paid from the vault
    PM->>Hook: beforeSwap(sender, key, params, hookData)
    Hook->>Reg: getExpiry / getResolver
    Hook->>Res: resolve(addr, leash.*)
    Hook->>Hook: recover signer == addr, check nonce, deadline, tokens allowed
    alt checks pass
        PM->>PM: execute swap
        PM->>Hook: afterSwap(delta)
        Hook->>Hook: accrue |quote delta| against (node, day)
        alt under cap
            Hook-->>PM: proceed
        else over cap
            Hook-->>PM: revert DailyCapExceeded
        end
    else checks fail
        Hook-->>PM: revert
    end

    opt Tighten the leash
        Risk->>Res: setText(leash.dailyNotional, lower)
        Risk->>Reg: unregister
        Reg-->>Risk: revert EACUnauthorizedAccountRoles
    end

    opt Cut the leash
        Ops->>Reg: unregister(trader-1)
        Agent->>Vault: next swap
        Vault->>PM: swap
        PM->>Hook: beforeSwap
        Hook-->>PM: revert LeashRevoked
    end
```

## Run it

Needs [foundry](https://getfoundry.sh), [bun](https://bun.sh) and [Claude Code](https://claude.com/claude-code) (`claude` on the PATH). Copy `.env.example` to `.env`, set `SEPOLIA_RPC_URL` and three fresh keys from `cast wallet new` (`OWNER_PK`, `RISK_MANAGER_PK`, `AGENT_PK`).

```bash
git submodule update --init --recursive
forge build && forge test
(cd agent && bun install) && (cd dashboard && bun install)
```

### Demo in four terminals

```bash
script/demo.sh anvil            # 1. anvil fork of Sepolia (real ENSv2 and Uniswap v4 contracts)
script/demo.sh setup            # 2. one shot, about a minute: registers leash.eth, deploys the org registry,
                                #    resolver, hook, pool and org vault, issues trader-1.leash.eth with its policy
script/demo.sh dashboard        # 3. http://localhost:5173/app?label=trader-1 (setup already synced the record)
script/demo.sh agent            # 4. Claude Code as trader-1, with only the leash_policy and leash_swap tools
```

Then, side by side:

1. In the agent terminal: `buy 25 lUSD of lETH`. The dashboard's activity feed shows the signed intent and the swap, the leash bar moves to 10 percent.
2. Agent terminal: `buy 300 lUSD of lETH`. The agent tries, the hook answers `DailyCapExceeded`, nothing moves.
   Optional: dashboard, owner card, set max slippage to 5 bps. `buy 100 lUSD of lETH` is partially filled at the price limit, asking for 0.5% slippage reverts `SlippageTooLoose`.
3. Dashboard, risk-manager card: set the cap to 10 and click **tighten the leash**. Click **try to revoke**: every attempt reverts with `EACUnauthorizedAccountRoles`.
4. Dashboard, owner card: **cut the leash**. Status flips to REVOKED. Ask the agent to trade again: `LeashRevoked`.
5. Dashboard, **+ New agent** tab: issue `trader-2` with its own cap, slippage and expiry. Two owner transactions, no new contract. Every name the org issued gets its own tab, read from the registry's `LabelRegistered` events; a cut one stays greyed at the end, with **Re-issue**. Agent terminal: `buy 20 lUSD of lETH as trader-2`, and the hook enforces the new mandate. All agents trade from the one org vault shown above the tabs (**Fund vault** mints more test tokens into it).

The same acts run against the live Sepolia deployment: prefix any command with `LEASH_NETWORK=sepolia` (for instance `LEASH_NETWORK=sepolia script/demo.sh agent`), and start the dashboard with `LEASH_NETWORK=sepolia script/demo.sh dashboard` to keep the owner and risk-manager controls. `LEASH_NETWORK=sepolia script/demo.sh deploy` is the one shot live deployment.

Step by step script with expected output: [docs/demo.md](docs/demo.md). Reset between runs: restart `script/demo.sh anvil`, run `setup` again (it also clears the dashboard feed), reload the dashboard.

## Why ENSv2 is the product, not decoration

| Primitive | Role in Leash |
|---|---|
| Permissioned Registry | The org's own namespace, issuing and revoking agent identities |
| Subname expiry | Time-boxed mandates that lapse on their own |
| Permissioned Resolver | Where the risk policy actually lives, readable onchain by the hook |
| Enhanced Access Control | Per record key delegation: the risk desk edits `leash.dailyNotional`, never the name |

Strip ENS out and the design collapses into a bespoke allowlist contract. That is the test it passes.

## Trust model

* The hook trusts the org registry address and the parent name it was deployed with.
* It trusts the resolver that registry points to, nothing else.
* It trusts the `addr` record of the name as the agent's identity.
* It trusts EIP-712 signatures over a `SwapIntent`, with a nonce per name.
* It trusts the daily cap as measured in quote token units, from the real settlement delta in `afterSwap`.

The vault trusts the hook it was deployed with, and the router it swaps through. Its owner is the only one who can move funds out.

One resolver per org means a risk-manager's cap change applies to every agent name that resolver serves, not just one.

## Vocabulary

* **leash**: the subname issued to an agent
* **leash length**: the policy records bounding it
* **cut the leash**: revoke the subname, killing the agent mid-flight
