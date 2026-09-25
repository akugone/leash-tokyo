// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Commit-reveal registrar for `.eth` names on ENSv2 Sepolia.
interface IETHRegistrar {
    error CommitmentTooNew(bytes32 commitment, uint64 minTime, uint64 now_);
    error CommitmentTooOld(bytes32 commitment, uint64 maxTime, uint64 now_);
    error UnexpiredCommitmentExists(bytes32 commitment);

    function commit(bytes32 commitment) external;

    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external pure returns (bytes32);

    function register(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256 tokenId);

    function getRegisterPrice(string calldata label, uint64 duration, address paymentToken)
        external
        view
        returns (uint256 base, uint256 premium);

    function isAvailable(string calldata label) external view returns (bool);
    function commitmentAt(bytes32 commitment) external view returns (uint64);
    function MIN_COMMITMENT_AGE() external view returns (uint64);
    function MIN_REGISTER_DURATION() external view returns (uint64);
    function ETH_REGISTRY() external view returns (address);
}

/// @notice Test stablecoin used by the Sepolia registrar. `mint` has no access control.
interface IMockERC20Mintable {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}
