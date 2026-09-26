# Deployment records

One JSON file per environment, written incrementally by the Forge scripts through `script/Deployments.sol` and read by the TypeScript agent and the dashboard.

- `sepolia.json`: the real Sepolia deployment (committed once deployed).
- `anvil.json`: local fork of Sepolia used for the demo rehearsal (git ignored).

Every value is a JSON string. Keys:

| Key | Meaning |
| --- | --- |
| `chainId` | `11155111` for Sepolia and for an anvil fork of Sepolia |
| `parentLabel`, `parentName`, `parentNode` | the org `.eth` name, e.g. `leash`, `leash.eth`, its namehash |
| `parentTokenId` | ERC1155 token id of the parent name in `ETHRegistry`, written by `RegisterParent.reveal()` |
| `orgOwner`, `riskManager`, `agent` | the three demo addresses |
| `agentLabel` | subname label, e.g. `trader-1` |
| `orgRegistry` | the org `UserRegistry` proxy deployed through `VerifiableFactory` |
| `orgRegistryBlock` | block the org registry was deployed at, where the dashboard starts scanning `LabelRegistered` to list agents |
| `orgResolver` | the org `PermissionedResolver` proxy |
| `hook` | the `LeashHook` |
| `token0`, `token1`, `quote` | pool currencies, `quote` is one of the two |
| `fee`, `tickSpacing` | pool key parameters |
| `poolId` | `PoolId` of the demo pool |
| `vault` | the org `LeashVault`, which holds the demo tokens the agent trades |
| `vaultPrevious` | the vault `script/MigrateVault.s.sol` replaced; its past events stay on chain |
