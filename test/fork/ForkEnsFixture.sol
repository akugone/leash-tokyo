// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {LeashOrgLib} from "../../script/ens/LeashOrgLib.sol";
import {SepoliaAddresses} from "../../script/Addresses.sol";
import {IETHRegistrar, IMockERC20Mintable} from "../../src/interfaces/ens/IETHRegistrar.sol";
import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {IVerifiableFactory} from "../../src/interfaces/ens/IVerifiableFactory.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";

/// @notice Replays the whole ENS side of the demo on a Sepolia fork: parent name, org registry, org resolver,
///         agent subname with policy, scoped risk manager. Other fork suites inherit it.
/// @dev Same `LeashOrgLib` encodings as the scripts; only the signer plumbing differs (pranks instead of
///      broadcasts). The fork is pinned so forge caches the RPC state.
abstract contract ForkEnsFixture is Test {
    // ============ Constants ============

    uint256 internal constant FORK_BLOCK = 11_752_543;

    /// @dev Fixed keys, distinct from anvil's, so the derived owner never collides with a real Sepolia user
    ///      of the `VerifiableFactory` salts.
    uint256 internal constant ownerPk = uint256(keccak256("leash.fixture.owner"));
    uint256 internal constant riskManagerPk = uint256(keccak256("leash.fixture.riskManager"));
    uint256 internal constant agentPk = uint256(keccak256("leash.fixture.agent"));

    string internal constant agentLabel = "trader-1";

    /// @dev Placeholder policy used by `setUpEns()`.
    address internal constant DEFAULT_QUOTE = address(0xCAFE);
    uint256 internal constant DEFAULT_CAP = 250e18;
    uint64 internal constant DEFAULT_TTL = 7 days;

    // ============ Handles ============

    IETHRegistrar internal registrar = IETHRegistrar(SepoliaAddresses.ENS_ETH_REGISTRAR);
    IPermissionedRegistry internal ethRegistry = IPermissionedRegistry(SepoliaAddresses.ENS_ETH_REGISTRY);
    IVerifiableFactory internal factory = IVerifiableFactory(SepoliaAddresses.ENS_VERIFIABLE_FACTORY);
    IMockERC20Mintable internal usdc = IMockERC20Mintable(SepoliaAddresses.ENS_MOCK_USDC);

    // ============ Actors ============

    address internal owner;
    address internal riskManager;
    address internal agent;

    // ============ Names ============

    string internal parentLabel;
    string internal parentName;
    bytes32 internal parentNode;
    bytes internal parentDnsName;
    uint256 internal parentTokenId;

    bytes internal agentDnsName;
    bytes32 internal agentNode;

    // ============ Org contracts ============

    IPermissionedRegistry internal orgRegistry;
    IPermissionedResolver internal orgResolver;

    // ============ Policy used by setUpEns ============

    address internal policyQuote;
    uint256 internal policyCap;
    address[] internal policyTokens;

    // ============ Gas accounting ============

    uint256 internal gasRegisterParent;
    uint256 internal gasDeployOrgRegistry;
    uint256 internal gasDeployOrgResolver;
    uint256 internal gasIssueAgent;
    uint256 internal gasGrantRiskManager;

    // ============ Internal functions ============

    /// @notice Select the pinned Sepolia fork and derive the actors.
    function _forkSepolia() internal {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"), FORK_BLOCK);

        owner = vm.addr(ownerPk);
        riskManager = vm.addr(riskManagerPk);
        agent = vm.addr(agentPk);

        vm.label(owner, "owner");
        vm.label(riskManager, "riskManager");
        vm.label(agent, "agent");
        vm.label(address(registrar), "ETHRegistrar");
        vm.label(address(ethRegistry), "ETHRegistry");
        vm.label(address(factory), "VerifiableFactory");
        vm.label(address(usdc), "MockUSDC");
        vm.label(SepoliaAddresses.ENS_USER_REGISTRY_IMPL, "UserRegistryImpl");
        vm.label(SepoliaAddresses.ENS_PERMISSIONED_RESOLVER_IMPL, "PermissionedResolverImpl");
        vm.label(SepoliaAddresses.ENS_LABEL_STORE, "LabelStore");
        vm.label(SepoliaAddresses.ENS_RENT_PRICE_ORACLE, "RentPriceOracle");
    }

    /// @notice Full flow with the placeholder policy: quote 0xCAFE, tokens [0xCAFE, 0xBEEF], cap 250e18.
    function setUpEns() internal virtual {
        address[] memory tokens = new address[](2);
        tokens[0] = address(0xCAFE);
        tokens[1] = address(0xBEEF);
        setUpEns(DEFAULT_QUOTE, DEFAULT_CAP, tokens);
    }

    /// @notice Full flow with an explicit policy for the default agent name.
    function setUpEns(address quote, uint256 cap, address[] memory tokens) internal virtual {
        policyQuote = quote;
        policyCap = cap;
        policyTokens = tokens;

        uint256 g = gasleft();
        _registerParent();
        gasRegisterParent = g - gasleft();

        g = gasleft();
        _deployOrgRegistry();
        gasDeployOrgRegistry = g - gasleft();

        g = gasleft();
        _deployOrgResolver();
        gasDeployOrgResolver = g - gasleft();

        g = gasleft();
        _issueAgent(agentLabel, DEFAULT_TTL, quote, cap, tokens);
        gasIssueAgent = g - gasleft();

        g = gasleft();
        _grantRiskManager();
        gasGrantRiskManager = g - gasleft();
    }

    /// @notice Commit, wait `MIN_COMMITMENT_AGE`, register `<parentLabel>.eth` to `owner`, paid in MockUSDC.
    /// @dev The label is derived from the owner address and bumped while taken on the forked chain.
    function _registerParent() internal {
        parentLabel = _pickParentLabel();
        parentName = string.concat(parentLabel, ".eth");
        parentNode = EnsNameLib.namehash(parentName);
        parentDnsName = EnsNameLib.dnsEncodeName(parentName);

        uint64 duration = registrar.MIN_REGISTER_DURATION();
        (uint256 base, uint256 premium) = registrar.getRegisterPrice(parentLabel, duration, address(usdc));
        uint256 price = base + premium;
        bytes32 secret = LeashOrgLib.parentSecret(parentLabel, owner);
        bytes32 commitment = LeashOrgLib.parentRegistrationCommitment(
            registrar, parentLabel, owner, secret, address(0), address(0), duration, bytes32(0)
        );

        vm.deal(owner, 10 ether);
        vm.deal(riskManager, 10 ether);
        vm.deal(agent, 10 ether);

        vm.startPrank(owner);
        usdc.mint(owner, price);
        usdc.approve(address(registrar), price);
        registrar.commit(commitment);
        vm.warp(block.timestamp + registrar.MIN_COMMITMENT_AGE() + 1);
        parentTokenId =
            registrar.register(parentLabel, owner, secret, address(0), address(0), duration, address(usdc), bytes32(0));
        vm.stopPrank();
    }

    /// @notice Deploy the org `UserRegistry` proxy and make it the subregistry of the parent name.
    function _deployOrgRegistry() internal {
        vm.startPrank(owner);
        address proxy = factory.deployProxy(
            SepoliaAddresses.ENS_USER_REGISTRY_IMPL, LeashOrgLib.REGISTRY_SALT, LeashOrgLib.registryInitData(owner)
        );
        ethRegistry.setSubregistry(EnsNameLib.labelId(parentLabel), proxy);
        vm.stopPrank();

        orgRegistry = IPermissionedRegistry(proxy);
        vm.label(proxy, "orgRegistry");
    }

    /// @notice Deploy the org `PermissionedResolver` proxy owned by `owner`.
    function _deployOrgResolver() internal {
        vm.prank(owner);
        address proxy = factory.deployProxy(
            SepoliaAddresses.ENS_PERMISSIONED_RESOLVER_IMPL,
            LeashOrgLib.RESOLVER_SALT,
            LeashOrgLib.resolverInitData(owner)
        );

        orgResolver = IPermissionedResolver(proxy);
        vm.label(proxy, "orgResolver");
    }

    /// @notice Register `label` under the org registry (owned by `owner`, resolved by `orgResolver`) and
    ///         write the agent's policy. Updates `agentDnsName` / `agentNode` when `label == agentLabel`.
    function _issueAgent(string memory label, uint64 ttl, address quote, uint256 cap, address[] memory tokens)
        internal
        returns (bytes memory dnsName)
    {
        dnsName = _dnsName(label);
        if (keccak256(bytes(label)) == keccak256(bytes(agentLabel))) {
            agentDnsName = dnsName;
            agentNode = EnsNameLib.namehash(string.concat(label, ".", parentName));
        }

        vm.prank(owner);
        orgRegistry.register(
            label, owner, address(0), address(orgResolver), LeashOrgLib.agentTokenRoles(), uint64(block.timestamp) + ttl
        );
        _setPolicy(dnsName, agent, quote, cap, tokens);
    }

    /// @notice Write addr + the three `leash.*` text records in one `multicall`, as `owner`.
    function _setPolicy(bytes memory dnsName, address agentAddr, address quote, uint256 cap, address[] memory tokens)
        internal
    {
        vm.prank(owner);
        orgResolver.multicall(LeashOrgLib.policyCalls(dnsName, agentAddr, quote, cap, tokens));
    }

    /// @notice Grant the risk manager `ROLE_SET_TEXT` on the two mutable policy keys.
    function _grantRiskManager() internal {
        bytes[] memory setters = LeashOrgLib.riskManagerSetters();
        vm.startPrank(owner);
        for (uint256 i = 0; i < setters.length; i++) {
            orgResolver.grantSetterRoles(setters[i], riskManager);
        }
        vm.stopPrank();
    }

    /// @notice DNS-encoded `<label>.<parentName>`.
    function _dnsName(string memory label) internal view returns (bytes memory) {
        return EnsNameLib.dnsEncode(label, parentDnsName);
    }

    /// @notice Log the gas each setup step consumed (visible with `-vv`).
    function _logSetupGas() internal view {
        console2.log("gas RegisterParent (mint+approve+commit+register)", gasRegisterParent);
        console2.log("gas DeployOrgRegistry (deployProxy+setSubregistry)", gasDeployOrgRegistry);
        console2.log("gas DeployOrgResolver (deployProxy)", gasDeployOrgResolver);
        console2.log("gas IssueAgent (register+multicall)", gasIssueAgent);
        console2.log("gas GrantRiskManager (2x grantSetterRoles)", gasGrantRiskManager);
        console2.log(
            "gas total",
            gasRegisterParent + gasDeployOrgRegistry + gasDeployOrgResolver + gasIssueAgent + gasGrantRiskManager
        );
    }

    /// @dev `leash<6 digits of owner>`, suffixed with a counter while the forked chain already has it.
    function _pickParentLabel() internal view returns (string memory label) {
        label = string.concat("leash", vm.toString(uint256(uint160(owner)) % 1e6));
        uint256 bump;
        while (!registrar.isAvailable(label)) {
            bump++;
            label = string.concat("leash", vm.toString(uint256(uint160(owner)) % 1e6), "x", vm.toString(bump));
        }
    }
}
