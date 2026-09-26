# Developer feedback: ENSv2 and Uniswap v4

Written while building Leash (ETHGlobal Tokyo 2026): each AI agent is an ENSv2 subname of its organisation, its trading policy lives in text records on the org resolver, and a Uniswap v4 `beforeSwap` + `afterSwap` hook reads those records on every swap. The hook authenticates the swapper with an EIP-712 intent carried in `hookData` and enforces a daily cap from the real settlement delta. Deployed on Sepolia against the ENSv2 beta and the Sepolia PoolManager, tested on a Sepolia fork and locally.

- [ENSv2](#ensv2)
- [Uniswap v4](#uniswap-v4)

## ENSv2

The building blocks are exactly the right ones: they are what makes Leash possible. The friction comes from the beta being young: documentation behind the deployed code, and addresses that change.

### What worked well

- **Per record permissions on the resolver.** Enhanced Access Control lets the risk manager write `leash.dailyNotional` and `leash.tokens` and nothing else: not `addr`, not other keys, not the registry. This is the feature the project is built on, and no other naming system offers it.
- **Native subname expiry.** A time boxed mandate costs zero lines of code: the hook requires `getExpiry(labelhash) > block.timestamp`. And `unregister` sets the expiry to now, which gives the owner an instant kill switch in one transaction.
- **One registry per org.** `VerifiableFactory.deployProxy` gives each organisation its own namespace running the official `UserRegistryImpl` code, at a deterministic CREATE2 address.
- **Records readable on chain.** The hook reads the policy straight from the resolver at swap time, with no oracle, no server and no cache: a new cap or a revocation applies from the next block.
- **Names are ERC1155 tokens held by the org.** The agent only appears in the `addr` record, so it can trade under its name but can neither renew nor transfer it.

### What slowed us down

1. **Deployed code does not match `contracts-v2/main`.** The Sepolia `PermissionedResolver` differs from the one on the main branch (records keyed by DNS-encoded name, different role API). We had to check every API against the on-chain bytecode and the Sourcify exact-match sources, and write our interfaces by hand (`src/interfaces/ens`, `docs/ens-v2-sepolia-api.md`).
2. **Sepolia redeployed several times.** Three address sets in 2026 (29 June, 15 September, then the current one). We wrote `script/CheckAddresses.s.sol` to run before anything else on deployment day, checking `ETHRegistrar.ETH_REGISTRY()`, `RootRegistry.getSubregistry("eth")` and the shared `LabelStore`.
3. **`grantRoles` is disabled on the resolver.** It always reverts. The only way to grant a scoped role is `grantSetterRoles` with an encoded setter calldata, `abi.encodeCall(setText, ("", "leash.dailyNotional", ""))`, which the resolver decodes to derive the resource. Far from obvious without reading the source.
4. **Hard to read authorization errors.** In `EACUnauthorizedAccountRoles(resource, role, account)` raised by `unregister` or `renew`, `resource` is the labelhash with its low 32 bits replaced by the entry's `eacVersionId`. Matching it requires `getState(labelId).resource`, not the bare labelhash.
5. **EIP-7702 delegated accounts cannot receive a name.** Anvil's default accounts are delegated on Sepolia (sweeper bots). `ETHRegistry.register` mints an ERC1155 to the owner, the delegated code does not answer `onERC1155Received`, and the registration reverts with empty data. It took a while to understand; `script/ens/EnsScriptBase.s.sol` now refuses delegated owners up front.
6. **Reads only through `resolve(name, data)`.** A contract that reads records has to encode a `text(bytes32,string)` or `addr(bytes32)` call whose `node` argument is ignored, then decode the result. It works, but it is indirect and undocumented for on-chain consumers.
7. **`VerifiableFactory` reverts on a reused salt with no clear error.** The CREATE2 salt is `keccak256(abi.encode(msg.sender, salt))`, so running a deploy script twice from the same owner reverts.

### Suggestions

- A published ABI versioned per deployment, with a changelog of address changes on the Deployments page.
- An official example of a role scoped to one record key: a `grantSetterRoles` snippet in the docs would have been enough.
- An option to scope a permission per name and per key. Today a right on `leash.dailyNotional` applies to every name served by the resolver; limiting it to one agent would avoid deploying one resolver per agent.
- Explicit errors for an account that cannot receive the name token and for a factory called twice with the same salt.
- A documented on-chain read helper (or a note in the docs) for contracts that consume text records through `resolve`.

### Where to look in this repo

- `src/LeashHook.sol` and `src/libraries/LeashEnsLib.sol`: expiry and resolver lookup on the org registry, then `addr` and `leash.*` records read through `resolve`.
- `src/libraries/EnsNameLib.sol`: DNS encoding of `label.parent.eth` for the resolver.
- `script/ens/`: parent registration (commit / reveal), org registry and resolver through `VerifiableFactory`, agent issuance, `grantSetterRoles` for the risk manager.
- `test/fork/EnsSetup.t.sol`: the full ENS flow against the real Sepolia contracts, including the versioned `EACUnauthorizedAccountRoles` resource.
- `docs/ens-v2-sepolia-api.md`: the API as deployed, role bitmaps, gas measured on the fork.

## Uniswap v4

### What worked well

- **`hookData` is the right extension point.** Passing `abi.encode(label, intent, signature)` through `PoolSwapTest.swap` and reading it in `beforeSwap` needed zero router changes. Any router that forwards `hookData` (PoolSwapTest, Universal Router) works, so the hook does not have to trust `sender` at all.
- **`afterSwap` receives the settled `BalanceDelta`.** Counting notional from the real delta of the quote token removed the need for any price oracle in the risk policy. This deserves a highlighted example in the docs: "how to meter a swap without a price feed".
- **Transient storage between `beforeSwap` and `afterSwap`** (`tstore`/`tload`, cancun) is a clean way to hand over per-swap context. A helper in v4-periphery (or a note in the hook docs) would save every hook author the same ten lines.
- **`HookMiner` + CREATE2 through `forge script`** just worked: `new LeashHook{salt: salt}(...)` in a broadcast is routed through the deterministic deployer, so the mined address matched on the first try.
- **`Deployers` from v4-core tests** made local hook tests fast to set up (fresh PoolManager, routers, two currencies, a pool with liquidity in ten lines).

### What slowed us down

1. **`BaseHook` moved out of v4-periphery.** The periphery README points to `Uniswap/v4-hooks-public`, whose repo drags in fifteen submodules (v3, v2, Pancake, UniswapX, Fluid...). We vendored the single `BaseHook.sol` file instead. A tiny `v4-hooks-base` package, or keeping `BaseHook` in periphery, would help hackathon teams.
2. **`optimizer_runs` trap under via-IR.** Importing `Deployers` (and therefore `PoolManager`) into a test with `optimizer_runs = 800` fails with a Yul stack too deep error. Only v4-core's own value (44444444) or 10000 compile. This is not documented anywhere a hook author looks first; a sentence in the "writing tests" page would save an hour.
3. **Hook reverts are wrapped.** A hook revert surfaces as `CustomRevert.WrappedError(hook, selector, reason, details)`. Fine once known, but decoding it client side (viem) requires the wrapper ABI, which is not in the published docs. We wrote the decoder by hand; an official snippet would be welcome.
4. **`HookMiner` lives under `test/shared`.** Importing test code from a dependency into deployment scripts feels wrong. Moving it to `src/utils` (or publishing it in a scripts package) would be cleaner.
5. **Sepolia testnet routers are undocumented.** `PoolSwapTest` and `PoolModifyLiquidityTest` are listed on the deployments page without any explanation that they are the intended testnet routers for hook developers, nor how their `TestSettings` should be set.

### Suggestions

- A first class "authenticated swap" pattern in the hook docs: signature in `hookData`, nonce per principal, deadline, and the warning that `sender` is the router.
- A canonical `TransientStorage` helper for before/after handoff.
- A `forge init --template v4-hook` that pins v4-core to the version v4-periphery uses (we had to pin `lib/v4-core` manually to the commit periphery's submodule points to).

### Where to look in this repo

- `src/LeashHook.sol`: `_beforeSwap` (identity, intent, allowlist) and `_afterSwap` (quote delta accounting).
- `test/LeashHook.t.sol`: local tests with `Deployers`, byte exact `WrappedError` assertions.
- `test/fork/LeashHook.fork.t.sol`: the same scenarios against the real Sepolia PoolManager and real ENSv2 contracts.
- `script/DeployHook.s.sol`: HookMiner + CREATE2 deployment.
- `agent/src/errors.ts`: viem decoder for wrapped hook reverts.
