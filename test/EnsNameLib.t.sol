// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {EnsNameLib} from "../src/libraries/EnsNameLib.sol";

contract EnsNameLibTest is Test {
    // ============ labelId Tests ============

    function test_LabelId() public pure {
        assertEq(EnsNameLib.labelId("eth"), uint256(keccak256("eth")));
    }

    // ============ childNode Tests ============

    function test_ChildNode_MatchesNamehash() public pure {
        bytes32 parent = EnsNameLib.namehash("leash.eth");
        assertEq(EnsNameLib.childNode(parent, "trader-1"), EnsNameLib.namehash("trader-1.leash.eth"));
    }

    // ============ dnsEncode Tests ============

    function test_DnsEncode() public pure {
        bytes memory parent = EnsNameLib.dnsEncodeName("leash.eth");
        assertEq(parent, hex"05" hex"6c65617368" hex"03" hex"657468" hex"00");
        assertEq(
            EnsNameLib.dnsEncode("trader-1", parent),
            hex"08" hex"7472616465722d31" hex"05" hex"6c65617368" hex"03" hex"657468" hex"00"
        );
    }

    function test_DnsEncodeName_MatchesDnsEncode() public pure {
        assertEq(
            EnsNameLib.dnsEncodeName("trader-1.leash.eth"),
            EnsNameLib.dnsEncode("trader-1", EnsNameLib.dnsEncodeName("leash.eth"))
        );
    }

    function test_RevertWhen_DnsEncode_EmptyLabel() public {
        vm.expectRevert(EnsNameLib.EmptyLabel.selector);
        this.dnsEncodeExternal("", hex"00");
    }

    function test_RevertWhen_DnsEncodeName_EmptyLabel() public {
        vm.expectRevert(EnsNameLib.EmptyLabel.selector);
        this.dnsEncodeNameExternal("leash..eth");
    }

    // ============ namehash Tests ============

    function test_Namehash_KnownVectors() public pure {
        // Vectors from EIP-137.
        assertEq(EnsNameLib.namehash(""), bytes32(0));
        assertEq(EnsNameLib.namehash("eth"), 0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae);
        assertEq(EnsNameLib.namehash("foo.eth"), 0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f);
    }

    function testFuzz_Namehash_ChildOfParent(string memory label) public pure {
        vm.assume(bytes(label).length > 0 && bytes(label).length < 64);
        for (uint256 i = 0; i < bytes(label).length; i++) {
            vm.assume(bytes(label)[i] != ".");
        }
        bytes32 parent = EnsNameLib.namehash("leash.eth");
        assertEq(
            EnsNameLib.namehash(string.concat(label, ".leash.eth")),
            keccak256(abi.encodePacked(parent, keccak256(bytes(label))))
        );
    }

    // ============ Helpers ============

    function dnsEncodeExternal(string memory label, bytes memory parent) external pure returns (bytes memory) {
        return EnsNameLib.dnsEncode(label, parent);
    }

    function dnsEncodeNameExternal(string memory name) external pure returns (bytes memory) {
        return EnsNameLib.dnsEncodeName(name);
    }
}
