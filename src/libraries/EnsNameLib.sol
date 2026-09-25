// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Name hashing and DNS encoding helpers shared by the hook, the scripts and the tests.
library EnsNameLib {
    error EmptyLabel();
    error LabelTooLong(string label);

    /// @notice `uint256(keccak256(label))`, the `anyId` the registry expects for a label.
    function labelId(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    /// @notice ENS node of `label` under `parentNode`.
    function childNode(bytes32 parentNode, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    /// @notice DNS-encode `label` in front of an already DNS-encoded `parentName`.
    /// @dev `dnsEncode("trader-1", dnsEncodeName("acme.eth"))` == `\x08trader-1\x04acme\x03eth\x00`.
    function dnsEncode(string memory label, bytes memory parentName) internal pure returns (bytes memory) {
        uint256 len = bytes(label).length;
        if (len == 0) revert EmptyLabel();
        if (len > 255) revert LabelTooLong(label);
        return abi.encodePacked(uint8(len), label, parentName);
    }

    /// @notice DNS-encode a dotted name such as `acme.eth`.
    function dnsEncodeName(string memory name) internal pure returns (bytes memory out) {
        bytes memory b = bytes(name);
        uint256 start = 0;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ".") {
                uint256 len = i - start;
                if (len == 0) revert EmptyLabel();
                if (len > 255) revert LabelTooLong(name);
                bytes memory label = new bytes(len);
                for (uint256 j = 0; j < len; j++) {
                    label[j] = b[start + j];
                }
                out = abi.encodePacked(out, uint8(len), label);
                start = i + 1;
            }
        }
        out = abi.encodePacked(out, uint8(0));
    }

    /// @notice ENS namehash of a dotted name such as `trader-1.acme.eth`.
    function namehash(string memory name) internal pure returns (bytes32 node) {
        bytes memory b = bytes(name);
        if (b.length == 0) return bytes32(0);
        uint256 end = b.length;
        // Walk labels from the right so the root is hashed first.
        while (true) {
            uint256 start = end;
            while (start > 0 && b[start - 1] != ".") {
                start--;
            }
            uint256 len = end - start;
            if (len == 0) revert EmptyLabel();
            bytes memory label = new bytes(len);
            for (uint256 j = 0; j < len; j++) {
                label[j] = b[start + j];
            }
            node = keccak256(abi.encodePacked(node, keccak256(label)));
            if (start == 0) break;
            end = start - 1;
        }
    }
}
