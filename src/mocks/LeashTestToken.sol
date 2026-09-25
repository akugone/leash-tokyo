// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LeashTestToken
/// @notice 18 decimals ERC20 with an open `mint`, used by the Sepolia demo pool only.
contract LeashTestToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    // ============ External functions ============

    /// @notice Mint `amount` to `to`. No access control: demo token.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
