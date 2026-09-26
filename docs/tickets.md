# Leash: ETHGlobal Tokyo 2026 tickets

Target: a working demo on **Sepolia only**, submitted to the ENS ("Best Use of ENSv2") and Uniswap Foundation ("Best Uniswap Stack Contribution") tracks. Hackathon runs 25 to 27 September 2026.

Priorities: **P0** = no demo without it, **P1** = makes the submission credible. Nothing beyond that is in scope.

## Decisions locked

| Topic                | Decision                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain                | Sepolia (11155111). ENSv2 beta and Uniswap v4 both live there.                                                                                                                                                               |
| Agent authentication | **EIP-712 signed swap intent** carried in `hookData`. The hook recovers the signer and compares it to the `addr` record of the agent's ENS name. Works with any v4 router (PoolSwapTest, Universal Router). No Leash router. |
| Notional             | Counted in `afterSwap` from the real `BalanceDelta` of the quote token. No price oracle.                                                                                                                                     |
| Policy encoding      | Human readable text records, parsed onchain by a small library. Agent address lives in the native `addr` record, not a text record.                                                                                          |
| Slippage check       | Out of scope. The daily cap and revocation carry the demo.                                                                                                                                                                   |
| ENSv2 dependency     | Vendored minimal interfaces under `src/interfaces/ens/`. Tests run against a Sepolia fork, not against the ENS monorepo.                                                                                                     |

### Policy records on `trader-1.leash.eth`

| Record                | Kind           | Example                 | Read by hook as                                           |
| --------------------- | -------------- | ----------------------- | --------------------------------------------------------- |
| `addr`                | address record | `0xAgent…`              | the only address allowed to sign intents                  |
| `leash.quote`         | text           | `0xQuote…`              | token the daily cap is denominated in                     |
| `leash.dailyNotional` | text           | `250000000000000000000` | cap per UTC day, raw units of quote token                 |
| `leash.tokens`        | text           | `0xA…,0xB…`             | comma separated allowlist, both pool tokens must be in it |

### `SwapIntent` (EIP-712)

```solidity
struct SwapIntent {
    bytes32 node;            // namehash("trader-1.leash.eth")
    bytes32 poolId;          // PoolId.unwrap(key.toId())
    bool zeroForOne;
    int256 amountSpecified;
    uint256 nonce;           // per node, strictly increasing
    uint256 deadline;        // unix seconds
}
```

Domain: `name = "Leash"`, `version = "1"`, `chainId = 11155111`, `verifyingContract = LeashHook`.

`hookData = abi.encode(string label, SwapIntent intent, bytes signature)`.

---

## Epic 0: Repo and environment

### L-00 Align README and architecture.md with locked decisions (P0, 1h30)

Docs only, can be done before 25 September. The README flow chart and `docs/architecture.md` still describe the trusted-router variant.

- README sequence diagram: `hookData` carries `label + signed SwapIntent + signature`, not the bare node.
- README sequence diagram: replace `verify sender == agent` with `recover signer, compare to addr(node)`.
- README sequence diagram: split the hook call into `beforeSwap` (expiry, resolver, signature, nonce, deadline, tokens) and `afterSwap` (quote delta, daily counter, `DailyCapExceeded`).
- README sequence diagram: step "check owner and expiry" becomes "check expiry, get resolver". Remove slippage from records and checks.
- README "The idea" point 5: "receives the ENS node in hookData, checks the caller really is the agent" becomes "receives a signed swap intent, checks the signature against the name's `addr` record".
- `docs/architecture.md`: records table matches the one in this file (agent in `addr`, no `leash.maxSlippageBps`). Drop the policy cache option. Mark "Who is `sender`?" and "Notional pricing" as resolved with the EIP-712 and `afterSwap` answers. Keep "Griefing" and "Multi-pool accounting" as is.

Acceptance:

- [x] Every step of the README diagram maps to a check in L-10 or L-11
- [x] No mention of `sender == agent`, slippage or policy cache remains in README or architecture.md

### L-01 Dependencies and layout (P0, 2h)

- Add submodules: `uniswap/v4-core`, `uniswap/v4-periphery`, `foundry-rs/forge-std`, `vectorized/solady`, `openzeppelin-contracts` (for `ECDSA`, `EIP712`).
- Write `remappings.txt`. Keep `solc = 0.8.26`, `evm_version = cancun`, `via_ir = true` (v4 needs it).
- Vendor minimal ENSv2 interfaces into `src/interfaces/ens/`: `IPermissionedRegistry` (`getExpiry`, `getOwner`, `getResolver`, `register`, `unregister`, `grantRoles`, `hasRoles`), `IPermissionedResolver` (`text`, `setText`, `addr`, `setAddr`, `initialize`, `grantRoles`), `IVerifiableFactory` (`deployProxy`).
- Copy role constants: `RegistryRolesLib`, `PermissionedResolverLib` (`ROLE_SET_TEXT`, `ROLE_SET_ADDR`, `resource(node, part)`, `partHash`).
- GitHub Action: `forge build`, `forge fmt --check`, `forge test` (fork tests gated on `SEPOLIA_RPC_URL` secret).

Acceptance:

- [x] `forge build` passes with an empty `src/LeashHook.sol` stub
- [ ] CI green on main

### L-02 Sepolia address book (P0, 1h)

- `script/Addresses.sol` with constants for: PoolManager, PoolSwapTest, PoolModifyLiquidityTest, StateView, ENS RootRegistry, ETHRegistry, ETHRegistrar, VerifiableFactory, UserRegistryImpl, PermissionedResolverImpl, MockUSDC.
- Source: ENS docs "Deployments" page and Uniswap v4 deployments page, **re-checked on 25 September**. ENSv2 Sepolia gets redeployed (29 June and 15 September 2026 are both known); addresses in the ENS repo and on docs.ens.domains already diverge.
- Add `script/CheckAddresses.s.sol` that reverts if any address has no code.

Acceptance:

- [x] `forge script script/CheckAddresses.s.sol --rpc-url $SEPOLIA_RPC_URL` passes
- [x] Address book header records the date and source URL

---

## Epic 1: ENS namespace on Sepolia

### L-03 Register `leash.eth` (P0, 2h)

- Mint MockUSDC (its `mint` has no access control), approve `ETHRegistrar`.
- Commit then reveal via `ETHRegistrar.register(label, owner, secret, subregistry, resolver, duration, paymentToken, referrer)`. Pass `subregistry = address(0)` for now, it is set in L-04.
- Script: `script/ens/RegisterParent.s.sol`. Owner is the org multisig or a dedicated "owner" key.
- Pick a label unlikely to be taken. The live deployment uses `leash`.

Acceptance:

- [ ] Name visible in the ENS Sepolia explorer with the owner key as owner
- [ ] Token id and namehash written to `.env` / `deployments/sepolia.json`

### L-04 Deploy the org registry (P0, 3h)

- Preferred path: `VerifiableFactory.deployProxy(UserRegistryImpl, salt, initialize(owner, rootRoles))`. Root roles for owner: `ROLE_REGISTRAR | ROLE_UNREGISTER | ROLE_RENEW | ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY` plus their `_ADMIN` bits.
- Then `ETHRegistry.setSubregistry(parentTokenId, orgRegistry)` from the owner key.
- Fallback if the factory path fights back: deploy `PermissionedRegistry(labelStore, owner, rootRoles)` directly from vendored source. Same interface for the hook.
- Script: `script/ens/DeployOrgRegistry.s.sol`.

Acceptance:

- [x] `ETHRegistry.getSubregistry("leash") == orgRegistry`
- [x] `orgRegistry.hasRootRoles(ROLE_REGISTRAR, owner) == true`

### L-05 Deploy the org PermissionedResolver (P0, 2h)

> Superseded on 26 September 2026: every agent now gets its own PermissionedResolver, deployed by `IssueAgent` with its records written in `initialize` (L-06), and `DeployOrgResolver.s.sol` is gone. `MigrateAgentResolver.s.sol` moved the live agents off the shared resolver. See `docs/architecture.md`, section 2.

- `VerifiableFactory.deployProxy(PermissionedResolverImpl, salt, initialize(owner, roles, setters = []))`.
- Owner receives `ROLE_SET_TEXT | ROLE_SET_ADDR` and their admin bits on the root resource so it can write every record and delegate.
- Script: `script/ens/DeployOrgResolver.s.sol`.

Acceptance:

- [x] `resolver.hasRootRoles(ROLE_SET_TEXT_ADMIN, owner) == true`

### L-06 Issue the agent subname and write its policy (P0, 2h)

- `orgRegistry.register("trader-1", agentNameOwner, IRegistry(0), orgResolver, tokenRoles, expiry)`. `agentNameOwner` is the org owner, **not** the agent key. Expiry configurable (default now + 7 days).
- Records on `node = namehash("trader-1.leash.eth")`: `setAddr(node, agent)`, `setText(node, "leash.quote", …)`, `setText(node, "leash.dailyNotional", …)`, `setText(node, "leash.tokens", …)`. Use `multicall`.
- Script: `script/ens/IssueAgent.s.sol` parameterised by label, agent address, expiry, cap.

Acceptance:

- [x] `orgRegistry.getExpiry(labelhash) > block.timestamp`
- [x] `orgResolver.addr(node) == agent`
- [ ] Records visible in the ENS Sepolia explorer

### L-07 Scoped risk-manager role (P0, 2h)

- Grant `ROLE_SET_TEXT` on `resource(node, keccak("leash.dailyNotional"))` and `resource(node, keccak("leash.tokens"))` to the risk-manager key. Nothing on the registry.
- Script: `script/ens/GrantRiskManager.s.sol`.
- Fork test proving: risk-manager can `setText(node, "leash.dailyNotional", …)`, cannot `setText(node, "leash.quote", …)`, cannot `setAddr`, cannot `orgRegistry.unregister(labelhash)`.

Acceptance:

- [x] Four assertions above pass in `test/fork/EnsSetup.t.sol`

---

## Epic 2: Contracts

### L-08 `LeashPolicyLib` (P0, 3h)

- `parseUint(string) -> uint256` (decimal), `parseAddress(string) -> address` (0x hex, 40 nibbles), `parseAddressList(string) -> address[]` (comma separated, no spaces), `contains(address[], address) -> bool`.
- Revert with `InvalidRecord(string key)` on malformed input. Empty `leash.tokens` means "deny all", not "allow all".
- Solady `LibString` may cover part of this; check before writing.

Acceptance:

- [x] Unit tests for each parser, including fuzz round trip `parseUint(toString(x)) == x`
- [x] Malformed inputs revert

### L-09 `LeashIntent` EIP-712 library and hookData codec (P0, 3h)

- `SWAP_INTENT_TYPEHASH`, `hashIntent(SwapIntent)`, `digest(domainSeparator, intent)`.
- `decodeHookData(bytes) -> (string label, SwapIntent, bytes sig)`.
- Recover with OpenZeppelin `ECDSA.recover` (rejects malleable signatures).
- Export the typed data JSON shape in `docs/eip712.md` so the TypeScript agent matches byte for byte.

Acceptance:

- [x] Test: a digest computed with `vm.sign` in Foundry equals one produced by viem `signTypedData` for the same fixture (store the viem fixture in `test/fixtures/intent.json`)

### L-10 `LeashHook.beforeSwap` (P0, 5h)

Constructor: `poolManager`, `orgRegistry`, `parentNode` (namehash of `leash.eth`). Flags: `BEFORE_SWAP | AFTER_SWAP`.

Checks, in order, each with its own custom error:

1. Decode hookData, compute `labelhash = keccak(label)`, `node = keccak(parentNode, labelhash)`. Require `intent.node == node` (`NodeMismatch`).
2. `orgRegistry.getExpiry(labelhash) > block.timestamp` (`LeashRevoked`). Covers both `unregister` and natural expiry.
3. `resolver = orgRegistry.getResolver(label)`, require non zero (`NoResolver`).
4. `agent = resolver.addr(node)`, require non zero (`NoAgent`).
5. `intent.deadline >= block.timestamp` (`IntentExpired`).
6. `intent.nonce == nonces[node]`, then `nonces[node]++` (`BadNonce`).
7. `intent.poolId == key.toId()`, `intent.zeroForOne == params.zeroForOne`, `intent.amountSpecified == params.amountSpecified` (`IntentMismatch`).
8. `ECDSA.recover(digest, sig) == agent` (`BadSignature`).
9. Read `leash.tokens`, require `currency0` and `currency1` both allowed (`TokenNotAllowed`).
10. Stash `(node, quote, cap)` in transient storage for `afterSwap`.

Acceptance:

- [x] Every error path has a test
- [x] Gas of a passing `beforeSwap` recorded in `.gas-snapshot` (informational only)

### L-11 `LeashHook.afterSwap` daily accounting (P0, 3h)

- Read `(node, quote, cap)` from transient storage.
- `notional = abs(delta.amount0() or amount1())` for whichever currency equals `quote`. Revert `QuoteNotInPool` if neither.
- `day = block.timestamp / 1 days`, `spent[node][day] += notional`, revert `DailyCapExceeded(node, spent, cap)` if over.
- Views: `spentToday(bytes32 node)`, `remainingToday(bytes32 node)` for the dashboard.
- Event `LeashSwap(node, agent, poolId, notional, spentToday)`.

Acceptance:

- [x] Two swaps under cap pass, third that crosses the cap reverts
- [x] Counter resets after `vm.warp` to next UTC day

### L-12 Hook deployment on Sepolia (P0, 2h)

- `script/DeployHook.s.sol` using `HookMiner.find` from v4-periphery with the CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`.
- Verify on Etherscan.
- Record address in `deployments/sepolia.json`.

Acceptance:

- [x] `LeashHook.getHookPermissions()` matches the mined address flags
- [ ] Verified source on Sepolia Etherscan

### L-13 Test tokens, pool and liquidity (P0, 2h)

- Two `MockERC20` (18 decimals) with open `mint`. One of them is the quote token.
- `PoolManager.initialize(key with hooks = LeashHook, fee 3000, tickSpacing 60)` at price 1:1.
- Add liquidity via `PoolModifyLiquidityTest` over a wide range.
- Mint balances to the agent key and approve `PoolSwapTest`.
- Script: `script/SetupPool.s.sol`.

Acceptance:

- [x] `StateView.getSlot0(poolId)` returns non zero liquidity
- [ ] Pool id written to `deployments/sepolia.json`

---

## Epic 3: Tests

### L-14 Sepolia fork scenario suite (P0, 4h)

`test/fork/Leash.t.sol` with `vm.createSelectFork(SEPOLIA_RPC_URL)` against the real ENSv2 contracts and real PoolManager. Deploys hook, tokens and pool inside `setUp`, and follows the repo test conventions (`vm.label` on every address, tests grouped per function).

Scenarios:

- `test_Swap_WithinCap`
- `test_RevertWhen_Swap_DailyCapExceeded`
- `test_RevertWhen_Swap_BadSignature` (signed by a random key)
- `test_RevertWhen_Swap_ReplayedNonce`
- `test_RevertWhen_Swap_IntentMismatch` (signed amount differs from swapped amount)
- `test_RevertWhen_Swap_TokenNotAllowed`
- `test_RevertWhen_Swap_LeashRevoked` (owner calls `unregister`)
- `test_RevertWhen_Swap_Expired` (`vm.warp` past expiry)
- `test_Swap_AfterRiskManagerTightensCap` (cap lowered, next swap reverts)
- `test_RevertWhen_RiskManager_Unregister`

Acceptance:

- [x] All green against a Sepolia fork
- [ ] Runs in CI when the RPC secret is present, skipped otherwise

### L-15 Local unit tests with mocks (P1, 2h)

- `MockRegistry` and `MockResolver` implementing only the vendored interfaces, so `forge test --no-match-path 'test/fork/*'` runs offline in seconds.

Acceptance:

- [x] `forge test` without RPC passes

---

## Epic 4: Agent, demo and deliverables

### L-16 TypeScript agent bot (P1, 4h)

- `agent/` package (bun + viem). Loop: read policy and `remainingToday` from chain, pick an amount, build `SwapIntent`, `signTypedData` with the agent key, call `PoolSwapTest.swap(key, params, testSettings, hookData)`.
- Logs each attempt with the decoded revert reason so the demo shows `LeashRevoked` or `DailyCapExceeded` in the terminal.
- Configurable "misbehave" flag that makes the bot request more than the cap.

Acceptance:

- [ ] One successful swap and one `DailyCapExceeded` revert reproduced from the CLI on Sepolia

### L-17 Demo action scripts (P0, 2h)

- `script/demo/TightenCap.s.sol` (risk-manager key, `setText` on `leash.dailyNotional`)
- `script/demo/RiskManagerTriesRevoke.s.sol` (expected to revert with `EACUnauthorizedAccountRoles`)
- `script/demo/CutLeash.s.sol` (owner key, `orgRegistry.unregister(labelhash)`)
- `script/demo/IssueShortLived.s.sol` (subname with 3 minute expiry, for the natural expiry beat)
- `docs/demo.md`: the five act script with exact commands and expected outputs.

Acceptance:

- [ ] Each script run once on Sepolia, tx hashes pasted into `docs/demo.md`

### L-18 Read only dashboard (P1, 4h)

- Vite + React + viem, deployed on Vercel. No wallet needed.
- Shows for a given label: owner, expiry countdown, agent `addr`, quote, cap, spent today, remaining, allowed tokens, last 10 `LeashSwap` events, revoked status.
- Polls every 5 seconds so revocation is visible live during the demo.

Acceptance:

- [ ] Public URL working for `trader-1.leash.eth`
- [x] Revocation reflected within 10 seconds of the tx (verified on the anvil fork: one 5 s poll)

### L-19 Submission deliverables (P0, 3h)

- README: keep the pitch, add "Deployed on Sepolia" table (hook, registry, resolver, pool, names), and a "Where to look" section pointing to `src/LeashHook.sol` line ranges for `beforeSwap` and `afterSwap` (Uniswap track requirement).
- `FEEDBACK.md` on the v4 developer experience (hookData ergonomics, HookMiner, testnet routers, docs gaps). Submit the Uniswap Developer Feedback Form.
- 3 minute video following `docs/demo.md`.
- ETHGlobal submission: repo, video, dashboard URL, both tracks selected.

Acceptance:

- [ ] Feedback form confirmation saved
- [ ] Submission confirmed before the Tokyo deadline
