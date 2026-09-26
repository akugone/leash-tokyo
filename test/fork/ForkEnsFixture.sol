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

/// @notice Replays the whole ENS side of the demo on a Sepolia fork: parent name, org registry, agent subname with
///         its own resolver holding its policy, risk manager scoped to that resolver. Other fork suites inherit it.
/// @dev Same `LeashOrgLib` encodings as the scripts; only the signer plumbing differs (pranks instead of
///      broadcasts). The fork is pinned so forge caches the RPC state; `FORK_BLOCK` overrides the pin, for an RPC
///      that is not an archive node (a block a few minutes old).
abstract contract ForkEnsFixture is Test {
    // ============ Constants ============

    uint256 internal constant DEFAULT_FORK_BLOCK = 11_752_543;

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
    /// @dev Own resolver of `agentLabel`. Every agent issued by `_issueAgent` gets its own.
    IPermissionedResolver internal agentResolver;

    // ============ Policy used by setUpEns ============

    address internal policyQuote;
    uint256 internal policyCap;
    address[] internal policyTokens;

    // ============ Gas accounting ============

    uint256 internal gasRegisterParent;
    uint256 internal gasDeployOrgRegistry;
    uint256 internal gasIssueAgent;
    uint256 internal gasGrantRiskManager;

    // ============ Internal functions ============

    /// @notice Select the pinned Sepolia fork and derive the actors.
    function _forkSepolia() internal {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"), vm.envOr("FORK_BLOCK", DEFAULT_FORK_BLOCK));

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
        _issueAgent(agentLabel, DEFAULT_TTL, quote, cap, tokens);
        gasIssueAgent = g - gasleft();

        g = gasleft();
        _grantRiskManager(agentResolver);
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

    /// @notice Deploy `label`'s own resolver with its policy written in `initialize`, then register `label` under
    ///         the org registry (owned by `owner`) pointing to it. Updates `agentResolver`, `agentDnsName` and
    ///         `agentNode` when `label == agentLabel`.
    function _issueAgent(string memory label, uint64 ttl, address quote, uint256 cap, address[] memory tokens)
        internal
        returns (bytes memory dnsName)
    {
        dnsName = _dnsName(label);
        uint64 expiry = uint64(block.timestamp) + ttl;

        vm.startPrank(owner);
        address resolver = factory.deployProxy(
            SepoliaAddresses.ENS_PERMISSIONED_RESOLVER_IMPL,
            LeashOrgLib.agentResolverSalt(label, expiry),
            LeashOrgLib.agentResolverInitData(owner, LeashOrgLib.policyCalls(dnsName, agent, quote, cap, tokens))
        );
        orgRegistry.register(label, owner, address(0), resolver, LeashOrgLib.agentTokenRoles(), expiry);
        vm.stopPrank();
        vm.label(resolver, string.concat("resolver:", label));

        if (keccak256(bytes(label)) == keccak256(bytes(agentLabel))) {
            agentResolver = IPermissionedResolver(resolver);
            agentDnsName = dnsName;
            agentNode = EnsNameLib.namehash(string.concat(label, ".", parentName));
        }
    }

    /// @notice The resolver the org registry currently points `label` to, zero once cut or expired.
    function _resolverOf(string memory label) internal view returns (IPermissionedResolver) {
        return IPermissionedResolver(orgRegistry.getResolver(label));
    }

    /// @notice Grant the risk manager `ROLE_SET_TEXT` on the two mutable policy keys of one agent's resolver,
    ///         in one owner `multicall`.
    function _grantRiskManager(IPermissionedResolver resolver) internal {
        vm.prank(owner);
        resolver.multicall(LeashOrgLib.riskManagerGrantCalls(riskManager));
    }

    /// @notice DNS-encoded `<label>.<parentName>`.
    function _dnsName(string memory label) internal view returns (bytes memory) {
        return EnsNameLib.dnsEncode(label, parentDnsName);
    }

    /// @notice Log the gas each setup step consumed (visible with `-vv`).
    function _logSetupGas() internal view {
        console2.log("gas RegisterParent (mint+approve+commit+register)", gasRegisterParent);
        console2.log("gas DeployOrgRegistry (deployProxy+setSubregistry)", gasDeployOrgRegistry);
        console2.log("gas IssueAgent (deployProxy with records + register)", gasIssueAgent);
        console2.log("gas GrantRiskManager (multicall of 2 grantSetterRoles)", gasGrantRiskManager);
        console2.log("gas total", gasRegisterParent + gasDeployOrgRegistry + gasIssueAgent + gasGrantRiskManager);
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
