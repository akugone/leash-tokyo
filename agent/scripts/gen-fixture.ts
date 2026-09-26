/**
 * Deterministic EIP-712 fixture shared with `test/LeashIntentFixture.t.sol`.
 * Run: `cd agent && bun run scripts/gen-fixture.ts`
 */
import { keccak256, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  domainSeparator,
  encodeHookData,
  hashIntent,
  intentDigest,
  leashDomain,
  namehash,
  signIntent,
  type SwapIntent,
} from "../src/intent.ts";

// anvil account #0
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const CHAIN_ID = 11155111;
const VERIFYING_CONTRACT: Address = "0x1000000000000000000000000000000000000001";
const LABEL = "trader-1";
const NAME = `${LABEL}.leash.eth`;

const intent: SwapIntent = {
  node: namehash(NAME),
  poolId: keccak256(toHex("pool")),
  zeroForOne: true,
  amountSpecified: -1_000_000_000_000_000_000n,
  nonce: 0n,
  deadline: 1_800_000_000n,
};

const account = privateKeyToAccount(PRIVATE_KEY);
const domain = leashDomain(CHAIN_ID, VERIFYING_CONTRACT);
const signature = await signIntent(account, domain, intent);

const fixture = {
  name: NAME,
  label: LABEL,
  signer: account.address,
  chainId: String(CHAIN_ID),
  verifyingContract: VERIFYING_CONTRACT,
  domainSeparator: domainSeparator(domain),
  structHash: hashIntent(intent),
  digest: intentDigest(domain, intent),
  signature,
  intent: {
    node: intent.node,
    poolId: intent.poolId,
    zeroForOne: intent.zeroForOne,
    amountSpecified: intent.amountSpecified.toString(),
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
  },
  hookData: encodeHookData(LABEL, intent, signature),
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../test/fixtures/intent.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(JSON.stringify(fixture, null, 2));
