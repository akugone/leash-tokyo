# Architecture notes

Working notes, not a spec. Expect churn.

## Components

### 1. Permissioned Registry (ENSv2)

Deployed and owned by the organisation. Holds `leash.eth` and issues subnames.

Responsibilities:

- Issue `trader-N.leash.eth` with an owner and an expiry.
- Revoke a subname immediately, on owner authority only.
- Expose ownership and expiry to the hook in a single view call.

### 2. Permissioned Resolver

Stores the agent's identity and policy on `trader-N.leash.eth`.

Records:

| Key                    | Type | Meaning                                                      |
| ---------------------- | ---- | ------------------------------------------------------------- |
| `addr`                 | address record | the EOA or smart account allowed to swap under this name |
| `leash.quote`          | text | address, the token the cap is denominated in                  |
| `leash.dailyNotional`  | text | uint256 decimal string, cap per UTC day, raw units of quote   |
| `leash.tokens`         | text | comma separated addresses, tokens the agent may trade         |
| `leash.maxSlippageBps` | text | optional, owner-only, decimal basis points below 10000: maximum price impact of one swap, from the pool price at execution. Empty: not enforced |

Encoding: human readable strings, parsed onchain by `LeashPolicyLib`. The hook pays for parsing on every swap; the library fails closed, reverting on any malformed value rather than under-enforcing. No policy cache: the hook always reads the resolver directly, so there is no staleness window.

The deployed resolver stores records by DNS-encoded name, not by node, and is read through the ENSIP-10 `resolve(name, data)` entry point. See [`docs/ens-v2-sepolia-api.md`](./ens-v2-sepolia-api.md) for the exact read path.

### 3. Enhanced Access Control

Two roles, scoped through the resolver's EAC:

- `risk-manager`: granted with `grantSetterRoles(setText(name, "leash.dailyNotional", ""), riskManager)`, repeated for `leash.tokens`. `leash.quote` and `leash.maxSlippageBps` stay owner-only: an empty slippage record switches the bound off, so only the owner may write it. The resolver decodes that calldata, derives `resource = keccak256(bytes(key))`, and grants `ROLE_SET_TEXT` scoped to that resource, for the whole resolver, not one name. The risk-manager cannot touch `addr`, any other key, or the registry.
- `owner`: keeps the registry roles (`register`, `unregister`, `renew`, `setResolver`, `setSubregistry`) and the resolver's root roles. The owner can `revokeRoles` on the risk-manager at any time.

This split is the point. A risk desk should be able to tighten an agent's limits at 3am without holding the authority to mint or revoke agents.

### 4. Leash Hook (Uniswap v4)

Flags: `beforeSwap | afterSwap`.

`hookData` layout: `abi.encode(string label, SwapIntent intent, bytes signature)`.

`beforeSwap` checks, in order, each with its own error:

1. Decode `hookData`, compute `labelhash = keccak(label)` and `node = keccak(parentNode, labelhash)`. Require `intent.node == node` (`NodeMismatch`).
2. `orgRegistry.getExpiry(labelhash) > block.timestamp` (`LeashRevoked`), covering both `unregister` and natural expiry.
3. `resolver = orgRegistry.getResolver(label)`, non zero (`NoResolver`).
4. `agent = resolver.addr(node)`, non zero (`NoAgent`).
5. `intent.deadline >= block.timestamp` (`IntentExpired`).
6. `intent.nonce == nonces[node]`, then increment (`BadNonce`). Nonces are per node, strictly increasing.
7. `intent.poolId`, `zeroForOne` and `amountSpecified` match the actual swap call (`IntentMismatch`).
8. `ECDSA.recover(digest, sig) == agent` (`BadSignature`).
9. Both `currency0` and `currency1` are in `leash.tokens` (`TokenNotAllowed`).
10. If `leash.maxSlippageBps` is set, the swap's `sqrtPriceLimitX96` is no wider than `priceLimit(poolId, zeroForOne, bps)`, the pool price moved by `bps` (`SlippageTooLoose`). The check binds whoever submits the swap, not only the agent: the price limit is not part of the signed intent, so the hook enforces it on the swap params. A limit inside the bound stops the swap there (partial fill of an exact input), and `afterSwap` counts only what moved.
    What it bounds: the price impact of this swap, measured from the price at execution. What it does not: a price already moved before the swap (a sandwich front-run), since no reference price is signed. Binding that would need a signed minimum output or reference price in `SwapIntent`. The agent requests 90% of the bound by default, so a price move between its read and the swap does not trip the check.
11. Stash `(node, quote, cap)` in transient storage for `afterSwap`.

`afterSwap` accounting:

- Read `(node, quote, cap)` from transient storage.
- `notional = abs(delta)` for whichever currency equals `quote`; revert `QuoteNotInPool` if neither.
- `day = block.timestamp / 1 days`, `spent[node][day] += notional`, revert `DailyCapExceeded(node, spent, cap)` if it crosses the cap.
- Emit `LeashSwap(node, agent, poolId, notional, spentToday)`.

The daily counter lives in the hook, keyed by `(node, day)`.

### 5. Org vault

`LeashVault` holds the org's tokens so the agent holds none: its key only signs intents and pays gas. Without it the agent's own balance could leave through a plain transfer or a pool without the hook, and the leash would only hold on Leash pools.

`swap(key, params, hookData)`:

1. `key.hooks` is the Leash hook the vault was deployed with (`NotLeashPool`), so every trade goes through the checks above.
2. The signer of the intent in `hookData`, recovered with `hook.hashIntent`, is `msg.sender` (`NotSigner`). Without it anyone could replay an agent's pending intent against the vault's funds with a price limit of their choice. The hook then checks that signer against the `addr` record, so the caller is the agent.
3. Swap through `PoolSwapTest`, which pulls the input from its caller and pays the output back to it: the vault settles nothing itself. Hook reverts bubble up unchanged.

`trySwap(key, params, hookData)` runs the same two checks, then records a refusal instead of reverting: when the hook or the pool refuses, the call succeeds, nothing moves, and `SwapRefused(agent, node, amountSpecified, reason)` carries the raw revert data (the PoolManager's `WrappedError` around the hook's error, e.g. `DailyCapExceeded`). The refused swap reverts inside the router call, so the nonce and the daily counter are untouched. The caller pays the gas, so every attempt beyond the mandate is public and costs the agent, never the org. It reverts `EmptyRefusal` when the inner call ran out of gas (63/64 rule) or carries no reason, even wrapped: otherwise a caller could forge refusals by starving the hook of gas.

`withdraw(token, to, amount)` is owner only. The hook is unchanged: it ignores `sender`, the vault is just another caller of the router. ERC20 pools only.

A leaked agent key can at worst trade inside the mandate, with the org's funds, until the owner cuts the leash.

## Open questions

- **Who is `sender`?** Resolved. The hook ignores `sender` entirely: the agent signs an EIP-712 `SwapIntent`, and the hook recovers the signer and compares it to the name's `addr` record. Works with any v4 router.
- **Notional pricing.** Resolved. `afterSwap` reads the real `BalanceDelta` of the quote token and caps on that raw delta, in quote token units. No price oracle, no spot-price manipulation surface.
- **Griefing.** A revoked agent with a pending transaction reverts, which is the intended behaviour, but the gas is burned. Acceptable.
- **Multi-pool accounting.** One counter per agent across all pools, or per pool. Per agent is the useful one: the hook is a single contract per org, and the counter is keyed by `node`, so it spans every pool that uses the hook.

## Sepolia deployment notes

See [`docs/ens-v2-sepolia-api.md`](./ens-v2-sepolia-api.md) for deployed addresses and the real ABI this deployment exposes (it diverges from the `contracts-v2` `main` branch).
