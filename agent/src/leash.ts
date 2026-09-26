/**
 * Leash agent client: read the policy the hook enforces for a name, swap the org vault's tokens through
 * Uniswap v4 with a signed `SwapIntent`, and report every step to the dashboard's agent feed. Shared by the MCP server
 * (`mcp.ts`) and usable from any other agent runtime.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { LEASH_HOOK_ABI, LEASH_VAULT_ABI } from "./abi.ts";
import { chooseSlippage, priceLimitFor, slippageText, tokenMeta, vaultSwapArgs, type Deployments } from "./bot.ts";
import { decodeRevertData, explainRevert, revertDataFromError } from "./errors.ts";
import { encodeHookData, leashDomain, namehash, signIntent, type SwapIntent } from "./intent.ts";

const INTENT_TTL_SECONDS = 300n;

// ============ Types ============

export type AgentEventKind = "policy" | "intent" | "sent" | "ok" | "revert" | "skip" | "error";

export type AgentEvent = {
  kind: AgentEventKind;
  text: string;
  name: string;
  /** Human amounts in quote token units when relevant. */
  amount?: string;
  txHash?: Hex;
  block?: string;
};

export type LeashState = {
  name: string;
  node: Hex;
  agent: Address;
  signer: Address;
  quote: { address: Address; symbol: string; decimals: number };
  cap: bigint;
  spent: bigint;
  remaining: bigint;
  tokens: readonly Address[];
  expiry: bigint;
  nonce: bigint;
  /** `leash.maxSlippageBps`, or null when the record is empty and the hook does not bound slippage. */
  maxSlippageBps: bigint | null;
};

export type SwapResult =
  | {
      status: "ok";
      txHash: Hex;
      block: bigint;
      amount: bigint;
      /** Quote actually swapped, from the hook's `LeashSwap` event. Below `amount` on a partial fill. */
      filled: bigint;
      spentToday: bigint;
      cap: bigint;
      slippageBps: bigint | null;
      quote: LeashState["quote"];
    }
  /** `txHash` is set when the refusal was recorded on chain through `LeashVault.trySwap`. */
  | { status: "revert"; reason: string; amount: bigint; txHash?: Hex };

export class LeashError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** "100 bps (1%)", or "none" when the policy does not bound slippage. */
export function bpsText(bps: bigint | null): string {
  return bps === null ? "none" : `${bps} bps (${Number(bps) / 100}%)`;
}

// ============ Client ============

export class LeashClient {
  readonly account;
  readonly publicClient;
  readonly walletClient;
  private readonly feedUrl: string | null;
  private readonly onEvent?: (e: AgentEvent) => void;
  private readonly recordRefusals: boolean;
  /** Swaps run one at a time: two intents signed with the same nonce would make the second one BadNonce. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly deployments: Deployments,
    rpcUrl: string,
    agentPk: Hex,
    opts: {
      feedUrl?: string | null;
      onEvent?: (e: AgentEvent) => void;
      /** Send a refused swap anyway, through `trySwap`, so the refusal is recorded on chain. Costs the agent gas. */
      recordRefusals?: boolean;
    } = {},
  ) {
    const chainId = Number(deployments.chainId);
    const chain = chainId === sepolia.id ? sepolia : defineChain({ ...sepolia, id: chainId, name: `chain-${chainId}` });
    this.account = privateKeyToAccount(agentPk);
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
    this.feedUrl = opts.feedUrl ?? null;
    this.onEvent = opts.onEvent;
    this.recordRefusals = opts.recordRefusals ?? false;
  }

  fullName(label = this.deployments.agentLabel): string {
    return `${label}.${this.deployments.parentName}`;
  }

  /** Policy as the hook sees it. Throws `LeashError` with the decoded reason when the hook refuses the name. */
  async readState(label = this.deployments.agentLabel, emitPolicy = true): Promise<LeashState> {
    const name = this.fullName(label);
    const node = namehash(name);
    const hook = this.deployments.hook;
    const ctx = { label, parentName: this.deployments.parentName };
    let policy: readonly [Address, Address, bigint, readonly Address[], bigint];
    try {
      policy = await this.publicClient.readContract({
        address: hook,
        abi: LEASH_HOOK_ABI,
        functionName: "policy",
        args: [label],
      });
    } catch (err) {
      const data = revertDataFromError(err);
      if (!data) throw err;
      const reason = explainRevert(decodeRevertData(data), ctx);
      await this.emit({ kind: "revert", name, text: `policy read reverted: ${reason}` });
      throw new LeashError(`${name}: ${reason}`, reason);
    }
    const [remaining, spent, nonce, maxSlippageBps] = await Promise.all([
      this.publicClient.readContract({
        address: hook,
        abi: LEASH_HOOK_ABI,
        functionName: "remainingToday",
        args: [label],
      }),
      this.publicClient.readContract({ address: hook, abi: LEASH_HOOK_ABI, functionName: "spentToday", args: [node] }),
      this.publicClient.readContract({ address: hook, abi: LEASH_HOOK_ABI, functionName: "nonces", args: [node] }),
      this.readMaxSlippage(label, name, ctx),
    ]);
    const quoteMeta = await tokenMeta(this.publicClient, policy[1]);
    const state: LeashState = {
      name,
      node,
      agent: policy[0],
      signer: this.account.address,
      quote: { address: policy[1], ...quoteMeta },
      cap: policy[2],
      spent,
      remaining,
      tokens: policy[3],
      expiry: policy[4],
      nonce,
      maxSlippageBps,
    };
    if (emitPolicy) {
      await this.emit({
        kind: "policy",
        name,
        text: `cap ${this.fmt(state, state.cap)}, spent ${this.fmt(state, state.spent)}, remaining ${this.fmt(state, state.remaining)}, max slippage ${bpsText(state.maxSlippageBps)}, nonce ${nonce}`,
      });
    }
    return state;
  }

  /**
   * Exact-input swap of `amount` quote tokens (human units, e.g. "25"). Simulates first: a hook revert comes
   * back as `{ status: "revert" }` with the decoded reason instead of throwing. Never clamps the amount or the
   * slippage: the hook is the enforcement point, not this client. `slippageBps` defaults to the policy bound.
   */
  swap(amountHuman: string, label = this.deployments.agentLabel, slippageBps?: bigint): Promise<SwapResult> {
    const next = this.queue.then(() => this.swapNow(amountHuman, label, slippageBps));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async swapNow(amountHuman: string, label: string, requestedSlippage?: bigint): Promise<SwapResult> {
    // The intent event that follows already carries the numbers, no separate policy line.
    const state = await this.readState(label, false);
    const { deployments } = this;
    const amount = parseUnits(amountHuman, state.quote.decimals);
    if (amount <= 0n) throw new LeashError("amount must be positive");
    const quoteIsToken0 = state.quote.address.toLowerCase() === deployments.token0.toLowerCase();
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + INTENT_TTL_SECONDS;
    const intent: SwapIntent = {
      node: state.node,
      poolId: deployments.poolId,
      zeroForOne: quoteIsToken0,
      amountSpecified: -amount,
      nonce: state.nonce,
      deadline,
    };
    const chainId = await this.publicClient.getChainId();
    const signature = await signIntent(this.account, leashDomain(chainId, deployments.hook), intent);
    const hookData = encodeHookData(label, intent, signature);
    const amountText = this.fmt(state, amount);
    const slippageBps = chooseSlippage(requestedSlippage, state.maxSlippageBps);
    const sqrtPriceLimitX96 = await priceLimitFor(
      this.publicClient,
      deployments.hook,
      deployments.poolId,
      intent.zeroForOne,
      slippageBps,
    );
    await this.emit({
      kind: "intent",
      name: state.name,
      amount: amountText,
      text: `signed SwapIntent: ${amountText} exact in, ${quoteIsToken0 ? "0->1" : "1->0"}, ${slippageText(slippageBps, state.maxSlippageBps)}, nonce ${state.nonce}`,
    });

    let request;
    try {
      ({ request } = await this.publicClient.simulateContract({
        address: deployments.vault,
        abi: LEASH_VAULT_ABI,
        functionName: "swap",
        args: vaultSwapArgs(deployments, intent, sqrtPriceLimitX96, hookData),
        account: this.account,
      }));
    } catch (err) {
      const data = revertDataFromError(err);
      if (!data) throw err;
      const reason = explainRevert(decodeRevertData(data), {
        label,
        parentName: deployments.parentName,
        decimals: state.quote.decimals,
        symbol: state.quote.symbol,
      });
      const recorded = this.recordRefusals
        ? await this.recordRefusal(vaultSwapArgs(deployments, intent, sqrtPriceLimitX96, hookData))
        : null;
      await this.emit({
        kind: "revert",
        name: state.name,
        amount: amountText,
        txHash: recorded ?? undefined,
        text: recorded ? `REVERT ${reason}, recorded on chain ${recorded}` : `REVERT ${reason}`,
      });
      return { status: "revert", reason, amount, txHash: recorded ?? undefined };
    }

    const txHash = await this.walletClient.writeContract(request);
    await this.emit({ kind: "sent", name: state.name, amount: amountText, txHash, text: `sent ${txHash}` });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      const reason = `tx ${txHash} reverted on chain (block ${receipt.blockNumber})`;
      await this.emit({ kind: "revert", name: state.name, amount: amountText, txHash, text: reason });
      return { status: "revert", reason, amount };
    }
    const spentToday = await this.publicClient.readContract({
      address: deployments.hook,
      abi: LEASH_HOOK_ABI,
      functionName: "spentToday",
      args: [state.node],
    });
    // The hook's own measure of this swap: robust to other swaps under the name and to a midnight rollover.
    const swapLog = parseEventLogs({ abi: LEASH_HOOK_ABI, eventName: "LeashSwap", logs: receipt.logs }).find(
      (l) => l.address.toLowerCase() === deployments.hook.toLowerCase() && l.args.node === state.node,
    );
    const filled = swapLog?.args.notional ?? amount;
    const partial = filled < amount ? `, partial fill ${this.fmt(state, filled)}: price limit reached` : "";
    await this.emit({
      kind: "ok",
      name: state.name,
      amount: amountText,
      txHash,
      block: receipt.blockNumber.toString(),
      text: `OK block ${receipt.blockNumber}, spent today ${this.fmt(state, spentToday)} of ${this.fmt(state, state.cap)}${partial}`,
    });
    return {
      status: "ok",
      txHash,
      block: receipt.blockNumber,
      amount,
      filled,
      spentToday,
      cap: state.cap,
      slippageBps,
      quote: state.quote,
    };
  }

  /**
   * Send a swap the simulation refused through `LeashVault.trySwap`, so the hook's answer lands on chain as a
   * `SwapRefused` event. Only when `trySwap` itself would record it: a vault level refusal (`NotSigner`,
   * `NotLeashPool`) reverts there too, and is not sent. Returns the transaction hash, or null when not sent.
   */
  private async recordRefusal(args: ReturnType<typeof vaultSwapArgs>): Promise<Hex | null> {
    try {
      const { request, result } = await this.publicClient.simulateContract({
        address: this.deployments.vault,
        abi: LEASH_VAULT_ABI,
        functionName: "trySwap",
        args,
        account: this.account,
      });
      if (result[0]) return null; // the swap would now go through: not a refusal anymore
      const txHash = await this.walletClient.writeContract(request);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      return receipt.status === "success" ? txHash : null;
    } catch {
      return null;
    }
  }

  /**
   * `leash.maxSlippageBps` as the hook reads it. A hook built before the slippage bound has no such view: that is
   * "not enforced", like an empty record. A malformed record makes the hook revert `InvalidRecord`, which fails
   * every swap, so it surfaces as a `LeashError` instead of being hidden.
   */
  private async readMaxSlippage(
    label: string,
    name: string,
    ctx: { label: string; parentName: string },
  ): Promise<bigint | null> {
    try {
      const [enforced, bps] = await this.publicClient.readContract({
        address: this.deployments.hook,
        abi: LEASH_HOOK_ABI,
        functionName: "maxSlippageBps",
        args: [label],
      });
      return enforced ? bps : null;
    } catch (err) {
      const data = revertDataFromError(err);
      if (!data || data === "0x") return null;
      const reason = explainRevert(decodeRevertData(data), ctx);
      await this.emit({ kind: "revert", name, text: `slippage read reverted: ${reason}` });
      throw new LeashError(`${name}: ${reason}`, reason);
    }
  }

  fmt(state: Pick<LeashState, "quote">, value: bigint): string {
    return `${formatUnits(value, state.quote.decimals)} ${state.quote.symbol}`;
  }

  /** Best effort: the dashboard feed is optional, a dead feed never blocks a trade. */
  async emit(event: AgentEvent): Promise<void> {
    this.onEvent?.(event);
    if (!this.feedUrl) return;
    try {
      await fetch(this.feedUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...event, ts: Date.now(), source: "agent" }),
        signal: AbortSignal.timeout(1_500),
      });
    } catch {
      // feed offline
    }
  }
}
