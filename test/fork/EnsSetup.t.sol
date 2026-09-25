// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LeashOrgLib} from "../../script/ens/LeashOrgLib.sol";
import {IEnhancedAccessControl} from "../../src/interfaces/ens/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {RegistryRoles, ResolverRoles} from "../../src/libraries/EnsRoles.sol";
import {LeashEnsLib} from "../../src/libraries/LeashEnsLib.sol";
import {ForkEnsFixture} from "./ForkEnsFixture.sol";

/// @notice Sepolia fork proof of tickets L-03 to L-07 against the deployed ENSv2 contracts.
contract EnsSetupForkTest is ForkEnsFixture {
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

    // ============ DeployOrgRegistry / DeployOrgResolver Tests ============

    function test_DeployOrg_OwnerHoldsRootRoles() public view {
        assertTrue(orgRegistry.hasRootRoles(RegistryRoles.ORG_OWNER_ROOT_ROLES, owner), "registry root roles");
        assertTrue(orgResolver.hasRootRoles(ResolverRoles.ORG_OWNER_ROOT_ROLES, owner), "resolver root roles");
        assertTrue(orgResolver.hasRootRoles(ResolverRoles.ROLE_SET_TEXT_ADMIN, owner), "ROLE_SET_TEXT_ADMIN");
    }

    // ============ IssueAgent Tests ============

    function test_IssueAgent() public view {
        assertGt(orgRegistry.getExpiry(agentId), block.timestamp, "expiry");
        assertEq(orgRegistry.getResolver(agentLabel), address(orgResolver), "resolver");
        assertEq(orgRegistry.getOwner(agentId), owner, "token owner is org owner");
        assertEq(LeashEnsLib.readAddr(orgResolver, agentDnsName), agent, "addr");
        assertEq(
            LeashEnsLib.readText(orgResolver, agentDnsName, LeashOrgLib.KEY_QUOTE),
            LeashOrgLib.addressString(policyQuote),
            "leash.quote"
        );
        assertEq(
            LeashEnsLib.readText(orgResolver, agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL),
            LeashOrgLib.capString(policyCap),
            "leash.dailyNotional"
        );
        assertEq(
            LeashEnsLib.readText(orgResolver, agentDnsName, LeashOrgLib.KEY_TOKENS),
            LeashOrgLib.tokenListString(policyTokens),
            "leash.tokens"
        );
        assertEq(orgResolver.getRecordId(agentNode) != 0, true, "record exists for agent node");
    }

    function test_Agent_ExpiresNaturally() public {
        string memory label = "trader-2";
        bytes memory dnsName = _issueAgent(label, 180, policyQuote, policyCap, policyTokens);
        assertEq(orgRegistry.getResolver(label), address(orgResolver), "live");
        assertEq(LeashEnsLib.readAddr(orgResolver, dnsName), agent, "addr while live");

        vm.warp(block.timestamp + 181);

        assertEq(orgRegistry.getResolver(label), address(0), "resolver after expiry");
        assertLe(orgRegistry.getExpiry(EnsNameLib.labelId(label)), block.timestamp, "expired");
        assertEq(orgRegistry.getOwner(EnsNameLib.labelId(label)), address(0), "no owner after expiry");
    }

    // ============ GrantRiskManager Tests ============

    function test_RiskManager_CanTightenCap() public {
        vm.prank(riskManager);
        orgResolver.setText(agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL, "1");
        assertEq(LeashEnsLib.readText(orgResolver, agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL), "1");
    }

    function test_RiskManager_CanEditTokens() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0xBEEF);
        string memory value = LeashOrgLib.tokenListString(tokens);

        vm.prank(riskManager);
        orgResolver.setText(agentDnsName, LeashOrgLib.KEY_TOKENS, value);
        assertEq(LeashEnsLib.readText(orgResolver, agentDnsName, LeashOrgLib.KEY_TOKENS), value);
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
        orgResolver.setText(agentDnsName, LeashOrgLib.KEY_QUOTE, LeashOrgLib.addressString(address(0xBAD)));
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
        orgResolver.setAddress(agentDnsName, LeashOrgLib.COIN_TYPE_ETH, abi.encodePacked(riskManager));
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
        orgResolver.revokeRoles(
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
        orgResolver.setText(agentDnsName, LeashOrgLib.KEY_DAILY_NOTIONAL, "1");
    }
}
