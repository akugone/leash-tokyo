// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Sepolia (chain 11155111) address book.
/// @dev ENSv2 addresses: https://docs.ens.domains/learn/deployments/ (deployment of mid September 2026),
///      verified on chain on 21 September 2026 (see docs/ens-v2-sepolia-api.md).
///      Uniswap v4 addresses: https://developers.uniswap.org/contracts/v4/deployments.
///      Re-check both pages on hackathon day: ENSv2 Sepolia has been redeployed three times in 2026.
library SepoliaAddresses {
    uint256 internal constant CHAIN_ID = 11_155_111;

    // ============ ENSv2 ============
    address internal constant ENS_ROOT_REGISTRY = 0x9703DBD26dAB89504490994138cF2c575251a9cE;
    address internal constant ENS_ETH_REGISTRY = 0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E;
    address internal constant ENS_ETH_REGISTRAR = 0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca;
    address internal constant ENS_RENT_PRICE_ORACLE = 0x9B0b9C65BDAf9794Ff7697E4dCFb1f50581072BB;
    address internal constant ENS_LABEL_STORE = 0x375C082021E677a40eA2AE094D050602dba90992;
    address internal constant ENS_VERIFIABLE_FACTORY = 0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C;
    address internal constant ENS_USER_REGISTRY_IMPL = 0xA80338aAA8D23831cEa25E858D1774534aBb0263;
    address internal constant ENS_PERMISSIONED_RESOLVER_IMPL = 0x14F09Fd05d4585759e54844DC9B00147131Cf243;
    address internal constant ENS_UNIVERSAL_RESOLVER = 0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3;
    address internal constant ENS_MOCK_USDC = 0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e;

    // ============ Uniswap v4 ============
    address internal constant UNI_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant UNI_POOL_SWAP_TEST = 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe;
    address internal constant UNI_POOL_MODIFY_LIQUIDITY_TEST = 0x0C478023803a644c94c4CE1C1e7b9A087e411B0A;
    address internal constant UNI_STATE_VIEW = 0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C;
    address internal constant UNI_UNIVERSAL_ROUTER = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;

    // ============ Misc ============
    /// @dev Deterministic deployment proxy used by `HookMiner` / `forge script` CREATE2 deployments.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
}
