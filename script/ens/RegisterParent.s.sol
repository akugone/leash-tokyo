// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {EnsScriptBase} from "./EnsScriptBase.s.sol";
import {LeashOrgLib} from "./LeashOrgLib.sol";

/// @notice Register the org `.eth` name on the ENSv2 Sepolia registrar (ticket L-03).
/// @dev Two entrypoints, selected with `--sig`:
///      1. `commit()`: mints MockUSDC, approves the registrar, commits. Writes the name keys to the JSON.
///      2. `reveal()`: registers. Must run at least `MIN_COMMITMENT_AGE` (60 s) after `commit()` and
///         before `MAX_COMMITMENT_AGE` (24 h). On anvil: `cast rpc evm_increaseTime 61 && cast rpc evm_mine`.
///      The secret is `keccak256("leash", label, owner)` so `reveal()` recomputes it. `subregistry` and
///      `resolver` stay zero here, `DeployOrgRegistry` sets the subregistry from the owner's token roles.
///      Duration: env `PARENT_DURATION` in seconds, default the registrar minimum (28 days). Both steps must see
///      the same value, the commitment covers it.
contract RegisterParent is EnsScriptBase {
    /// @dev Mint 10% over the quoted price so a price drift between quote and reveal does not break the demo.
    uint256 internal constant PRICE_MARGIN_BPS = 1000;

    // ============ External functions ============

    /// @notice Step 1: fund the owner in MockUSDC and commit to the registration.
    function commit() external {
        address owner = _owner();
        string memory label = _parentLabel();
        uint64 duration = _duration();

        _requireNotDelegated(owner, "owner");
        require(REGISTRAR.isAvailable(label), "RegisterParent: label not available");
        (uint256 base, uint256 premium) = REGISTRAR.getRegisterPrice(label, duration, address(USDC));
        uint256 price = base + premium;
        uint256 mintAmount = price + (price * PRICE_MARGIN_BPS) / 10_000;
        bytes32 commitment = _commitment(label, owner, duration);

        vm.startBroadcast(_ownerPk());
        USDC.mint(owner, mintAmount);
        USDC.approve(address(REGISTRAR), mintAmount);
        REGISTRAR.commit(commitment);
        vm.stopBroadcast();

        _writeUint("chainId", block.chainid);
        _writeString("parentLabel", label);
        _writeString("parentName", _parentName());
        _writeBytes32("parentNode", EnsNameLib.namehash(_parentName()));
        _writeAddress("orgOwner", owner);
        _writeAddress("riskManager", _riskManager());
        _writeAddress("agent", _agent());
        _writeString("agentLabel", _agentLabel());

        console2.log("RegisterParent.commit: label", label);
        console2.log("RegisterParent.commit: price (MockUSDC, 6 decimals)", price);
        console2.log("RegisterParent.commit: minted", mintAmount);
        console2.log("RegisterParent.commit: duration (s)", duration);
        console2.log("RegisterParent.commit: commitment", vm.toString(commitment));
        console2.log("RegisterParent.commit: reveal after 60 s and before 24 h");
    }

    /// @notice Step 2: reveal and register. Requires the commitment from `commit()` to be 60 s old.
    function reveal() external {
        address owner = _owner();
        string memory label = _parentLabel();
        uint64 duration = _duration();
        bytes32 secret = LeashOrgLib.parentSecret(label, owner);

        vm.startBroadcast(_ownerPk());
        uint256 tokenId =
            REGISTRAR.register(label, owner, secret, address(0), address(0), duration, address(USDC), bytes32(0));
        vm.stopBroadcast();

        require(ETH_REGISTRY.getOwner(EnsNameLib.labelId(label)) == owner, "RegisterParent: owner mismatch");
        _writeUint("parentTokenId", tokenId);

        console2.log("RegisterParent.reveal: registered", _parentName());
        console2.log("RegisterParent.reveal: tokenId", tokenId);
        console2.log("RegisterParent.reveal: expiry", ETH_REGISTRY.getExpiry(EnsNameLib.labelId(label)));
        _logAddress("RegisterParent.reveal: owner", owner);
    }

    // ============ Internal functions ============

    function _duration() internal view returns (uint64) {
        uint64 min = REGISTRAR.MIN_REGISTER_DURATION();
        uint64 duration = uint64(vm.envOr("PARENT_DURATION", uint256(min)));
        require(duration >= min, "RegisterParent: PARENT_DURATION below the registrar minimum");
        return duration;
    }

    function _commitment(string memory label, address owner, uint64 duration) internal pure returns (bytes32) {
        return LeashOrgLib.parentRegistrationCommitment(
            REGISTRAR,
            label,
            owner,
            LeashOrgLib.parentSecret(label, owner),
            address(0),
            address(0),
            duration,
            bytes32(0)
        );
    }
}
