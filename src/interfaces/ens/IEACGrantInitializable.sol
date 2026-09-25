// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Initialization-time structure for an Enhanced Access Control grant.
///      Mirrors `ensdomains/contracts-v2` as deployed on Sepolia (docs.ens.domains deployments page).
struct Grant {
    address account;
    uint256 roleBitmap;
}

/// @notice Initializer used by `UserRegistry` proxies deployed through `VerifiableFactory`.
/// @dev Interface selector: `0x37cb53a8`
interface IEACGrantInitializable {
    /// @notice Initialize the contract.
    /// @param grants Accounts and roles granted on the root resource.
    function initialize(Grant[] calldata grants) external;
}
