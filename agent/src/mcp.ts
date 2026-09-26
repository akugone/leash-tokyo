/**
 * Leash MCP server: gives an LLM agent (Claude Code in the demo) two tools, `leash_policy` and
 * `leash_swap`, signed with the trader key. Every call is mirrored to the dashboard agent feed.
 *
 *   bun run src/mcp.ts            # stdio transport, launched by Claude Code via agent/mcp.json
 *
 * Env (agent/.env then repo root .env): AGENT_PK, RPC_URL (default http://127.0.0.1:8545),
 * LEASH_DEPLOYMENTS_FILE (default deployments/anvil.json), LEASH_FEED_URL
 * (default http://localhost:5173/api/agent-events, set to "off" to disable).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, type Hex } from "viem";
import { z } from "zod";
import { loadDeployments, resolveDeploymentsPath } from "./bot.ts";
import { LeashClient, LeashError, bpsText } from "./leash.ts";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { config } = await import("dotenv");
  config({ path: resolve(agentDir, ".env"), quiet: true });
  config({ path: resolve(agentDir, "..", ".env"), quiet: true });
} catch {
  // dotenv optional
}

const agentPk = process.env.AGENT_PK as Hex | undefined;
if (!agentPk) throw new Error("AGENT_PK is not set");
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const feedEnv = process.env.LEASH_FEED_URL ?? "http://localhost:5173/api/agent-events";
const deployments = loadDeployments(resolveDeploymentsPath(process.env.LEASH_DEPLOYMENTS_FILE, agentDir));
const client = new LeashClient(deployments, rpcUrl, agentPk, {
  feedUrl: feedEnv === "off" ? null : feedEnv,
  onEvent: (e) => console.error(`[leash] ${e.kind} ${e.text}`),
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

const server = new McpServer({ name: "leash", version: "0.1.0" });

server.registerTool(
  "leash_policy",
  {
    title: "Read the Leash policy",
    description:
      "Read the trading mandate the Leash hook enforces for this agent's ENS name: daily cap, spent today, remaining today, max slippage, allowed tokens, expiry, nonce. Call it before trading and whenever the operator asks about limits.",
    inputSchema: {},
  },
  async () => {
    try {
      const s = await client.readState();
      const d = s.quote.decimals;
      const lines = [
        `name: ${s.name}`,
        `agent (addr record): ${s.agent}${s.agent.toLowerCase() === s.signer.toLowerCase() ? " (this signer)" : ` (WARNING: this signer is ${s.signer})`}`,
        `quote token: ${s.quote.symbol} ${s.quote.address}`,
        `daily cap: ${formatUnits(s.cap, d)} ${s.quote.symbol}`,
        `spent today: ${formatUnits(s.spent, d)} ${s.quote.symbol}`,
        `remaining today: ${formatUnits(s.remaining, d)} ${s.quote.symbol}`,
        `max slippage: ${bpsText(s.maxSlippageBps)}`,
        `allowed tokens: ${s.tokens.join(", ") || "none"}`,
        `expiry: ${s.expiry === 0n ? "revoked" : new Date(Number(s.expiry) * 1000).toISOString()}`,
        `nonce: ${s.nonce}`,
      ];
      return text(lines.join("\n"));
    } catch (err) {
      if (err instanceof LeashError) return fail(`The hook refuses this name: ${err.reason ?? err.message}`);
      return fail(`policy read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.registerTool(
  "leash_swap",
  {
    title: "Swap through the Leash hook",
    description:
      'Sell `amount` of the quote token (human units, e.g. "25" for 25 lUSD) for the other pool token through Uniswap v4, with an EIP-712 SwapIntent signed by this agent. The Leash hook checks the name, the allowlist, the slippage bound and the daily cap on chain; an over-cap, too-loose or revoked trade comes back as a REVERT with the decoded reason. `slippageBps` (optional) is the price move the swap may allow, in basis points (100 = 1%); it defaults to the policy maximum. If the price limit is reached the swap is partially filled and the result says so. Never clamp or refuse an amount or a slippage yourself: attempt it and report what the chain said.',
    inputSchema: {
      amount: z
        .string()
        .regex(/^\d+(\.\d+)?$/, "decimal number in quote token units")
        .describe('Amount of quote token to sell, e.g. "25"'),
      slippageBps: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Max price move in basis points (100 = 1%). Omit to use the policy maximum."),
    },
  },
  async ({ amount, slippageBps }) => {
    try {
      const r = await client.swap(amount, undefined, slippageBps === undefined ? undefined : BigInt(slippageBps));
      if (r.status === "ok") {
        const q = (v: bigint) => `${formatUnits(v, r.quote.decimals)} ${r.quote.symbol}`;
        const fill =
          r.filled < r.amount
            ? ` Partial fill: ${q(r.filled)} of ${q(r.amount)} swapped, the price limit (${bpsText(r.slippageBps)}) was reached.`
            : "";
        return text(
          `OK: swapped ${q(r.filled)}, tx ${r.txHash}, block ${r.block}, slippage ${bpsText(r.slippageBps)}.${fill} Spent today ${q(r.spentToday)} of cap ${q(r.cap)}.`,
        );
      }
      return fail(`REVERT: ${r.reason}. Nothing moved.`);
    } catch (err) {
      if (err instanceof LeashError) return fail(`REVERT: ${err.reason ?? err.message}. Nothing moved.`);
      return fail(`swap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`[leash] MCP server ready: ${client.fullName()} signer ${client.account.address} rpc ${rpcUrl}`);
