/**
 * Leash demo agent (ticket L-16).
 *
 *   bun run src/bot.ts [--once] [--misbehave] [--amount <wei>] [--label trader-1] [--interval 15]
 *
 * Every tick: read the policy from the hook, pick an amount, sign a `SwapIntent`, swap through
 * Uniswap v4 `PoolSwapTest`. Reverts are simulated first and printed with the decoded hook error.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ERC20_ABI, LEASH_HOOK_ABI, POOL_SWAP_TEST_ABI } from "./abi.ts";
import { decodeRevertData, explainRevert, revertDataFromError } from "./errors.ts";
import { encodeHookData, leashDomain, namehash, signIntent, type SwapIntent } from "./intent.ts";

// ============ Constants ============

/** `SepoliaAddresses.UNI_POOL_SWAP_TEST` in script/Addresses.sol. */
export const POOL_SWAP_TEST: Address = "0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe";
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const INTENT_TTL_SECONDS = 300n;
/** `--force` without `--amount`: 1e18 wei of the quote token. */
export const FORCE_DEFAULT_AMOUNT = 1_000_000_000_000_000_000n;

// ============ Types ============

export type Deployments = {
  chainId: string;
  parentName: string;
  agentLabel: string;
  hook: Address;
  poolId: Hex;
  token0: Address;
  token1: Address;
  quote: Address;
  fee: string;
  tickSpacing: string;
};

export type Policy = {
  agent: Address;
  quote: Address;
  cap: bigint;
  tokens: readonly Address[];
  expiry: bigint;
};

export type Options = {
  once: boolean;
  misbehave: boolean;
  /** Send even when the policy read reverts or nothing is left today, so the on chain rejection is visible. */
  force: boolean;
  amount?: bigint;
  label?: string;
  interval: number;
};

// ============ Pure helpers (unit tested) ============

/**
 * Amount to request as exact input of the quote token.
 * Honest mode: min(requested or 10% of cap, remaining). Misbehave mode: remaining + 1, or cap + 1 when
 * nothing is left today, so the hook must answer `DailyCapExceeded`. Force mode: exactly `--amount`
 * (default 1e18), never clamped, so the hook's own revert reaches the chain.
 */
export function chooseAmount(
  cap: bigint,
  remaining: bigint,
  opts: Pick<Options, "misbehave" | "amount"> & Partial<Pick<Options, "force">>,
): bigint {
  if (opts.force) return opts.amount ?? FORCE_DEFAULT_AMOUNT;
  if (opts.misbehave) return remaining > 0n ? remaining + 1n : cap + 1n;
  const wanted = opts.amount ?? cap / 10n;
  return wanted < remaining ? wanted : remaining;
}

export function parseCliArgs(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      once: { type: "boolean", default: false },
      misbehave: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      amount: { type: "string" },
      label: { type: "string" },
      interval: { type: "string", default: "15" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      "usage: bun run src/bot.ts [--once] [--misbehave] [--force] [--amount <wei>] [--label trader-1] [--interval 15]",
    );
    process.exit(0);
  }
  const interval = Number(values.interval);
  if (!Number.isFinite(interval) || interval < 0) throw new Error(`bad --interval ${values.interval}`);
  return {
    once: values.once,
    misbehave: values.misbehave,
    force: values.force,
    amount: values.amount === undefined ? undefined : BigInt(values.amount),
    label: values.label,
    interval,
  };
}

/** Resolve `LEASH_DEPLOYMENTS_FILE`: absolute, or relative to cwd, or relative to the repo root. */
export function resolveDeploymentsPath(file: string | undefined, agentDir: string): string {
  const candidate = file ?? "../deployments/anvil.json";
  if (isAbsolute(candidate)) return candidate;
  const fromCwd = resolve(process.cwd(), candidate);
  if (existsSync(fromCwd)) return fromCwd;
  const fromAgent = resolve(agentDir, candidate);
  if (existsSync(fromAgent)) return fromAgent;
  // `deployments/anvil.json` style paths written for the Forge scripts, relative to the repo root.
  return resolve(agentDir, "..", candidate);
}

export function loadDeployments(path: string): Deployments {
  if (!existsSync(path)) throw new Error(`deployments file not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  const required = [
    "chainId",
    "parentName",
    "agentLabel",
    "hook",
    "poolId",
    "token0",
    "token1",
    "quote",
    "fee",
    "tickSpacing",
  ];
  for (const key of required) {
    if (!raw[key]) throw new Error(`deployments file ${path} is missing "${key}"`);
  }
  return raw as unknown as Deployments;
}

// ============ Main loop ============

async function main(): Promise<void> {
  const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await loadDotenv(agentDir);

  const opts = parseCliArgs(process.argv.slice(2));
  const rpcUrl = process.env.RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? "http://127.0.0.1:8545";
  const agentPk = process.env.AGENT_PK as Hex | undefined;
  if (!agentPk) throw new Error("AGENT_PK is not set");

  const deploymentsPath = resolveDeploymentsPath(process.env.LEASH_DEPLOYMENTS_FILE, agentDir);
  const account = privateKeyToAccount(agentPk);
  console.log(`agent ${account.address} | rpc ${rpcUrl} | deployments ${deploymentsPath}`);

  for (;;) {
    const deployments = loadDeployments(deploymentsPath);
    const chainId = Number(deployments.chainId);
    const chain = chainId === sepolia.id ? sepolia : defineChain({ ...sepolia, id: chainId, name: `chain-${chainId}` });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

    try {
      await tick({ publicClient, walletClient, account, deployments, opts });
    } catch (err) {
      console.error(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (opts.once) break;
    await sleep(opts.interval * 1000);
  }
}

/** Last nonce successfully read per node, the `--force` fallback when `nonces(node)` itself reverts. */
const lastKnownNonce = new Map<Hex, bigint>();

type TickContext = {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  deployments: Deployments;
  opts: Options;
};

async function tick({ publicClient, walletClient, account, deployments, opts }: TickContext): Promise<void> {
  const label = opts.label ?? deployments.agentLabel;
  const fullName = `${label}.${deployments.parentName}`;
  const node = namehash(fullName);
  const hook = deployments.hook;
  const ctx = { label, parentName: deployments.parentName };

  // ---- read policy ----
  const read = <T>(fn: "policy" | "remainingToday" | "nonces", args: readonly [string] | readonly [Hex]) =>
    publicClient.readContract({ address: hook, abi: LEASH_HOOK_ABI, functionName: fn, args } as never) as Promise<T>;
  const [policyRes, remainingRes, nonceRes] = await Promise.allSettled([
    read<readonly [Address, Address, bigint, readonly Address[], bigint]>("policy", [label]),
    read<bigint>("remainingToday", [label]),
    read<bigint>("nonces", [node]),
  ]);

  let policy: Policy | undefined;
  if (policyRes.status === "fulfilled") {
    const p = policyRes.value;
    policy = { agent: p[0], quote: p[1], cap: p[2], tokens: p[3], expiry: p[4] };
  } else {
    const data = revertDataFromError(policyRes.reason);
    if (!data) throw policyRes.reason;
    console.log(`[${now()}] ${fullName} policy read reverted: ${explainRevert(decodeRevertData(data), ctx)}`);
    if (!opts.force) return;
    console.log("  --force: sending anyway so the hook rejects it on chain");
  }
  if (remainingRes.status === "rejected" && !opts.force) throw remainingRes.reason;
  const remaining = remainingRes.status === "fulfilled" ? remainingRes.value : 0n;

  let nonce: bigint;
  if (nonceRes.status === "fulfilled") {
    nonce = nonceRes.value;
    lastKnownNonce.set(node, nonce);
  } else {
    if (!opts.force) throw nonceRes.reason;
    nonce = lastKnownNonce.get(node) ?? 0n;
    console.log(`  nonces(node) read failed, using last known nonce ${nonce}`);
  }

  // With no readable policy (revoked name) the quote falls back to the deployments record.
  const quote = policy?.quote ?? deployments.quote;
  const quoteIsToken0 = quote.toLowerCase() === deployments.token0.toLowerCase();
  const quoteMeta = await tokenMeta(publicClient, quote);
  const fmt = (v: bigint) => `${formatUnits(v, quoteMeta.decimals)} ${quoteMeta.symbol}`;
  if (policy) {
    const expiry = Number(policy.expiry);
    const expiryText = expiry === 0 ? "revoked" : `expires ${new Date(expiry * 1000).toISOString()}`;
    console.log(
      `[${now()}] ${fullName} agent=${policy.agent} cap=${fmt(policy.cap)} remaining=${fmt(remaining)} nonce=${nonce} ${expiryText}`,
    );
    if (policy.agent.toLowerCase() !== account.address.toLowerCase()) {
      console.log(`  warning: addr record ${policy.agent} is not this signer ${account.address}, expect BadSignature`);
    }
  }

  // ---- build and sign intent ----
  const amount = chooseAmount(policy?.cap ?? 0n, remaining, opts);
  if (amount <= 0n) {
    console.log("  nothing left to spend today, skipping (use --force to send anyway)");
    return;
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + INTENT_TTL_SECONDS;
  const intent: SwapIntent = {
    node,
    poolId: deployments.poolId,
    zeroForOne: quoteIsToken0,
    amountSpecified: -amount,
    nonce,
    deadline,
  };
  const chainId = await publicClient.getChainId();
  const signature = await signIntent(account, leashDomain(chainId, hook), intent);
  const hookData = encodeHookData(label, intent, signature);
  console.log(
    `  ${opts.force ? "FORCE " : opts.misbehave ? "MISBEHAVE " : ""}swap ${fmt(amount)} exact in, ${quoteIsToken0 ? "0->1" : "1->0"}, deadline ${deadline}`,
  );

  // ---- allowance for PoolSwapTest ----
  await ensureAllowance(publicClient, walletClient, account.address, quote, amount, quoteMeta.symbol);

  // ---- simulate then send ----
  const swapArgs = [
    {
      currency0: deployments.token0,
      currency1: deployments.token1,
      fee: Number(deployments.fee),
      tickSpacing: Number(deployments.tickSpacing),
      hooks: hook,
    },
    {
      zeroForOne: intent.zeroForOne,
      amountSpecified: intent.amountSpecified,
      sqrtPriceLimitX96: intent.zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
    },
    { takeClaims: false, settleUsingBurn: false },
    hookData,
  ] as const;

  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      address: POOL_SWAP_TEST,
      abi: POOL_SWAP_TEST_ABI,
      functionName: "swap",
      args: swapArgs,
      account,
    }));
  } catch (err) {
    const data = revertDataFromError(err);
    if (!data) throw err;
    console.log(`  REVERT ${explainRevert(decodeRevertData(data), ctx)}`);
    return;
  }

  const hash = await walletClient.writeContract(request);
  console.log(`  sent ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.log(`  tx ${hash} reverted on chain (block ${receipt.blockNumber})`);
    return;
  }
  const spent = await publicClient.readContract({
    address: hook,
    abi: LEASH_HOOK_ABI,
    functionName: "spentToday",
    args: [node],
  });
  console.log(`  OK block ${receipt.blockNumber}, spent today ${fmt(spent)}${policy ? ` of ${fmt(policy.cap)}` : ""}`);
}

// ============ Chain helpers ============

export async function tokenMeta(
  client: TickContext["publicClient"],
  token: Address,
): Promise<{ decimals: number; symbol: string }> {
  try {
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
    ]);
    return { decimals, symbol };
  } catch {
    return { decimals: 18, symbol: "wei" };
  }
}

export async function ensureAllowance(
  publicClient: TickContext["publicClient"],
  walletClient: TickContext["walletClient"],
  owner: Address,
  token: Address,
  amount: bigint,
  symbol: string,
): Promise<void> {
  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, POOL_SWAP_TEST],
  });
  if (allowance >= amount) return;
  console.log(`  approving PoolSwapTest to spend ${symbol}`);
  const hash = await walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [POOL_SWAP_TEST, maxUint256],
    account: walletClient.account!,
    chain: walletClient.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function loadDotenv(agentDir: string): Promise<void> {
  try {
    const { config } = await import("dotenv");
    // agent/.env first, then the repo root .env used by the Forge scripts.
    config({ path: resolve(agentDir, ".env") });
    config({ path: resolve(agentDir, "..", ".env") });
  } catch {
    // dotenv is optional
  }
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
