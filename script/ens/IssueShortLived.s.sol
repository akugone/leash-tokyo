// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IssueAgent} from "./IssueAgent.s.sol";

/// @notice Issue a short-lived agent subname to demo natural expiry (ticket L-06).
/// @dev Same policy inputs as `IssueAgent`. Label from env `SHORT_LABEL` (default `trader-2`), expiry in
///      `SHORT_TTL` seconds (default 180). Equivalent to `IssueAgent --sig "issue(string,uint64)" trader-2 180`.
contract IssueShortLived is IssueAgent {
    uint256 internal constant SHORT_TTL = 3 minutes;

    // ============ External functions ============

    function run() external override {
        issue(vm.envOr("SHORT_LABEL", string("trader-2")), uint64(vm.envOr("SHORT_TTL", SHORT_TTL)));
    }
}
