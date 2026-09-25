# Architecture notes

Working notes, not a spec. Expect churn.

## Components

### 1. Permissioned Registry (ENSv2)

Deployed and owned by the organisation. Holds `acme.eth` and issues subnames.

Responsibilities:

- Issue `trader-N.acme.eth` with an owner and an expiry.
- Revoke a subname immediately, on owner authority only.
- Expose ownership and expiry to the hook in a single view call.

### 2. Permissioned Resolver

Stores the agent's identity and policy on `trader-N.acme.eth`.

Records:

| Key                    | Type | Meaning                                                      |
| ---------------------- | ---- | ------------------------------------------------------------- |
| `addr`                 | address record | the EOA or smart account allowed to swap under this name |
| `leash.quote`          | text | address, the token the cap is denominated in                  |
| `leash.dailyNotional`  | text | uint256 decimal string, cap per UTC day, raw units of quote   |
| `leash.tokens`         | text | comma separated addresses, tokens the agent may trade         |

Encoding: human readable strings, parsed onchain by `LeashPolicyLib`. The hook pays for parsing on every swap; the library fails closed, reverting on any malformed value rather than under-enforcing. No policy cache: the hook always reads the resolver directly, so there is no staleness window.

The deployed resolver stores records by DNS-encoded name, not by node, and is read through the ENSIP-10 `resolve(name, data)` entry point. See [`docs/ens-v2-sepolia-api.md`](./ens-v2-sepolia-api.md) for the exact read path.

### 3. Enhanced Access Control

Two roles, scoped through the resolver's EAC:

- `risk-manager`: granted with `grantSetterRoles(setText(name, "leash.dailyNotional", ""), riskManager)`, repeated for `leash.tokens`. The resolver decodes that calldata, derives `resource = keccak256(bytes(key))`, and grants `ROLE_SET_TEXT` scoped to that resource, for the whole resolver, not one name. The risk-manager cannot touch `addr`, any other key, or the registry.
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
10. Stash `(node, quote, cap)` in transient storage for `afterSwap`.

`afterSwap` accounting:

- Read `(node, quote, cap)` from transient storage.
- `notional = abs(delta)` for whichever currency equals `quote`; revert `QuoteNotInPool` if neither.
- `day = block.timestamp / 1 days`, `spent[node][day] += notional`, revert `DailyCapExceeded(node, spent, cap)` if it crosses the cap.
- Emit `LeashSwap(node, agent, poolId, notional, spentToday)`.

The daily counter lives in the hook, keyed by `(node, day)`.

## Open questions

- **Who is `sender`?** Resolved. The hook ignores `sender` entirely: the agent signs an EIP-712 `SwapIntent`, and the hook recovers the signer and compares it to the name's `addr` record. Works with any v4 router.
- **Notional pricing.** Resolved. `afterSwap` reads the real `BalanceDelta` of the quote token and caps on that raw delta, in quote token units. No price oracle, no spot-price manipulation surface.
- **Griefing.** A revoked agent with a pending transaction reverts, which is the intended behaviour, but the gas is burned. Acceptable.
- **Multi-pool accounting.** One counter per agent across all pools, or per pool. Per agent is the useful one: the hook is a single contract per org, and the counter is keyed by `node`, so it spans every pool that uses the hook.

## Sepolia deployment notes

See [`docs/ens-v2-sepolia-api.md`](./ens-v2-sepolia-api.md) for deployed addresses and the real ABI this deployment exposes (it diverges from the `contracts-v2` `main` branch).
