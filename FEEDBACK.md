# Uniswap v4 developer feedback

Written while building Leash (ETHGlobal Tokyo 2026): a `beforeSwap` + `afterSwap` hook that authenticates the swapper with an EIP-712 intent carried in `hookData` and enforces a daily cap from the real settlement delta. Deployed against the Sepolia PoolManager, tested on a Sepolia fork and with `Deployers` locally.

## What worked well

- **`hookData` is the right extension point.** Passing `abi.encode(label, intent, signature)` through `PoolSwapTest.swap` and reading it in `beforeSwap` needed zero router changes. Any router that forwards `hookData` (PoolSwapTest, Universal Router) works, so the hook does not have to trust `sender` at all.
- **`afterSwap` receives the settled `BalanceDelta`.** Counting notional from the real delta of the quote token removed the need for any price oracle in the risk policy. This deserves a highlighted example in the docs: "how to meter a swap without a price feed".
- **Transient storage between `beforeSwap` and `afterSwap`** (`tstore`/`tload`, cancun) is a clean way to hand over per-swap context. A helper in v4-periphery (or a note in the hook docs) would save every hook author the same ten lines.
- **`HookMiner` + CREATE2 through `forge script`** just worked: `new LeashHook{salt: salt}(...)` in a broadcast is routed through the deterministic deployer, so the mined address matched on the first try.
- **`Deployers` from v4-core tests** made local hook tests fast to set up (fresh PoolManager, routers, two currencies, a pool with liquidity in ten lines).

## What slowed us down

1. **`BaseHook` moved out of v4-periphery.** The periphery README points to `Uniswap/v4-hooks-public`, whose repo drags in fifteen submodules (v3, v2, Pancake, UniswapX, Fluid...). We vendored the single `BaseHook.sol` file instead. A tiny `v4-hooks-base` package, or keeping `BaseHook` in periphery, would help hackathon teams.
2. **`optimizer_runs` trap under via-IR.** Importing `Deployers` (and therefore `PoolManager`) into a test with `optimizer_runs = 800` fails with a Yul stack too deep error. Only v4-core's own value (44444444) or 10000 compile. This is not documented anywhere a hook author looks first; a sentence in the "writing tests" page would save an hour.
3. **Hook reverts are wrapped.** A hook revert surfaces as `CustomRevert.WrappedError(hook, selector, reason, details)`. Fine once known, but decoding it client side (viem) requires the wrapper ABI, which is not in the published docs. We wrote the decoder by hand; an official snippet would be welcome.
4. **`HookMiner` lives under `test/shared`.** Importing test code from a dependency into deployment scripts feels wrong. Moving it to `src/utils` (or publishing it in a scripts package) would be cleaner.
5. **Sepolia testnet routers are undocumented.** `PoolSwapTest` and `PoolModifyLiquidityTest` are listed on the deployments page without any explanation that they are the intended testnet routers for hook developers, nor how their `TestSettings` should be set.

## Suggestions

- A first class "authenticated swap" pattern in the hook docs: signature in `hookData`, nonce per principal, deadline, and the warning that `sender` is the router.
- A canonical `TransientStorage` helper for before/after handoff.
- A `forge init --template v4-hook` that pins v4-core to the version v4-periphery uses (we had to pin `lib/v4-core` manually to the commit periphery's submodule points to).

## Where to look in this repo

- `src/LeashHook.sol`: `_beforeSwap` (identity, intent, allowlist) and `_afterSwap` (quote delta accounting).
- `test/LeashHook.t.sol`: local tests with `Deployers`, byte exact `WrappedError` assertions.
- `test/fork/LeashHook.fork.t.sol`: the same scenarios against the real Sepolia PoolManager and real ENSv2 contracts.
- `script/DeployHook.s.sol`: HookMiner + CREATE2 deployment.
- `agent/src/errors.ts`: viem decoder for wrapped hook reverts.
