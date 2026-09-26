// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IETHRegistrar, IMockERC20Mintable} from "../../src/interfaces/ens/IETHRegistrar.sol";
import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {IVerifiableFactory} from "../../src/interfaces/ens/IVerifiableFactory.sol";
import {SepoliaAddresses} from "../Addresses.sol";
import {DeploymentsScript} from "../Deployments.sol";

/// @notice Common env, address book and JSON lookups for the ENS setup scripts.
/// @dev Env: `OWNER_PK`, `RISK_MANAGER_PK`, `AGENT_PK`, `PARENT_LABEL` (default `leash`),
///      `AGENT_LABEL` (default `trader-1`). Names fall back to the deployments JSON when it already has them.
abstract contract EnsScriptBase is DeploymentsScript {
    IETHRegistrar internal constant REGISTRAR = IETHRegistrar(SepoliaAddresses.ENS_ETH_REGISTRAR);
    IPermissionedRegistry internal constant ETH_REGISTRY = IPermissionedRegistry(SepoliaAddresses.ENS_ETH_REGISTRY);
    IVerifiableFactory internal constant FACTORY = IVerifiableFactory(SepoliaAddresses.ENS_VERIFIABLE_FACTORY);
    IMockERC20Mintable internal constant USDC = IMockERC20Mintable(SepoliaAddresses.ENS_MOCK_USDC);

    // ============ Internal functions ============

    function _ownerPk() internal view returns (uint256) {
        return vm.envUint("OWNER_PK");
    }

    function _owner() internal view returns (address) {
        return vm.addr(_ownerPk());
    }

    function _riskManager() internal view returns (address) {
        return vm.addr(vm.envUint("RISK_MANAGER_PK"));
    }

    function _agent() internal view returns (address) {
        return vm.addr(vm.envUint("AGENT_PK"));
    }

    /// @dev Env first so a fresh run can pick a new label, JSON otherwise, `leash` as last resort.
    function _parentLabel() internal view returns (string memory) {
        return _envOrJson("PARENT_LABEL", "parentLabel", "leash");
    }

    function _parentName() internal view returns (string memory) {
        return string.concat(_parentLabel(), ".eth");
    }

    function _agentLabel() internal view returns (string memory) {
        return _envOrJson("AGENT_LABEL", "agentLabel", "trader-1");
    }

    function _orgRegistry() internal view returns (IPermissionedRegistry) {
        require(_has("orgRegistry"), "EnsScriptBase: orgRegistry missing, run DeployOrgRegistry first");
        return IPermissionedRegistry(_readAddress("orgRegistry"));
    }

    /// @dev The agent's own resolver, as the org registry points to it. The registry answers zero once the name
    ///      is cut or expired.
    function _agentResolver(string memory label) internal view returns (IPermissionedResolver) {
        address resolver = _orgRegistry().getResolver(label);
        require(
            resolver != address(0),
            string.concat("EnsScriptBase: ", label, " has no resolver (cut, expired or never issued)")
        );
        return IPermissionedResolver(resolver);
    }

    function _envOrJson(string memory envKey, string memory jsonKey, string memory fallbackValue)
        internal
        view
        returns (string memory)
    {
        string memory fromEnv = vm.envOr(envKey, string(""));
        if (bytes(fromEnv).length != 0) return fromEnv;
        if (_has(jsonKey)) return _readString(jsonKey);
        return fallbackValue;
    }

    /// @dev Anvil's well-known accounts carry EIP-7702 delegations on Sepolia (sweeper bots), so a fork of
    ///      Sepolia sees code at them and `ERC1155._mint` reverts in `onERC1155Received`. Use fresh keys.
    function _requireNotDelegated(address account, string memory role) internal view {
        bytes memory code = account.code;
        bool delegated = code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00;
        require(!delegated, string.concat("EnsScriptBase: ", role, " is an EIP-7702 delegated EOA, use a fresh key"));
    }

    function _logAddress(string memory label, address value) internal pure {
        console2.log(string.concat(label, ":"), value);
    }
}
