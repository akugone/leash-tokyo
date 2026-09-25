import {
  encodeAbiParameters,
  hashDomain,
  hashStruct,
  hashTypedData,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { namehash as viemNamehash, packetToBytes } from "viem/ens";

/**
 * Mirror of `LeashIntentLib.SwapIntent`. Field order matters: it is the EIP-712 struct
 * and the ABI tuple layout used inside `hookData`.
 */
export type SwapIntent = {
  node: Hex;
  poolId: Hex;
  zeroForOne: boolean;
  amountSpecified: bigint;
  nonce: bigint;
  deadline: bigint;
};

/** EIP-712 types for `SwapIntent`. The type string hashes to `LeashIntentLib.SWAP_INTENT_TYPEHASH`. */
export const SWAP_INTENT_TYPES = {
  SwapIntent: [
    { name: "node", type: "bytes32" },
    { name: "poolId", type: "bytes32" },
    { name: "zeroForOne", type: "bool" },
    { name: "amountSpecified", type: "int256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const SWAP_INTENT_PRIMARY_TYPE = "SwapIntent" as const;

export type LeashDomain = {
  name: "Leash";
  version: "1";
  chainId: number;
  verifyingContract: Address;
};

/** Domain of `LeashIntentLib.domainSeparator(hook)` on `chainId`. */
export function leashDomain(chainId: number, hook: Address): LeashDomain {
  return { name: "Leash", version: "1", chainId, verifyingContract: hook };
}

/** `keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, name, version, chainId, verifyingContract))`. */
export function domainSeparator(domain: LeashDomain): Hex {
  return hashDomain({
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: { EIP712Domain: eip712DomainType },
  });
}

/** `LeashIntentLib.hashIntent(intent)`. */
export function hashIntent(intent: SwapIntent): Hex {
  return hashStruct({ data: intent, primaryType: SWAP_INTENT_PRIMARY_TYPE, types: SWAP_INTENT_TYPES });
}

/** `LeashIntentLib.digest(domainSeparator, intent)`: `keccak256("\x19\x01" || domainSeparator || hashIntent)`. */
export function intentDigest(domain: LeashDomain, intent: SwapIntent): Hex {
  return hashTypedData({
    domain,
    types: SWAP_INTENT_TYPES,
    primaryType: SWAP_INTENT_PRIMARY_TYPE,
    message: intent,
  });
}

/** Sign `intent` with a local account. Returns the 65 byte `r || s || v` signature the hook expects. */
export async function signIntent(account: PrivateKeyAccount, domain: LeashDomain, intent: SwapIntent): Promise<Hex> {
  return account.signTypedData({
    domain,
    types: SWAP_INTENT_TYPES,
    primaryType: SWAP_INTENT_PRIMARY_TYPE,
    message: intent,
  });
}

/** ABI parameters of `abi.encode(string label, SwapIntent intent, bytes signature)`. */
export const HOOK_DATA_PARAMS = [
  { name: "label", type: "string" },
  {
    name: "intent",
    type: "tuple",
    components: [
      { name: "node", type: "bytes32" },
      { name: "poolId", type: "bytes32" },
      { name: "zeroForOne", type: "bool" },
      { name: "amountSpecified", type: "int256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  { name: "signature", type: "bytes" },
] as const;

/** `LeashIntentLib.encodeHookData(label, intent, signature)`. */
export function encodeHookData(label: string, intent: SwapIntent, signature: Hex): Hex {
  return encodeAbiParameters(HOOK_DATA_PARAMS, [label, intent, signature]);
}

/** ENS namehash of a dotted name, e.g. `trader-1.leashdemo.eth`. Same as `EnsNameLib.namehash`. */
export function namehash(name: string): Hex {
  return viemNamehash(name);
}

/** `keccak256(bytes(label))`, the labelhash the registry uses as `anyId`. */
export function labelhash(label: string): Hex {
  return keccak256(toHex(label));
}

/** DNS wire encoding with trailing zero byte, e.g. `\x08trader-1\x09leashdemo\x03eth\x00`. */
export function dnsEncode(name: string): Hex {
  return toHex(packetToBytes(name));
}

const eip712DomainType = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;
