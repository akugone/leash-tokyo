// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {LeashIntentLib, SwapIntent} from "../src/libraries/LeashIntentLib.sol";
import {EnsNameLib} from "../src/libraries/EnsNameLib.sol";

/// @notice Cross language conformance test: the fixture is produced by viem in `agent/scripts/gen-fixture.ts`.
///         Every hash and the full `hookData` must match byte for byte (ticket L-09).
contract LeashIntentFixtureTest is Test {
    string internal constant FIXTURE_PATH = "test/fixtures/intent.json";

    string internal json;
    address internal signer;
    address internal verifyingContract;
    string internal label;
    SwapIntent internal intent;
    bytes internal signature;

    function setUp() public {
        json = vm.readFile(FIXTURE_PATH);
        vm.chainId(vm.parseUint(vm.parseJsonString(json, ".chainId")));

        signer = vm.parseJsonAddress(json, ".signer");
        verifyingContract = vm.parseJsonAddress(json, ".verifyingContract");
        label = vm.parseJsonString(json, ".label");
        signature = vm.parseJsonBytes(json, ".signature");

        intent = SwapIntent({
            node: vm.parseJsonBytes32(json, ".intent.node"),
            poolId: vm.parseJsonBytes32(json, ".intent.poolId"),
            zeroForOne: vm.parseJsonBool(json, ".intent.zeroForOne"),
            amountSpecified: vm.parseInt(vm.parseJsonString(json, ".intent.amountSpecified")),
            nonce: vm.parseUint(vm.parseJsonString(json, ".intent.nonce")),
            deadline: vm.parseUint(vm.parseJsonString(json, ".intent.deadline"))
        });

        vm.label(signer, "signer");
        vm.label(verifyingContract, "verifyingContract");
    }

    // ============ Fixture sanity Tests ============

    function test_Fixture_ChainIdIsSepolia() public view {
        assertEq(block.chainid, 11_155_111);
    }

    function test_Fixture_NodeIsNamehashOfName() public view {
        assertEq(intent.node, EnsNameLib.namehash(vm.parseJsonString(json, ".name")));
        assertEq(intent.node, EnsNameLib.childNode(EnsNameLib.namehash("leashdemo.eth"), label));
    }

    // ============ domainSeparator Tests ============

    function test_DomainSeparator_MatchesViem() public view {
        assertEq(LeashIntentLib.domainSeparator(verifyingContract), vm.parseJsonBytes32(json, ".domainSeparator"));
    }

    // ============ hashIntent Tests ============

    function test_HashIntent_MatchesViem() public view {
        assertEq(LeashIntentLib.hashIntent(intent), vm.parseJsonBytes32(json, ".structHash"));
    }

    // ============ digest Tests ============

    function test_Digest_MatchesViem() public view {
        bytes32 separator = LeashIntentLib.domainSeparator(verifyingContract);
        assertEq(LeashIntentLib.digest(separator, intent), vm.parseJsonBytes32(json, ".digest"));
    }

    function test_Digest_RecoversSigner() public view {
        bytes32 digest = LeashIntentLib.digest(LeashIntentLib.domainSeparator(verifyingContract), intent);
        assertEq(ECDSA.recover(digest, signature), signer);
    }

    function test_Digest_MatchesVmSign() public view {
        // anvil account #0, the key gen-fixture.ts signs with.
        uint256 pk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        assertEq(vm.addr(pk), signer);
        bytes32 digest = LeashIntentLib.digest(LeashIntentLib.domainSeparator(verifyingContract), intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        assertEq(abi.encodePacked(r, s, v), signature);
    }

    // ============ encodeHookData Tests ============

    function test_EncodeHookData_MatchesViem() public view {
        bytes memory expected = vm.parseJsonBytes(json, ".hookData");
        assertEq(LeashIntentLib.encodeHookData(label, intent, signature), expected);
    }

    // ============ decodeHookData Tests ============

    function test_DecodeHookData_RoundTripsFixture() public view {
        bytes memory hookData = vm.parseJsonBytes(json, ".hookData");
        (string memory decodedLabel, SwapIntent memory decodedIntent, bytes memory decodedSig) =
            LeashIntentLib.decodeHookData(hookData);

        assertEq(decodedLabel, label);
        assertEq(decodedIntent.node, intent.node);
        assertEq(decodedIntent.poolId, intent.poolId);
        assertEq(decodedIntent.zeroForOne, intent.zeroForOne);
        assertEq(decodedIntent.amountSpecified, intent.amountSpecified);
        assertEq(decodedIntent.nonce, intent.nonce);
        assertEq(decodedIntent.deadline, intent.deadline);
        assertEq(decodedSig, signature);
    }
}
