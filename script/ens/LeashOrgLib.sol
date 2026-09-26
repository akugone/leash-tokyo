// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LibString} from "solady/utils/LibString.sol";

import {Grant, IEACGrantInitializable} from "../../src/interfaces/ens/IEACGrantInitializable.sol";
import {IETHRegistrar} from "../../src/interfaces/ens/IETHRegistrar.sol";
import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {RegistryRoles, ResolverRoles} from "../../src/libraries/EnsRoles.sol";

/// @notice Pure helpers shared by the ENS setup scripts and the fork fixture.
/// @dev No broadcasting, no pranking: callers decide who signs. Every encoding the demo sends to the
///      deployed ENSv2 contracts lives here so scripts and tests cannot drift apart.
library LeashOrgLib {
    // ============ Constants ============

    /// @dev ENSIP-9 coin type for Ethereum addresses.
    uint256 internal constant COIN_TYPE_ETH = 60;

    /// @dev Text record keys read by the hook (see `LeashPolicyLib`).
    string internal constant KEY_QUOTE = "leash.quote";
    string internal constant KEY_DAILY_NOTIONAL = "leash.dailyNotional";
    string internal constant KEY_TOKENS = "leash.tokens";
    string internal constant KEY_MAX_SLIPPAGE_BPS = "leash.maxSlippageBps";

    /// @dev `VerifiableFactory` salt of the org registry. The factory mixes in `msg.sender`, so it is per owner.
    uint256 internal constant REGISTRY_SALT = uint256(keccak256("leash.registry.v1"));

    // ============ Parent registration ============

    /// @notice Deterministic commit-reveal secret so `reveal()` can recompute what `commit()` used.
    function parentSecret(string memory label, address owner) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("leash", label, owner));
    }

    /// @notice Wrapper over `IETHRegistrar.makeCommitment` with the same argument order.
    function parentRegistrationCommitment(
        IETHRegistrar registrar,
        string memory label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) internal pure returns (bytes32) {
        return registrar.makeCommitment(label, owner, secret, subregistry, resolver, duration, referrer);
    }

    // ============ Proxy initializers ============

    /// @notice `UserRegistry.initialize` calldata granting `owner` every org root role.
    function registryInitData(address owner) internal pure returns (bytes memory) {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant({account: owner, roleBitmap: RegistryRoles.ORG_OWNER_ROOT_ROLES});
        return abi.encodeCall(IEACGrantInitializable.initialize, (grants));
    }

    // ============ Agent resolver ============

    /// @notice `VerifiableFactory` salt of an agent's own resolver. The expiry makes a re-issued name get a fresh
    ///         resolver (same owner, same label, new mandate), since the factory reverts on a reused salt.
    function agentResolverSalt(string memory label, uint64 expiry) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("leash.agent-resolver.v1", label, expiry)));
    }

    /// @notice Salt of a resolver that replaces a live agent's current one (`MigrateAgentResolver`). Keyed on the
    ///         migration time: the name keeps its expiry, so the issuance salt is already taken.
    function migratedResolverSalt(string memory label, uint256 migratedAt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("leash.agent-resolver.migrated.v1", label, migratedAt)));
    }

    /// @notice `PermissionedResolver.initialize` calldata for an agent's own resolver: `owner` gets the org root
    ///         roles, and `records` (setter calldata, e.g. `policyCalls`) are written in the same transaction.
    /// @dev `initialize` runs `records` without permission checks, but it cannot grant scoped roles: the resolver
    ///      sees the factory as the caller and `grantSetterRoles` reverts `EACCannotGrantRoles`. The risk manager
    ///      is granted afterwards by the owner, see `riskManagerGrantCalls`.
    function agentResolverInitData(address owner, bytes[] memory records) internal pure returns (bytes memory) {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant({account: owner, roleBitmap: ResolverRoles.ORG_OWNER_ROOT_ROLES});
        return abi.encodeCall(IPermissionedResolver.initialize, (grants, records));
    }

    // ============ Agent subname ============

    /// @notice Token roles granted to the org owner on an agent subname.
    /// @dev The owner already holds these on root; the token grant is belt and braces.
    function agentTokenRoles() internal pure returns (uint256) {
        return RegistryRoles.ROLE_UNREGISTER | RegistryRoles.ROLE_RENEW | RegistryRoles.ROLE_SET_RESOLVER;
    }

    /// @notice Calls for `resolver.multicall` writing the whole policy of one agent name.
    /// @param dnsName DNS-encoded full name, e.g. `\x08trader-1\x05leash\x03eth\x00`.
    /// @param agent Address the agent signs with; stored as the ETH address record.
    /// @param quote Quote token the notional cap is denominated in.
    /// @param cap Daily notional cap in quote units, written as a decimal string.
    /// @param tokens Allowed pool currencies, written comma separated with no spaces.
    function policyCalls(bytes memory dnsName, address agent, address quote, uint256 cap, address[] memory tokens)
        internal
        pure
        returns (bytes[] memory calls)
    {
        calls = new bytes[](4);
        calls[0] = abi.encodeCall(IPermissionedResolver.setAddress, (dnsName, COIN_TYPE_ETH, abi.encodePacked(agent)));
        calls[1] = abi.encodeCall(IPermissionedResolver.setText, (dnsName, KEY_QUOTE, addressString(quote)));
        calls[2] = abi.encodeCall(IPermissionedResolver.setText, (dnsName, KEY_DAILY_NOTIONAL, capString(cap)));
        calls[3] = abi.encodeCall(IPermissionedResolver.setText, (dnsName, KEY_TOKENS, tokenListString(tokens)));
    }

    /// @notice Same as `policyCalls` plus `leash.maxSlippageBps`, the maximum price impact of one swap. Owner-only:
    ///         an empty value switches the bound off, so the risk manager gets no role on this key.
    /// @param maxSlippageBps Basis points of the pool price, below 10000, written as a decimal string.
    function policyCalls(
        bytes memory dnsName,
        address agent,
        address quote,
        uint256 cap,
        address[] memory tokens,
        uint256 maxSlippageBps
    ) internal pure returns (bytes[] memory calls) {
        bytes[] memory base = policyCalls(dnsName, agent, quote, cap, tokens);
        calls = new bytes[](base.length + 1);
        for (uint256 i = 0; i < base.length; i++) {
            calls[i] = base[i];
        }
        calls[base.length] =
            abi.encodeCall(IPermissionedResolver.setText, (dnsName, KEY_MAX_SLIPPAGE_BPS, capString(maxSlippageBps)));
    }

    /// @notice `0x` + 40 hex chars, checksummed. Accepted by `LeashPolicyLib.parseAddress`.
    function addressString(address a) internal pure returns (string memory) {
        return LibString.toHexStringChecksummed(a);
    }

    /// @notice Base 10 string. Accepted by `LeashPolicyLib.parseUint`.
    function capString(uint256 cap) internal pure returns (string memory) {
        return LibString.toString(cap);
    }

    /// @notice Comma joined checksummed addresses, no spaces. Accepted by `LeashPolicyLib.parseAddressList`.
    function tokenListString(address[] memory tokens) internal pure returns (string memory out) {
        for (uint256 i = 0; i < tokens.length; i++) {
            out = i == 0 ? addressString(tokens[i]) : string.concat(out, ",", addressString(tokens[i]));
        }
    }

    // ============ Risk manager ============

    /// @notice Setter calldatas for `grantSetterRoles`: the resolver only decodes the text key from them
    ///         and grants `ROLE_SET_TEXT` on `keccak256(bytes(key))`.
    function riskManagerSetters() internal pure returns (bytes[] memory setters) {
        setters = new bytes[](2);
        setters[0] = textSetter(KEY_DAILY_NOTIONAL);
        setters[1] = textSetter(KEY_TOKENS);
    }

    /// @notice Calls for `resolver.multicall` granting `riskManager` the two keys of `riskManagerSetters`, on that
    ///         one agent's resolver: one owner transaction, and no power over any other agent.
    function riskManagerGrantCalls(address riskManager) internal pure returns (bytes[] memory calls) {
        bytes[] memory setters = riskManagerSetters();
        calls = new bytes[](setters.length);
        for (uint256 i = 0; i < setters.length; i++) {
            calls[i] = abi.encodeCall(IPermissionedResolver.grantSetterRoles, (setters[i], riskManager));
        }
    }

    /// @notice Text keys the risk manager may write, same order as `riskManagerSetters`.
    function riskManagerKeys() internal pure returns (string[] memory keys) {
        keys = new string[](2);
        keys[0] = KEY_DAILY_NOTIONAL;
        keys[1] = KEY_TOKENS;
    }

    /// @notice `setText("", key, "")` calldata, the shape `grantSetterRoles` expects for a text key.
    function textSetter(string memory key) internal pure returns (bytes memory) {
        return abi.encodeCall(IPermissionedResolver.setText, (bytes(""), key, ""));
    }
}
