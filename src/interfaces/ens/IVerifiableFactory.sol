// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ENS `VerifiableFactory`: deploys UUPS proxy clones at CREATE2 addresses.
/// @dev CREATE2 salt is `keccak256(abi.encode(msg.sender, salt))`.
interface IVerifiableFactory {
    error VerificationFailed(address proxy);

    event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation);

    /// @param implementation Implementation the proxy delegates to.
    /// @param salt Caller-chosen salt.
    /// @param data Initializer calldata executed on the proxy.
    function deployProxy(address implementation, uint256 salt, bytes memory data) external returns (address proxy);

    function verifyContract(address proxy) external view returns (address implementation);
}
