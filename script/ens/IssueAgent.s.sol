// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";

import {IPermissionedRegistry} from "../../src/interfaces/ens/IPermissionedRegistry.sol";
import {IPermissionedResolver} from "../../src/interfaces/ens/IPermissionedResolver.sol";
import {EnsNameLib} from "../../src/libraries/EnsNameLib.sol";
import {LeashEnsLib} from "../../src/libraries/LeashEnsLib.sol";
import {EnsScriptBase} from "./EnsScriptBase.s.sol";
import {LeashOrgLib} from "./LeashOrgLib.sol";

/// @notice Issue an agent subname under the org registry and write its policy records (ticket L-06).
/// @dev The subname token is owned by the org owner, never by the agent key. The agent only appears in the
///      ETH address record. Policy inputs: `quote` from the JSON (`quote`) or env `QUOTE`; tokens from the
///      JSON (`token0`, `token1`) or env `TOKEN0`/`TOKEN1`; cap from env `DAILY_CAP` (default 250e18); slippage
///      bound from env `MAX_SLIPPAGE_BPS` (default 100, i.e. 1%).
///      Entrypoints: `run()` uses `AGENT_LABEL` (default `trader-1`) and `AGENT_TTL` (default 7 days);
///      `issue(string,uint64)` takes the label and ttl explicitly, e.g. `--sig "issue(string,uint64)" trader-2 180`.
contract IssueAgent is EnsScriptBase {
    uint256 internal constant DEFAULT_TTL = 7 days;
    uint256 internal constant DEFAULT_CAP = 250e18;
    uint256 internal constant DEFAULT_MAX_SLIPPAGE_BPS = 100;

    // ============ External functions ============

    function run() external virtual {
        issue(_agentLabel(), uint64(vm.envOr("AGENT_TTL", DEFAULT_TTL)));
    }

    // ============ Public functions ============

    /// @param label Subname label, e.g. `trader-1`.
    /// @param ttl Seconds until the name expires and the hook stops accepting the agent.
    function issue(string memory label, uint64 ttl) public {
        address owner = _owner();
        address agent = _agent();
        IPermissionedRegistry orgRegistry = _orgRegistry();
        IPermissionedResolver orgResolver = _orgResolver();
        (address quote, address[] memory tokens, uint256 cap) = _policyInputs();
        uint256 maxSlippageBps = vm.envOr("MAX_SLIPPAGE_BPS", DEFAULT_MAX_SLIPPAGE_BPS);
        require(maxSlippageBps < 10_000, "IssueAgent: MAX_SLIPPAGE_BPS must be below 10000");

        bytes memory dnsName = EnsNameLib.dnsEncode(label, EnsNameLib.dnsEncodeName(_parentName()));
        uint64 expiry = uint64(block.timestamp) + ttl;

        vm.startBroadcast(_ownerPk());
        uint256 tokenId =
            orgRegistry.register(label, owner, address(0), address(orgResolver), LeashOrgLib.agentTokenRoles(), expiry);
        orgResolver.multicall(LeashOrgLib.policyCalls(dnsName, agent, quote, cap, tokens, maxSlippageBps));
        vm.stopBroadcast();

        require(orgRegistry.getExpiry(EnsNameLib.labelId(label)) > block.timestamp, "IssueAgent: not live");
        require(orgRegistry.getResolver(label) == address(orgResolver), "IssueAgent: resolver mismatch");
        require(LeashEnsLib.readAddr(orgResolver, dnsName) == agent, "IssueAgent: addr record mismatch");
        require(
            keccak256(bytes(LeashEnsLib.readText(orgResolver, dnsName, LeashOrgLib.KEY_DAILY_NOTIONAL)))
                == keccak256(bytes(LeashOrgLib.capString(cap))),
            "IssueAgent: cap record mismatch"
        );
        require(
            keccak256(bytes(LeashEnsLib.readText(orgResolver, dnsName, LeashOrgLib.KEY_MAX_SLIPPAGE_BPS)))
                == keccak256(bytes(LeashOrgLib.capString(maxSlippageBps))),
            "IssueAgent: slippage record mismatch"
        );

        console2.log("IssueAgent: issued", string.concat(label, ".", _parentName()));
        console2.log("IssueAgent: tokenId", tokenId);
        console2.log("IssueAgent: expiry", expiry);
        console2.log("IssueAgent: node", vm.toString(EnsNameLib.namehash(string.concat(label, ".", _parentName()))));
        _logAddress("IssueAgent: agent", agent);
        console2.log("IssueAgent: leash.quote", LeashOrgLib.addressString(quote));
        console2.log("IssueAgent: leash.dailyNotional", LeashOrgLib.capString(cap));
        console2.log("IssueAgent: leash.tokens", LeashOrgLib.tokenListString(tokens));
        console2.log("IssueAgent: leash.maxSlippageBps", LeashOrgLib.capString(maxSlippageBps));
    }

    // ============ Internal functions ============

    /// @dev JSON first (pool scripts write `quote`, `token0`, `token1`), env second, clear revert last.
    function _policyInputs() internal view returns (address quote, address[] memory tokens, uint256 cap) {
        quote = _has("quote") ? _readAddress("quote") : vm.envOr("QUOTE", address(0));
        require(quote != address(0), "IssueAgent: quote missing (pool JSON key `quote` or env QUOTE)");

        tokens = new address[](2);
        tokens[0] = _has("token0") ? _readAddress("token0") : vm.envOr("TOKEN0", address(0));
        tokens[1] = _has("token1") ? _readAddress("token1") : vm.envOr("TOKEN1", address(0));
        require(
            tokens[0] != address(0) && tokens[1] != address(0),
            "IssueAgent: token0/token1 missing (run the pool scripts first or set TOKEN0/TOKEN1)"
        );

        cap = vm.envOr("DAILY_CAP", DEFAULT_CAP);
    }
}
