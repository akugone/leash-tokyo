// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";

/// @notice Shared JSON deployment record for every Leash script.
/// @dev File path comes from `LEASH_DEPLOYMENTS_FILE` (default `deployments/sepolia.json`).
///      Keys (all strings in JSON): chainId, parentLabel, parentName, parentNode, orgOwner, riskManager, agent,
///      agentLabel, orgRegistry, agentResolver (own resolver of agentLabel), hook, token0, token1, quote, fee,
///      tickSpacing, poolId, vault. Live Sepolia only: orgResolverPrevious (the shared resolver agents used
///      before each got its own), vaultPrevious.
///      Signer keys come from `OWNER_PK`, `RISK_MANAGER_PK`, `AGENT_PK`.
abstract contract DeploymentsScript is Script {
    string internal constant DEFAULT_FILE = "deployments/sepolia.json";

    // ============ Internal functions ============

    function _deploymentsPath() internal view returns (string memory) {
        return vm.envOr("LEASH_DEPLOYMENTS_FILE", DEFAULT_FILE);
    }

    /// @dev Creates the file with an empty object when missing so `vm.writeJson` can add keys.
    function _ensureDeploymentsFile() internal {
        string memory path = _deploymentsPath();
        if (!vm.exists(path)) {
            vm.writeFile(path, "{}");
        }
    }

    function _writeAddress(string memory key, address value) internal {
        _ensureDeploymentsFile();
        vm.writeJson(vm.toString(value), _deploymentsPath(), string.concat(".", key));
    }

    function _writeBytes32(string memory key, bytes32 value) internal {
        _ensureDeploymentsFile();
        vm.writeJson(vm.toString(value), _deploymentsPath(), string.concat(".", key));
    }

    /// @dev Quoted so the value lands as a JSON string; `vm.writeJson` would otherwise store a number and
    ///      `_readString` could not read it back (every value in the record is a string).
    function _writeUint(string memory key, uint256 value) internal {
        _ensureDeploymentsFile();
        vm.writeJson(string.concat('"', vm.toString(value), '"'), _deploymentsPath(), string.concat(".", key));
    }

    function _writeString(string memory key, string memory value) internal {
        _ensureDeploymentsFile();
        vm.writeJson(value, _deploymentsPath(), string.concat(".", key));
    }

    function _readAddress(string memory key) internal view returns (address) {
        return vm.parseAddress(_readString(key));
    }

    function _readBytes32(string memory key) internal view returns (bytes32) {
        return vm.parseBytes32(_readString(key));
    }

    function _readUint(string memory key) internal view returns (uint256) {
        return vm.parseUint(_readString(key));
    }

    function _readString(string memory key) internal view returns (string memory) {
        string memory json = vm.readFile(_deploymentsPath());
        return vm.parseJsonString(json, string.concat(".", key));
    }

    function _has(string memory key) internal view returns (bool) {
        string memory path = _deploymentsPath();
        if (!vm.exists(path)) return false;
        return vm.keyExistsJson(vm.readFile(path), string.concat(".", key));
    }
}
