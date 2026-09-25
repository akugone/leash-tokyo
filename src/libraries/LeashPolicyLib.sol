// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Parsers for the human readable `leash.*` text records.
/// @dev Records are strings on purpose: the jury reads them in the ENS explorer. The hook pays the parsing.
///      Every malformed value reverts with `InvalidRecord(key)` so a misconfigured agent fails closed.
library LeashPolicyLib {
    error InvalidRecord(string key);

    /// @notice Parse a base 10 unsigned integer. No sign, no separators, no leading `+`.
    function parseUint(string memory s, string memory key) internal pure returns (uint256 value) {
        bytes memory b = bytes(s);
        if (b.length == 0 || b.length > 78) revert InvalidRecord(key);
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c < 48 || c > 57) revert InvalidRecord(key);
            uint256 digit = c - 48;
            if (value > (type(uint256).max - digit) / 10) revert InvalidRecord(key);
            value = value * 10 + digit;
        }
    }

    /// @notice Parse a `0x` prefixed, 40 nibble, case insensitive hex address.
    function parseAddress(string memory s, string memory key) internal pure returns (address) {
        bytes memory b = bytes(s);
        if (b.length != 42 || b[0] != "0" || (b[1] != "x" && b[1] != "X")) revert InvalidRecord(key);
        uint160 value;
        for (uint256 i = 2; i < 42; i++) {
            value = (value << 4) | uint160(_nibble(uint8(b[i]), key));
        }
        return address(value);
    }

    /// @notice Parse a comma separated address list with no spaces. Empty string means an empty list.
    function parseAddressList(string memory s, string memory key) internal pure returns (address[] memory list) {
        bytes memory b = bytes(s);
        if (b.length == 0) return list;
        // Each address is 42 chars, separated by single commas: n * 42 + (n - 1) == length.
        if ((b.length + 1) % 43 != 0) revert InvalidRecord(key);
        uint256 n = (b.length + 1) / 43;
        list = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 start = i * 43;
            if (i > 0 && b[start - 1] != ",") revert InvalidRecord(key);
            bytes memory item = new bytes(42);
            for (uint256 j = 0; j < 42; j++) {
                item[j] = b[start + j];
            }
            list[i] = parseAddress(string(item), key);
        }
    }

    /// @notice Linear membership test, lists are short.
    function contains(address[] memory list, address a) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == a) return true;
        }
        return false;
    }

    function _nibble(uint8 c, string memory key) private pure returns (uint8) {
        if (c >= 48 && c <= 57) return c - 48; // 0-9
        if (c >= 97 && c <= 102) return c - 87; // a-f
        if (c >= 65 && c <= 70) return c - 55; // A-F
        revert InvalidRecord(key);
    }
}
