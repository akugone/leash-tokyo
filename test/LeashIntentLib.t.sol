// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {LeashIntentLib, SwapIntent} from "../src/libraries/LeashIntentLib.sol";

contract LeashIntentLibTest is Test {
    address internal verifyingContract = address(0xBEEF);

    function setUp() public {
        vm.label(verifyingContract, "verifyingContract");
    }

    // ============ Test helpers ============

    function _baseIntent() internal pure returns (SwapIntent memory) {
        return SwapIntent({
            node: bytes32(uint256(1)),
            poolId: bytes32(uint256(2)),
            zeroForOne: true,
            amountSpecified: int256(100),
            nonce: 1,
            deadline: 1000
        });
    }

    // ============ SWAP_INTENT_TYPEHASH Tests ============

    function test_SwapIntentTypehash_MatchesTypeString() public pure {
        assertEq(
            LeashIntentLib.SWAP_INTENT_TYPEHASH,
            keccak256(
                "SwapIntent(bytes32 node,bytes32 poolId,bool zeroForOne,int256 amountSpecified,uint256 nonce,uint256 deadline)"
            )
        );
    }

    // ============ domainSeparator Tests ============

    function test_DomainSeparator_MatchesManualComputation() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Leash")),
                keccak256(bytes("1")),
                block.chainid,
                verifyingContract
            )
        );
        assertEq(LeashIntentLib.domainSeparator(verifyingContract), expected);
    }

    function test_DomainSeparator_ChangesWithChainId() public {
        bytes32 before = LeashIntentLib.domainSeparator(verifyingContract);
        vm.chainId(block.chainid + 1);
        bytes32 afterChainChange = LeashIntentLib.domainSeparator(verifyingContract);
        assertTrue(before != afterChainChange);
    }

    // ============ hashIntent Tests ============

    function test_HashIntent_ChangesWithAnyField() public pure {
        // NOTE: `SwapIntent memory x = base;` aliases the same memory struct in Solidity rather than copying it,
        // so each variant below is built from scratch with an explicit struct literal to keep the fields isolated.
        bytes32 baseHash = LeashIntentLib.hashIntent(_baseIntent());

        SwapIntent memory changedNode = _baseIntent();
        changedNode.node = bytes32(uint256(999));
        assertTrue(LeashIntentLib.hashIntent(changedNode) != baseHash);

        SwapIntent memory changedPoolId = _baseIntent();
        changedPoolId.poolId = bytes32(uint256(999));
        assertTrue(LeashIntentLib.hashIntent(changedPoolId) != baseHash);

        SwapIntent memory changedZeroForOne = _baseIntent();
        changedZeroForOne.zeroForOne = false;
        assertTrue(LeashIntentLib.hashIntent(changedZeroForOne) != baseHash);

        SwapIntent memory changedAmount = _baseIntent();
        changedAmount.amountSpecified = int256(-100);
        assertTrue(LeashIntentLib.hashIntent(changedAmount) != baseHash);

        SwapIntent memory changedNonce = _baseIntent();
        changedNonce.nonce = 999;
        assertTrue(LeashIntentLib.hashIntent(changedNonce) != baseHash);

        SwapIntent memory changedDeadline = _baseIntent();
        changedDeadline.deadline = 999;
        assertTrue(LeashIntentLib.hashIntent(changedDeadline) != baseHash);
    }

    // ============ digest Tests ============

    function test_Digest_SignAndRecover() public view {
        uint256 pk = 0xA11CE;
        address signer = vm.addr(pk);

        SwapIntent memory intent = _baseIntent();

        bytes32 domain = LeashIntentLib.domainSeparator(verifyingContract);
        bytes32 d = LeashIntentLib.digest(domain, intent);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        address recovered = ECDSA.recover(d, abi.encodePacked(r, s, v));

        assertEq(recovered, signer);
    }

    function test_Digest_SignatureOverDifferentIntentDoesNotRecoverToSigner() public view {
        uint256 pk = 0xA11CE;
        address signer = vm.addr(pk);

        SwapIntent memory intentA = _baseIntent();
        SwapIntent memory intentB = SwapIntent({
            node: intentA.node,
            poolId: intentA.poolId,
            zeroForOne: intentA.zeroForOne,
            amountSpecified: intentA.amountSpecified,
            nonce: 2,
            deadline: intentA.deadline
        });

        bytes32 domain = LeashIntentLib.domainSeparator(verifyingContract);
        bytes32 digestA = LeashIntentLib.digest(domain, intentA);
        bytes32 digestB = LeashIntentLib.digest(domain, intentB);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digestA);
        address recovered = ECDSA.recover(digestB, abi.encodePacked(r, s, v));

        assertTrue(recovered != signer);
    }

    // ============ encodeHookData / decodeHookData Tests ============

    function test_EncodeDecodeHookData_RoundTrip() public pure {
        string memory label = "agent-42.acme.eth";
        SwapIntent memory intent = SwapIntent({
            node: bytes32(uint256(0xABCDEF)),
            poolId: bytes32(uint256(0x123456)),
            zeroForOne: false,
            amountSpecified: int256(-500),
            nonce: 7,
            deadline: 123_456_789
        });
        bytes memory signature = new bytes(65);
        for (uint256 i = 0; i < 65; i++) {
            signature[i] = bytes1(uint8(i + 1));
        }

        bytes memory hookData = LeashIntentLib.encodeHookData(label, intent, signature);
        (string memory decodedLabel, SwapIntent memory decodedIntent, bytes memory decodedSignature) =
            LeashIntentLib.decodeHookData(hookData);

        assertEq(decodedLabel, label);
        assertEq(decodedIntent.node, intent.node);
        assertEq(decodedIntent.poolId, intent.poolId);
        assertEq(decodedIntent.zeroForOne, intent.zeroForOne);
        assertEq(decodedIntent.amountSpecified, intent.amountSpecified);
        assertEq(decodedIntent.nonce, intent.nonce);
        assertEq(decodedIntent.deadline, intent.deadline);
        assertEq(decodedSignature, signature);
    }

    function testFuzz_EncodeDecodeHookData_RoundTrip(
        string memory label,
        bytes32 node,
        bytes32 poolId,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 nonce,
        uint256 deadline,
        bytes memory signature
    ) public pure {
        SwapIntent memory intent = SwapIntent({
            node: node,
            poolId: poolId,
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            nonce: nonce,
            deadline: deadline
        });

        bytes memory hookData = LeashIntentLib.encodeHookData(label, intent, signature);
        (string memory decodedLabel, SwapIntent memory decodedIntent, bytes memory decodedSignature) =
            LeashIntentLib.decodeHookData(hookData);

        assertEq(decodedLabel, label);
        assertEq(decodedIntent.node, node);
        assertEq(decodedIntent.poolId, poolId);
        assertEq(decodedIntent.zeroForOne, zeroForOne);
        assertEq(decodedIntent.amountSpecified, amountSpecified);
        assertEq(decodedIntent.nonce, nonce);
        assertEq(decodedIntent.deadline, deadline);
        assertEq(decodedSignature, signature);
    }

    function test_RevertWhen_DecodeHookData_Garbage() public {
        vm.expectRevert();
        this.decodeHookDataExternal(hex"deadbeef");
    }

    // ============ Helpers ============

    function decodeHookDataExternal(bytes memory hookData)
        external
        pure
        returns (string memory, SwapIntent memory, bytes memory)
    {
        return LeashIntentLib.decodeHookData(hookData);
    }
}
