// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {LeashPolicyLib} from "../src/libraries/LeashPolicyLib.sol";

contract LeashPolicyLibTest is Test {
    // ============ Test helpers ============

    /// @dev Zero left pads `suffix` to `totalLen` hex characters (no `0x` prefix).
    function _padHex(string memory suffix, uint256 totalLen) internal pure returns (string memory) {
        bytes memory suffixBytes = bytes(suffix);
        require(suffixBytes.length <= totalLen, "suffix too long");
        bytes memory out = new bytes(totalLen);
        uint256 padLen = totalLen - suffixBytes.length;
        for (uint256 i = 0; i < padLen; i++) {
            out[i] = "0";
        }
        for (uint256 i = 0; i < suffixBytes.length; i++) {
            out[padLen + i] = suffixBytes[i];
        }
        return string(out);
    }

    /// @dev A string of `n` repeated `'1'` characters.
    function _repeatedOnes(uint256 n) internal pure returns (string memory) {
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = "1";
        }
        return string(out);
    }

    // ============ parseUint Tests ============

    function test_ParseUint_Zero() public pure {
        assertEq(LeashPolicyLib.parseUint("0", "k"), 0);
    }

    function test_ParseUint_One() public pure {
        assertEq(LeashPolicyLib.parseUint("1", "k"), 1);
    }

    function test_ParseUint_LargeValue() public pure {
        assertEq(LeashPolicyLib.parseUint("250000000000000000000", "k"), 250_000_000_000_000_000_000);
    }

    function test_ParseUint_MaxUint256() public pure {
        assertEq(LeashPolicyLib.parseUint(vm.toString(type(uint256).max), "k"), type(uint256).max);
    }

    function testFuzz_ParseUint_RoundTrip(uint256 x) public pure {
        assertEq(LeashPolicyLib.parseUint(vm.toString(x), "k"), x);
    }

    function test_RevertWhen_ParseUint_EmptyString() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseUintExternal("", "k");
    }

    function test_RevertWhen_ParseUint_LeadingPlus() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseUintExternal("+1", "k");
    }

    function test_RevertWhen_ParseUint_LeadingMinus() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseUintExternal("-1", "k");
    }

    function test_RevertWhen_ParseUint_InternalSpace() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseUintExternal("1 0", "k");
    }

    function test_RevertWhen_ParseUint_HexPrefix() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseUintExternal("0x10", "k");
    }

    function test_RevertWhen_ParseUint_Decimal() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseUintExternal("1.0", "k");
    }

    function test_RevertWhen_ParseUint_TooManyDigits() public {
        // 79 digits, one more than the 78 digit cap.
        string memory s = _repeatedOnes(79);
        assertEq(bytes(s).length, 79);
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseUintExternal(s, "k");
    }

    function test_RevertWhen_ParseUint_Overflow() public {
        // type(uint256).max + 1, as a decimal string.
        string memory s = "115792089237316195423570985008687907853269984665640564039457584007913129639936";
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseUintExternal(s, "k");
    }

    // ============ parseAddress Tests ============

    function test_ParseAddress_Lowercase() public pure {
        string memory s = string.concat("0x", _padHex("ff", 40));
        assertEq(LeashPolicyLib.parseAddress(s, "k"), address(0x00000000000000000000000000000000000000ff));
    }

    function test_ParseAddress_Uppercase() public pure {
        assertEq(
            LeashPolicyLib.parseAddress("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "k"),
            address(0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa)
        );
    }

    function test_ParseAddress_MixedChecksum() public pure {
        assertEq(
            LeashPolicyLib.parseAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "k"),
            address(0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045)
        );
    }

    function testFuzz_ParseAddress_RoundTrip(address a) public pure {
        assertEq(LeashPolicyLib.parseAddress(vm.toString(a), "k"), a);
    }

    function test_RevertWhen_ParseAddress_MissingPrefix() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressExternal("000000000000000000000000000000000000ff00", "k");
    }

    function test_RevertWhen_ParseAddress_TooShort() public {
        // 41 total chars: "0x" + 39 hex chars.
        string memory s = string.concat("0x", _padHex("ff", 39));
        assertEq(bytes(s).length, 41);
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressExternal(s, "k");
    }

    function test_RevertWhen_ParseAddress_TooLong() public {
        // 43 total chars: "0x" + 41 hex chars.
        string memory s = string.concat("0x", _padHex("ff0", 41));
        assertEq(bytes(s).length, 43);
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressExternal(s, "k");
    }

    function test_RevertWhen_ParseAddress_NonHexChar() public {
        string memory s = string.concat("0x", _padHex("zff", 40));
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressExternal(s, "k");
    }

    function test_ParseAddress_UppercaseXPrefixAccepted() public pure {
        string memory s = string.concat("0X", _padHex("ff", 40));
        assertEq(LeashPolicyLib.parseAddress(s, "k"), address(0x00000000000000000000000000000000000000ff));
    }

    // ============ parseAddressList Tests ============

    function test_ParseAddressList_Empty() public pure {
        address[] memory list = LeashPolicyLib.parseAddressList("", "k");
        assertEq(list.length, 0);
    }

    function test_ParseAddressList_Single() public pure {
        address[] memory list = LeashPolicyLib.parseAddressList("0x000000000000000000000000000000000000ff00", "k");
        assertEq(list.length, 1);
        assertEq(list[0], address(0x000000000000000000000000000000000000ff00));
    }

    function test_ParseAddressList_Three() public pure {
        address[] memory list = LeashPolicyLib.parseAddressList(
            string.concat(
                "0x0000000000000000000000000000000000000001",
                ",",
                "0x0000000000000000000000000000000000000002",
                ",",
                "0x0000000000000000000000000000000000000003"
            ),
            "k"
        );
        assertEq(list.length, 3);
        assertEq(list[0], address(0x0000000000000000000000000000000000000001));
        assertEq(list[1], address(0x0000000000000000000000000000000000000002));
        assertEq(list[2], address(0x0000000000000000000000000000000000000003));
    }

    function testFuzz_ParseAddressList_RoundTrip(address a0, address a1, address a2, address a3, address a4, uint8 n)
        public
        pure
    {
        n = uint8(bound(n, 1, 5));
        address[] memory expected = new address[](n);
        address[5] memory pool = [a0, a1, a2, a3, a4];
        string memory s;
        for (uint256 i = 0; i < n; i++) {
            expected[i] = pool[i];
            s = i == 0 ? vm.toString(pool[i]) : string.concat(s, ",", vm.toString(pool[i]));
        }
        address[] memory list = LeashPolicyLib.parseAddressList(s, "k");
        assertEq(list.length, expected.length);
        for (uint256 i = 0; i < n; i++) {
            assertEq(list[i], expected[i]);
        }
    }

    function test_RevertWhen_ParseAddressList_TrailingComma() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressListExternal("0x0000000000000000000000000000000000000001,", "k");
    }

    function test_RevertWhen_ParseAddressList_LeadingComma() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressListExternal(",0x0000000000000000000000000000000000000001", "k");
    }

    function test_RevertWhen_ParseAddressList_DoubleComma() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressListExternal(
            "0x0000000000000000000000000000000000000001,,0x0000000000000000000000000000000000000002", "k"
        );
    }

    function test_RevertWhen_ParseAddressList_SpaceAfterComma() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressListExternal(
            "0x0000000000000000000000000000000000000001, 0x0000000000000000000000000000000000000002", "k"
        );
    }

    function test_RevertWhen_ParseAddressList_InvalidItem() public {
        vm.expectRevert(abi.encodeWithSelector(LeashPolicyLib.InvalidRecord.selector, "k"));
        this.parseAddressListExternal(
            "0x0000000000000000000000000000000000000001,not-an-address-000000000000000000", "k"
        );
    }

    // ============ contains Tests ============

    function test_Contains_Found() public pure {
        address[] memory list = new address[](3);
        list[0] = address(0x1);
        list[1] = address(0x2);
        list[2] = address(0x3);
        assertTrue(LeashPolicyLib.contains(list, address(0x2)));
    }

    function test_Contains_NotFound() public pure {
        address[] memory list = new address[](2);
        list[0] = address(0x1);
        list[1] = address(0x2);
        assertFalse(LeashPolicyLib.contains(list, address(0x3)));
    }

    function test_Contains_EmptyList() public pure {
        address[] memory list = new address[](0);
        assertFalse(LeashPolicyLib.contains(list, address(0x1)));
    }

    // ============ Helpers ============

    function parseUintExternal(string memory s, string memory key) external pure returns (uint256) {
        return LeashPolicyLib.parseUint(s, key);
    }

    function parseAddressExternal(string memory s, string memory key) external pure returns (address) {
        return LeashPolicyLib.parseAddress(s, key);
    }

    function parseAddressListExternal(string memory s, string memory key) external pure returns (address[] memory) {
        return LeashPolicyLib.parseAddressList(s, key);
    }
}
