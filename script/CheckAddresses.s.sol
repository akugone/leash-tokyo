// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IETHRegistrar} from "../src/interfaces/ens/IETHRegistrar.sol";
import {IPermissionedRegistry} from "../src/interfaces/ens/IPermissionedRegistry.sol";
import {SepoliaAddresses} from "./Addresses.sol";

/// @notice Ticket L-02: fails loudly when any address in `SepoliaAddresses` has no code or the ENSv2 set is
///         inconsistent. Run it on hackathon day before anything else: ENSv2 Sepolia gets redeployed.
///         Usage: forge script script/CheckAddresses.s.sol --rpc-url $SEPOLIA_RPC_URL
contract CheckAddresses is Script {
    function run() external view {
        require(block.chainid == SepoliaAddresses.CHAIN_ID, "CheckAddresses: not Sepolia");

        _requireCode("ENS_ROOT_REGISTRY", SepoliaAddresses.ENS_ROOT_REGISTRY);
        _requireCode("ENS_ETH_REGISTRY", SepoliaAddresses.ENS_ETH_REGISTRY);
        _requireCode("ENS_ETH_REGISTRAR", SepoliaAddresses.ENS_ETH_REGISTRAR);
        _requireCode("ENS_RENT_PRICE_ORACLE", SepoliaAddresses.ENS_RENT_PRICE_ORACLE);
        _requireCode("ENS_LABEL_STORE", SepoliaAddresses.ENS_LABEL_STORE);
        _requireCode("ENS_VERIFIABLE_FACTORY", SepoliaAddresses.ENS_VERIFIABLE_FACTORY);
        _requireCode("ENS_USER_REGISTRY_IMPL", SepoliaAddresses.ENS_USER_REGISTRY_IMPL);
        _requireCode("ENS_PERMISSIONED_RESOLVER_IMPL", SepoliaAddresses.ENS_PERMISSIONED_RESOLVER_IMPL);
        _requireCode("ENS_UNIVERSAL_RESOLVER", SepoliaAddresses.ENS_UNIVERSAL_RESOLVER);
        _requireCode("ENS_MOCK_USDC", SepoliaAddresses.ENS_MOCK_USDC);
        _requireCode("UNI_POOL_MANAGER", SepoliaAddresses.UNI_POOL_MANAGER);
        _requireCode("UNI_POOL_SWAP_TEST", SepoliaAddresses.UNI_POOL_SWAP_TEST);
        _requireCode("UNI_POOL_MODIFY_LIQUIDITY_TEST", SepoliaAddresses.UNI_POOL_MODIFY_LIQUIDITY_TEST);
        _requireCode("UNI_STATE_VIEW", SepoliaAddresses.UNI_STATE_VIEW);
        _requireCode("UNI_UNIVERSAL_ROUTER", SepoliaAddresses.UNI_UNIVERSAL_ROUTER);
        _requireCode("CREATE2_DEPLOYER", SepoliaAddresses.CREATE2_DEPLOYER);

        // The ENSv2 set must be one coherent deployment, not a mix of two redeploys.
        IETHRegistrar registrar = IETHRegistrar(SepoliaAddresses.ENS_ETH_REGISTRAR);
        require(
            registrar.ETH_REGISTRY() == SepoliaAddresses.ENS_ETH_REGISTRY, "CheckAddresses: registrar/registry mismatch"
        );
        IPermissionedRegistry root = IPermissionedRegistry(SepoliaAddresses.ENS_ROOT_REGISTRY);
        require(root.getSubregistry("eth") == SepoliaAddresses.ENS_ETH_REGISTRY, "CheckAddresses: root/eth mismatch");
        IPermissionedRegistry ethRegistry = IPermissionedRegistry(SepoliaAddresses.ENS_ETH_REGISTRY);
        require(ethRegistry.LABEL_STORE() == SepoliaAddresses.ENS_LABEL_STORE, "CheckAddresses: label store mismatch");
        require(
            IPermissionedRegistry(SepoliaAddresses.ENS_USER_REGISTRY_IMPL).LABEL_STORE()
                == SepoliaAddresses.ENS_LABEL_STORE,
            "CheckAddresses: user registry impl from another deployment"
        );
        console2.log("CheckAddresses: all", 16, "addresses have code and the ENSv2 set is coherent");
    }

    function _requireCode(string memory name, address target) internal view {
        require(target.code.length > 0, string.concat("CheckAddresses: no code at ", name));
    }
}
