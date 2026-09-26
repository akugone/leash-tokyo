// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LeashOrgLib} from "../../script/ens/LeashOrgLib.sol";
import {IEnhancedAccessControl} from "../../src/interfaces/ens/IEnhancedAccessControl.sol";
import {SepoliaAddresses} from "../../script/Addresses.sol";
import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {RegistryRoles, ResolverRoles} from "../../src/libraries/EnsRoles.sol";
import {LeashEnsLib} from "../../src/libraries/LeashEnsLib.sol";
import {ForkEnsFixture} from "./ForkEnsFixture.sol";

/// @notice ENSIP-10 entry point of the ENSv2 UniversalResolver.
interface IUniversalResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

/// @notice Sepolia fork proof of tickets L-03 to L-07 against the deployed ENSv2 contracts.
contract EnsSetupForkTest is ForkEnsFixture {
    /// @dev `addr(bytes32)`.
    bytes4 internal constant ADDR_SELECTOR = 0x3b3b57de;

    uint256 internal agentId;

    function setUp() public {
        _forkSepolia();
        setUpEns();
        agentId = EnsNameLib.labelId(agentLabel);
        _logSetupGas();
    }

    // ============ RegisterParent Tests ============

    function test_RegisterParent() public view {
        assertEq(ethRegistry.getSubregistry(parentLabel), address(orgRegistry), "subregistry");
        assertEq(ethRegistry.getOwner(EnsNameLib.labelId(parentLabel)), owner, "owner");
        assertGt(ethRegistry.getExpiry(EnsNameLib.labelId(parentLabel)), block.timestamp, "expiry");
        assertTrue(
            ethRegistry.hasRoles(EnsNameLib.labelId(parentLabel), RegistryRoles.ROLE_SET_SUBREGISTRY, owner),
            "owner token roles"
        );
    }

    // ============ DeployOrgRegistry / IssueAgent resolver Tests ============

    function test_DeployOrg_OwnerHoldsRootRoles() public view {
        assertTrue(orgRegistry.hasRootRoles(RegistryRoles.ORG_OWNER_ROOT_ROLES, owner), "registry root roles");
        assertTrue(agentResolver.hasRootRoles(ResolverRoles.ORG_OWNER_ROOT_ROLES, owner), "resolver root roles");
        assertTrue(agentResolver.hasRootRoles(ResolverRoles.ROLE_SET_TEXT_ADMIN, owner), "ROLE_SET_TEXT_ADMIN");
    }

    // ============ IssueAgent Tests ============

    function test_IssueAgent() public view {
        assertGt(orgRegistry.getExpiry(agentId), block.timestamp, "expiry");
        assertEq(orgRegistry.getResolver(agentLabel), address(agentResolver), "resolver");
        assertEq(orgRegistry.getOwner(agentId), owner, "token owner is org owner");
        assertEq(LeashEnsLib.readAddr(agentResolver, agentDnsName), agent, "addr");
        assertEq(
            LeashEnsLib.readText(agentResolver, agentDnsName, LeashOrgLib.KEY_QUOTE),
            LeashOrgLib.addressString(policyQuote),
            "leash.quote"
        );
        assertEq(
            LeashEnsLib.readText(agentResolver, agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL),
            LeashOrgLib.capString(policyCap),
            "leash.dailyNotional"
        );
        assertEq(
            LeashEnsLib.readText(agentResolver, agentDnsName, LeashOrgLib.KEY_TOKENS),
            LeashOrgLib.tokenListString(policyTokens),
            "leash.tokens"
        );
        assertEq(agentResolver.getRecordId(agentNode) != 0, true, "record exists for agent node");
    }

    function test_Agent_ExpiresNaturally() public {
        string memory label = "trader-2";
        bytes memory dnsName = _issueAgent(label, 180, policyQuote, policyCap, policyTokens);
        IPermissionedResolver resolver = _resolverOf(label);
        assertTrue(address(resolver) != address(0), "live");
        assertEq(LeashEnsLib.readAddr(resolver, dnsName), agent, "addr while live");

        vm.warp(block.timestamp + 181);

        assertEq(orgRegistry.getResolver(label), address(0), "resolver after expiry");
        assertLe(orgRegistry.getExpiry(EnsNameLib.labelId(label)), block.timestamp, "expired");
        assertEq(orgRegistry.getOwner(EnsNameLib.labelId(label)), address(0), "no owner after expiry");
    }

    // ============ Agent resolver Tests ============

    function test_EachAgentHasItsOwnResolver() public {
        bytes memory dnsName = _issueAgent("trader-2", 1 days, policyQuote, 1e18, policyTokens);
        IPermissionedResolver other = _resolverOf("trader-2");

        assertTrue(address(other) != address(0) && address(other) != address(agentResolver), "distinct resolver");
        assertTrue(other.hasRootRoles(ResolverRoles.ORG_OWNER_ROOT_ROLES, owner), "owner root roles");
        assertEq(LeashEnsLib.readText(other, dnsName, LeashOrgLib.KEY_DAILY_NOTIONAL), "1000000000000000000", "own cap");
        // Each resolver holds its own agent's data only.
        assertEq(LeashEnsLib.readAddr(other, agentDnsName), address(0), "trader-1 absent from trader-2's resolver");
        assertEq(LeashEnsLib.readAddr(agentResolver, dnsName), address(0), "trader-2 absent from trader-1's resolver");
    }

    /// @dev A risk manager delegated on trader-1 has no power over an agent issued without a grant.
    function test_RevertWhen_RiskManager_TightensAgentWithoutGrant() public {
        bytes memory dnsName = _issueAgent("trader-2", 1 days, policyQuote, policyCap, policyTokens);
        IPermissionedResolver other = _resolverOf("trader-2");

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                ResolverRoles.textResource(LeashOrgLib.KEY_DAILY_NOTIONAL),
                ResolverRoles.ROLE_SET_TEXT,
                riskManager
            )
        );
        vm.prank(riskManager);
        other.setText(dnsName, LeashOrgLib.KEY_DAILY_NOTIONAL, "1");
    }

    /// @dev Revoking the risk manager on one agent leaves its role on another agent untouched.
    function test_RiskManager_GrantIsPerAgent() public {
        bytes memory dnsName = _issueAgent("trader-2", 1 days, policyQuote, policyCap, policyTokens);
        IPermissionedResolver other = _resolverOf("trader-2");
        _grantRiskManager(other);

        vm.prank(owner);
        agentResolver.revokeRoles(
            ResolverRoles.textResource(LeashOrgLib.KEY_DAILY_NOTIONAL), ResolverRoles.ROLE_SET_TEXT, riskManager
        );

        vm.prank(riskManager);
        other.setText(dnsName, LeashOrgLib.KEY_DAILY_NOTIONAL, "7");
        assertEq(LeashEnsLib.readText(other, dnsName, LeashOrgLib.KEY_DAILY_NOTIONAL), "7", "still delegated");

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                ResolverRoles.textResource(LeashOrgLib.KEY_DAILY_NOTIONAL),
                ResolverRoles.ROLE_SET_TEXT,
                riskManager
            )
        );
        vm.prank(riskManager);
        agentResolver.setText(agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL, "1");
    }

    /// @dev `initialize` runs setters unchecked but cannot grant scoped roles: the factory is the caller.
    function test_RevertWhen_GrantSetterRolesInInitialize() public {
        bytes[] memory calls = LeashOrgLib.riskManagerGrantCalls(riskManager);
        vm.prank(owner);
        vm.expectRevert();
        factory.deployProxy(
            SepoliaAddresses.ENS_PERMISSIONED_RESOLVER_IMPL, 1, LeashOrgLib.agentResolverInitData(owner, calls)
        );
    }

    /// @dev What `MigrateAgentResolver` does: records copied into a fresh resolver, the name re-pointed.
    function test_Owner_MovesAgentToFreshResolver() public {
        uint64 expiry = orgRegistry.getExpiry(agentId);
        vm.startPrank(owner);
        address fresh = factory.deployProxy(
            SepoliaAddresses.ENS_PERMISSIONED_RESOLVER_IMPL,
            LeashOrgLib.migratedResolverSalt(agentLabel, block.timestamp),
            LeashOrgLib.agentResolverInitData(
                owner, LeashOrgLib.policyCalls(agentDnsName, agent, policyQuote, policyCap, policyTokens)
            )
        );
        orgRegistry.setResolver(agentId, fresh);
        vm.stopPrank();

        assertEq(orgRegistry.getResolver(agentLabel), fresh, "re-pointed");
        assertEq(orgRegistry.getExpiry(agentId), expiry, "expiry kept");
        assertEq(LeashEnsLib.readAddr(IPermissionedResolver(fresh), agentDnsName), agent, "addr copied");
    }

    /// @dev Any ENSv2 client finds the agent: the UniversalResolver walks root, `.eth`, the org registry, then
    ///      the agent's own resolver.
    function test_UniversalResolver_ResolvesAgent() public view {
        (bytes memory result, address resolver) = IUniversalResolver(SepoliaAddresses.ENS_UNIVERSAL_RESOLVER)
            .resolve(agentDnsName, abi.encodeWithSelector(ADDR_SELECTOR, agentNode));
        assertEq(resolver, address(agentResolver), "agent's own resolver");
        assertEq(abi.decode(result, (address)), agent, "addr");
    }

    // ============ GrantRiskManager Tests ============

    function test_RiskManager_CanTightenCap() public {
        vm.prank(riskManager);
        agentResolver.setText(agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL, "1");
        assertEq(LeashEnsLib.readText(agentResolver, agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL), "1");
    }

    function test_RiskManager_CanEditTokens() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0xBEEF);
        string memory value = LeashOrgLib.tokenListString(tokens);

        vm.prank(riskManager);
        agentResolver.setText(agentDnsName, LeashOrgLib.KEY_TOKENS, value);
        assertEq(LeashEnsLib.readText(agentResolver, agentDnsName, LeashOrgLib.KEY_TOKENS), value);
    }

    function test_RevertWhen_RiskManager_SetQuote() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                ResolverRoles.textResource(LeashOrgLib.KEY_QUOTE),
                ResolverRoles.ROLE_SET_TEXT,
                riskManager
            )
        );
        vm.prank(riskManager);
        agentResolver.setText(agentDnsName, LeashOrgLib.KEY_QUOTE, LeashOrgLib.addressString(address(0xBAD)));
    }

    function test_RevertWhen_RiskManager_SetAddress() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                ResolverRoles.addressResource(LeashOrgLib.COIN_TYPE_ETH),
                ResolverRoles.ROLE_SET_ADDRESS,
                riskManager
            )
        );
        vm.prank(riskManager);
        agentResolver.setAddress(agentDnsName, LeashOrgLib.COIN_TYPE_ETH, abi.encodePacked(riskManager));
    }

    function test_RevertWhen_RiskManager_Unregister() public {
        IPermissionedRegistry.State memory state = orgRegistry.getState(agentId);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                state.resource,
                RegistryRoles.ROLE_UNREGISTER,
                riskManager
            )
        );
        vm.prank(riskManager);
        orgRegistry.unregister(agentId);
    }

    function test_RevertWhen_RiskManager_Renew() public {
        IPermissionedRegistry.State memory state = orgRegistry.getState(agentId);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                state.resource,
                RegistryRoles.ROLE_RENEW,
                riskManager
            )
        );
        vm.prank(riskManager);
        orgRegistry.renew(agentId, uint64(block.timestamp + 365 days));
    }

    // ============ Owner Tests ============

    function test_Owner_CutLeash() public {
        vm.prank(owner);
        orgRegistry.unregister(agentId);

        assertLe(orgRegistry.getExpiry(agentId), block.timestamp, "expiry");
        assertEq(orgRegistry.getResolver(agentLabel), address(0), "resolver");
        assertEq(orgRegistry.getOwner(agentId), address(0), "owner");
    }

    function test_Owner_CanRevokeRiskManager() public {
        vm.prank(owner);
        agentResolver.revokeRoles(
            ResolverRoles.textResource(LeashOrgLib.KEY_DAILY_NOTIONAL), ResolverRoles.ROLE_SET_TEXT, riskManager
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                ResolverRoles.textResource(LeashOrgLib.KEY_DAILY_NOTIONAL),
                ResolverRoles.ROLE_SET_TEXT,
                riskManager
            )
        );
        vm.prank(riskManager);
        agentResolver.setText(agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL, "1");
    }
}
