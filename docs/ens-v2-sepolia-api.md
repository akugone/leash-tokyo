# ENSv2 on Sepolia: the API Leash actually talks to

Reference for the contracts deployed on Sepolia and listed on the [ENS Deployments page](https://docs.ens.domains/learn/deployments/). Verified against on-chain bytecode and Sourcify exact-match sources on 21 September 2026. This deployment is **newer than the `main` branch of `ensdomains/contracts-v2`**: do not trust that branch's resolver API.

## Addresses (Sepolia, chain 11155111)

| Contract | Address |
| --- | --- |
| RootRegistry | `0x9703dbd26dab89504490994138cf2c575251a9ce` |
| ETHRegistry | `0x657ea849311d3d5823348dded7c2aaafb3ede09e` |
| ETHRegistrar | `0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca` |
| StandardRentPriceOracle | `0x9b0b9c65bdaf9794ff7697e4dcfb1f50581072bb` |
| LabelStore | `0x375c082021e677a40ea2ae094d050602dba90992` |
| VerifiableFactory | `0x9e726eb570beb6bceb495ab8cda7df517d4e841c` |
| UserRegistryImpl | `0xa80338aaa8d23831cea25e858d1774534abb0263` |
| PermissionedResolverImpl | `0x14f09fd05d4585759e54844dc9b00147131cf243` |
| UniversalResolverV2 | `0x5d25c1d6acbb71b7a28aa7899618a3412a8303e3` |
| MockUSDC (6 decimals, open `mint`) | `0x16f95d91dba7da3aca778ec053df0ff6c6a8aa8e` |

Consistency checks that passed: `ETHRegistrar.ETH_REGISTRY() == ETHRegistry`, `RootRegistry.getSubregistry("eth") == ETHRegistry`, `ETHRegistry.LABEL_STORE() == UserRegistryImpl.LABEL_STORE() == LabelStore`.

Two older Sepolia sets exist (29 June and 15 September 2026) with other addresses. Ignore them.

## Registering the parent name (`ETHRegistrar`)

```solidity
function commit(bytes32 commitment) external;
function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32);
function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) external returns (uint256 tokenId);
function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium);
function isAvailable(string label) view returns (bool);
```

- `MIN_COMMITMENT_AGE = 60` seconds, `MAX_COMMITMENT_AGE = 86400`.
- `MIN_REGISTER_DURATION = 2419200` (28 days).
- Payment: `MockUSDC.mint(address,uint256)` has no access control, then `approve(ETHRegistrar, price)`.
- The owner of the new `.eth` name receives token roles `ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER` (+ admin bits) so it can later call `ETHRegistry.setSubregistry(tokenId, orgRegistry)`. Passing `subregistry` directly in `register` is simpler.

## Deploying the org registry (`VerifiableFactory` + `UserRegistryImpl`)

```solidity
struct Grant { address account; uint256 roleBitmap; }
// VerifiableFactory
function deployProxy(address implementation, uint256 salt, bytes data) external returns (address proxy);
// data = abi.encodeCall(IEACGrantInitializable.initialize, (grants))
```

- CREATE2 salt is `keccak256(abi.encode(msg.sender, salt))`, so the proxy address is deterministic per caller.
- Root roles to grant the org owner: `ROLE_REGISTRAR | ROLE_UNREGISTER | ROLE_RENEW | ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY` plus the same bits shifted by 128 (admin bits).

## Registry calls the hook and scripts use (`PermissionedRegistry`)

```solidity
function register(string label, address owner, address subregistry, address resolver, uint256 roleBitmap, uint64 expiry) external returns (uint256 tokenId); // needs root ROLE_REGISTRAR
function unregister(uint256 anyId) external;   // needs ROLE_UNREGISTER on token or root; sets expiry = block.timestamp, burns the token
function renew(uint256 anyId, uint64 newExpiry) external;
function getExpiry(uint256 anyId) view returns (uint64);      // anyId may be labelhash = uint256(keccak256(label))
function getResolver(string label) view returns (address);    // address(0) when expired
function getOwner(uint256 anyId) view returns (address);
function grantRoles(uint256 anyId, uint256 roleBitmap, address account) external returns (bool);
function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool);
```

`_isExpired(expiry) == block.timestamp >= expiry`. The hook must therefore require `getExpiry(labelhash) > block.timestamp`.

## Resolver: records are keyed by DNS-encoded name, roles by record key

The deployed `PermissionedResolver` is **not** the one in `contracts-v2/main`.

```solidity
function initialize(Grant[] grants, bytes[] calls) external;
function setText(bytes name, string key, string value) external;        // ROLE_SET_TEXT on resource(key) or root
function setAddress(bytes name, uint256 coinType, bytes addressBytes) external; // ROLE_SET_ADDRESS on resource(coinType) or root; coinType 60 = ETH, 20 bytes
function grantSetterRoles(bytes setterCalldata, address account) external returns (bool); // the ONLY way to grant scoped roles
function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool);
function resolve(bytes name, bytes data) view returns (bytes);           // ENSIP-10, the only read path
function multicall(bytes[] calls) external returns (bytes[]);
```

- `name` is the DNS-encoded full name, e.g. `\x08trader-1\x05leash\x03eth\x00`. The resolver derives `node = namehash(name)` itself.
- `grantRoles(...)` is disabled and always reverts. Use `grantSetterRoles(abi.encodeCall(setText, ("", "leash.dailyNotional", "")), riskManager)`. The resolver decodes the calldata, derives `resource = keccak256(bytes(key))` and grants `ROLE_SET_TEXT` on it. The caller needs `ROLE_SET_TEXT_ADMIN` on that resource or on root.
- **Scoping is per record key, not per name.** A risk-manager with `ROLE_SET_TEXT` on `resource("leash.dailyNotional")` can set that key on every name served by this resolver. Leash therefore gives every agent its own resolver: the same grant then covers that one agent. It still cannot touch `addr`, other keys, or the registry.
- **`initialize(grants, calls)` runs setters without checks, but cannot grant scoped roles.** Records passed in `calls` are written in the deployment transaction, which is how Leash creates an agent's resolver with its policy in one transaction. A `grantSetterRoles` call in `calls` reverts `EACCannotGrantRoles`: the resolver sees the factory as the caller. Grant scoped roles afterwards, from the owner (one `multicall`).
- **Re-pointing a name keeps its token and expiry.** `setResolver(labelId, resolver)` needs `ROLE_SET_RESOLVER` on the token or root and emits `ResolverUpdated(tokenId, resolver, sender)`, as `register` does. Leash uses it to move an agent from a shared resolver to its own, and the dashboard reads these events to find the resolver of a name that has since been cut (`getResolver` then answers zero).
- Reads go through `resolve`. The `bytes32 node` argument inside `data` is ignored:

```solidity
bytes memory ret = resolver.resolve(name, abi.encodeWithSelector(0x59d1d43c /* text(bytes32,string) */, bytes32(0), key));
string memory value = abi.decode(ret, (string));
ret = resolver.resolve(name, abi.encodeWithSelector(0x3b3b57de /* addr(bytes32) */, bytes32(0)));
address agent = abi.decode(ret, (address));
```

## Lessons from the fork rehearsal (21 September 2026)

- **Registry revert resources are versioned.** `unregister` and `renew` revert with `EACUnauthorizedAccountRoles(resource, role, account)` where `resource` is the labelhash with its low 32 bits replaced by the entry's `eacVersionId`. Match it with `getState(labelId).resource`, not the bare labelhash.
- **Anvil's default accounts are EIP-7702 delegated on Sepolia.** Their `code` is `0xef0100...` (sweeper bots). `ETHRegistry.register` mints an ERC1155 to the owner, the delegated code does not answer `onERC1155Received`, and the registration reverts with empty data. Use fresh keys (`cast wallet new`) for every account that receives a name; `script/ens/EnsScriptBase.s.sol` refuses delegated owners up front.
- **Registration price** for `leashdemo`, 28 days, paid in MockUSDC: 613701 raw units (0.61 USDC), no premium.
- `VerifiableFactory.deployProxy` is CREATE2 on `(msg.sender, salt)`: running a deploy script twice from the same owner on the same chain reverts. Change the salt or the owner.
- Gas measured on the fork (26 September 2026): register parent about 430k (commit + reveal), org registry 211k, issue agent 659k (its own resolver deployed with four records in `initialize`, then `register`), risk manager grant 122k (one `multicall` of two `grantSetterRoles`).

## Role bitmaps

Registry (`RegistryRolesLib`): `ROLE_REGISTRAR = 1<<0`, `ROLE_REGISTER_RESERVED = 1<<4`, `ROLE_SET_PARENT = 1<<8`, `ROLE_UNREGISTER = 1<<12`, `ROLE_RENEW = 1<<16`, `ROLE_SET_SUBREGISTRY = 1<<20`, `ROLE_SET_RESOLVER = 1<<24`. Admin bit = role `<< 128`.

Resolver (`PermissionedResolverLib`): `ROLE_SET_ADDRESS = 1<<0`, `ROLE_SET_TEXT = 1<<4`, `ROLE_SET_CONTENTHASH = 1<<8`, `ROLE_SET_ABI = 1<<12`, `ROLE_SET_INTERFACE = 1<<16`, `ROLE_SET_NAME = 1<<20`, `ROLE_SET_DATA = 1<<24`, `ROLE_LINK = 1<<28`. Admin bit = role `<< 128`.

EAC errors: `EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)` selector `0x4b27a133`, `EACCannotGrantRoles(...)` selector `0xd1a3b355`.

## Uniswap v4 on Sepolia

| Contract | Address |
| --- | --- |
| PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| PoolSwapTest | `0x9b6b46e2c869aa39918db7f52f5557fe577b6eee` |
| PoolModifyLiquidityTest | `0x0c478023803a644c94c4ce1c1e7b9a087e411b0a` |
| StateView | `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c` |
| Universal Router | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| CREATE2 deployer (for HookMiner) | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

`v4-periphery` no longer ships `BaseHook`; it lives in `Uniswap/v4-hooks-public`. Leash vendors a copy in `src/base/BaseHook.sol`. `HookMiner` is at `lib/v4-periphery/test/shared/HookMiner.sol`.
