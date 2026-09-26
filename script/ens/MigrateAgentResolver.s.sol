// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {LeashEnsLib} from "../../src/libraries/LeashEnsLib.sol";
import {SepoliaAddresses} from "../Addresses.sol";
import {EnsScriptBase} from "./EnsScriptBase.s.sol";
import {LeashOrgLib} from "./LeashOrgLib.sol";

/// @notice Move a live agent from the resolver it shares with other agents to its own Permissioned Resolver.
/// @dev Copies the name's records as they are (addr and the four `leash.*` text records, raw strings) into a
///      fresh resolver through `initialize`, then points the name at it with `setResolver`: the owner holds
///      `ROLE_SET_RESOLVER` on the token. Two owner transactions; the name keeps its token and its expiry, and the
///      hook reads the new resolver from the next block. Run `GrantRiskManager` afterwards to delegate the two
///      risk keys on the new resolver.
///      Entrypoints: `run()` uses `AGENT_LABEL` (default `trader-1`); `migrate(string)` takes the label.
contract MigrateAgentResolver is EnsScriptBase {
    // ============ External functions ============

    function run() external {
        migrate(_agentLabel());
    }

    // ============ Public functions ============

    function migrate(string memory label) public {
        address owner = _owner();
        IPermissionedRegistry orgRegistry = _orgRegistry();
        IPermissionedResolver previous = _agentResolver(label);
        uint256 labelId = EnsNameLib.labelId(label);
        uint64 expiry = orgRegistry.getExpiry(labelId);
        bytes memory dnsName = EnsNameLib.dnsEncode(label, EnsNameLib.dnsEncodeName(_parentName()));
        bytes[] memory records = _copyRecords(previous, dnsName);

        vm.startBroadcast(_ownerPk());
        address resolver = FACTORY.deployProxy(
            SepoliaAddresses.ENS_PERMISSIONED_RESOLVER_IMPL,
            LeashOrgLib.migratedResolverSalt(label, block.timestamp),
            LeashOrgLib.agentResolverInitData(owner, records)
        );
        orgRegistry.setResolver(labelId, resolver);
        vm.stopBroadcast();

        require(orgRegistry.getResolver(label) == resolver, "MigrateAgentResolver: resolver not set");
        require(orgRegistry.getExpiry(labelId) == expiry, "MigrateAgentResolver: expiry moved");
        require(
            LeashEnsLib.readAddr(IPermissionedResolver(resolver), dnsName) == LeashEnsLib.readAddr(previous, dnsName),
            "MigrateAgentResolver: addr record mismatch"
        );
        string[4] memory keys = _keys();
        for (uint256 i = 0; i < keys.length; i++) {
            require(
                keccak256(bytes(LeashEnsLib.readText(IPermissionedResolver(resolver), dnsName, keys[i])))
                    == keccak256(bytes(LeashEnsLib.readText(previous, dnsName, keys[i]))),
                string.concat("MigrateAgentResolver: record mismatch on ", keys[i])
            );
        }
        if (keccak256(bytes(label)) == keccak256(bytes(_agentLabel()))) _writeAddress("agentResolver", resolver);

        console2.log("MigrateAgentResolver: migrated", string.concat(label, ".", _parentName()));
        _logAddress("MigrateAgentResolver: previous resolver", address(previous));
        _logAddress("MigrateAgentResolver: own resolver", resolver);
    }

    // ============ Internal functions ============

    /// @dev Setter calldata reproducing the name's current records byte for byte.
    function _copyRecords(IPermissionedResolver from, bytes memory dnsName)
        internal
        view
        returns (bytes[] memory records)
    {
        string[4] memory keys = _keys();
        records = new bytes[](keys.length + 1);
        records[0] = abi.encodeCall(
            IPermissionedResolver.setAddress,
            (dnsName, LeashOrgLib.COIN_TYPE_ETH, abi.encodePacked(LeashEnsLib.readAddr(from, dnsName)))
        );
        for (uint256 i = 0; i < keys.length; i++) {
            records[i + 1] = abi.encodeCall(
                IPermissionedResolver.setText, (dnsName, keys[i], LeashEnsLib.readText(from, dnsName, keys[i]))
            );
        }
    }

    function _keys() internal pure returns (string[4] memory) {
        return [
            LeashOrgLib.KEY_QUOTE,
            LeashOrgLib.KEY_DAILY_NOTIONAL,
            LeashOrgLib.KEY_TOKENS,
            LeashOrgLib.KEY_MAX_SLIPPAGE_BPS
        ];
    }
}
