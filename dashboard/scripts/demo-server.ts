/**
 * Vite dev server plugin for the demo: an in-memory activity feed and the two human actions of the story.
 *
 *   POST /api/agent-events            the agent (MCP server) pushes {kind, text, ...}
 *   GET  /api/agent-events?after=<id> the dashboard polls new events
 *   DELETE /api/agent-events          clear the feed between rehearsals
 *   GET  /api/demo/status             {enabled, riskManager, owner, rpc}
 *   POST /api/demo/tighten {cap}      risk-manager: setText(leash.dailyNotional) on the org resolver
 *   POST /api/demo/forbid             risk-manager tries unregister / setAddress / setText(leash.quote) /
 *                                     setText(leash.maxSlippageBps): must revert
 *   POST /api/demo/cut                owner: unregister(labelId) on the org registry
 *
 * Keys come from the repo root `.env` (RISK_MANAGER_PK, OWNER_PK) and never leave the dev server. The
 * static build has none of this: the dashboard then shows the feed and controls as unavailable.
 */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Plugin } from "vite";
import { dnsEncode, labelId } from "../src/lib/leash";

const repoDir = resolve(__dirname, "..", "..");
const MAX_EVENTS = 200;
const EAC_UNAUTHORIZED = "0x4b27a133"; // EACUnauthorizedAccountRoles(uint256,uint256,address)

const resolverWriteAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addr)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
]);
const registryWriteAbi = parseAbi([
  "function unregister(uint256 anyId)",
  "function getExpiry(uint256 anyId) view returns (uint64)",
]);

type FeedEvent = {
  id: number;
  ts: number;
  source: string;
  kind: string;
  text: string;
  [k: string]: unknown;
};

const events: FeedEvent[] = [];
let nextId = 1;

type FeedInput = { source: string; kind: string; text: string; ts?: number; [k: string]: unknown };

function push(e: FeedInput): FeedEvent {
  const ev: FeedEvent = { ...e, id: nextId++, ts: e.ts ?? Date.now() };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return ev;
}

// ============ Env and chain ============

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = resolve(repoDir, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ...out, ...(process.env as Record<string, string>) };
}

function context() {
  const env = readEnv();
  const file = resolve(repoDir, env.LEASH_DEPLOYMENTS_FILE || "deployments/anvil.json");
  if (!existsSync(file)) throw new Error(`deployments file not found: ${file}`);
  const d = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const rpc = env.RPC_URL || "http://127.0.0.1:8545";
  const chainId = Number(d.chainId);
  const chain =
    chainId === sepolia.id
      ? sepolia
      : defineChain({ ...sepolia, id: chainId, name: `chain-${chainId}` });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = (pk: string | undefined, role: string) => {
    if (!pk) throw new Error(`${role} key missing in .env`);
    const account = privateKeyToAccount(pk as Hex);
    return { account, client: createWalletClient({ account, chain, transport: http(rpc) }) };
  };
  const name = dnsEncode(`${d.agentLabel}.${d.parentName}`);
  return {
    d,
    rpc,
    publicClient,
    name,
    fullName: `${d.agentLabel}.${d.parentName}`,
    resolver: d.orgResolver as Address,
    registry: d.orgRegistry as Address,
    riskManager: () => wallet(env.RISK_MANAGER_PK, "RISK_MANAGER_PK"),
    owner: () => wallet(env.OWNER_PK, "OWNER_PK"),
    riskManagerAddress: env.RISK_MANAGER_PK
      ? privateKeyToAccount(env.RISK_MANAGER_PK as Hex).address
      : null,
    ownerAddress: env.OWNER_PK ? privateKeyToAccount(env.OWNER_PK as Hex).address : null,
  };
}

function revertSelector(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const found = err.walk(
    (e) =>
      typeof (e as { data?: unknown }).data === "string" ||
      typeof (e as { raw?: unknown }).raw === "string",
  );
  const data =
    (found as { raw?: string; data?: string } | null)?.raw ??
    (found as { data?: string } | null)?.data;
  return typeof data === "string" && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
}

// ============ Actions ============

async function tighten(capHuman: string) {
  const ctx = context();
  const raw = parseUnits(capHuman, 18).toString();
  const { account, client } = ctx.riskManager();
  push({
    source: "risk",
    kind: "intent",
    text: `risk-manager sets leash.dailyNotional to ${capHuman} lUSD (${raw})`,
  });
  const txHash = await client.writeContract({
    address: ctx.resolver,
    abi: resolverWriteAbi,
    functionName: "setText",
    args: [ctx.name, "leash.dailyNotional", raw],
    account,
    chain: client.chain,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  push({
    source: "risk",
    kind: receipt.status === "success" ? "ok" : "revert",
    text: `${receipt.status === "success" ? "OK" : "REVERTED"} block ${receipt.blockNumber}, cap is now ${capHuman} lUSD`,
    txHash,
  });
  return { txHash, block: receipt.blockNumber.toString(), status: receipt.status };
}

async function forbid() {
  const ctx = context();
  const { account } = ctx.riskManager();
  const attempts = [
    {
      what: "unregister(trader) by risk-manager",
      call: {
        address: ctx.registry,
        abi: registryWriteAbi,
        functionName: "unregister",
        args: [labelId(ctx.d.agentLabel)],
      },
    },
    {
      what: "setAddress(agent) by risk-manager",
      call: {
        address: ctx.resolver,
        abi: resolverWriteAbi,
        functionName: "setAddress",
        args: [ctx.name, 60n, account.address],
      },
    },
    {
      what: "setText(leash.quote) by risk-manager",
      call: {
        address: ctx.resolver,
        abi: resolverWriteAbi,
        functionName: "setText",
        args: [ctx.name, "leash.quote", account.address],
      },
    },
    {
      what: "setText(leash.maxSlippageBps) by risk-manager",
      call: {
        address: ctx.resolver,
        abi: resolverWriteAbi,
        functionName: "setText",
        args: [ctx.name, "leash.maxSlippageBps", ""],
      },
    },
  ] as const;
  const results: { what: string; ok: boolean; text: string }[] = [];
  for (const a of attempts) {
    try {
      await ctx.publicClient.simulateContract({ ...a.call, account } as never);
      results.push({ what: a.what, ok: false, text: `FAIL ${a.what} -> unexpectedly allowed` });
    } catch (err) {
      const sel = revertSelector(err);
      const reason =
        sel === EAC_UNAUTHORIZED
          ? "EACUnauthorizedAccountRoles"
          : `reverted${sel ? ` (${sel})` : ""}`;
      results.push({ what: a.what, ok: true, text: `PASS ${a.what} -> ${reason}` });
    }
  }
  for (const r of results) push({ source: "risk", kind: r.ok ? "denied" : "error", text: r.text });
  return { results };
}

async function cut() {
  const ctx = context();
  const { account, client } = ctx.owner();
  const id = labelId(ctx.d.agentLabel);
  push({
    source: "owner",
    kind: "intent",
    text: `owner cuts ${ctx.fullName}: unregister(labelId)`,
  });
  const txHash = await client.writeContract({
    address: ctx.registry,
    abi: registryWriteAbi,
    functionName: "unregister",
    args: [id],
    account,
    chain: client.chain,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  const expiry = await ctx.publicClient.readContract({
    address: ctx.registry,
    abi: registryWriteAbi,
    functionName: "getExpiry",
    args: [id],
  });
  push({
    source: "owner",
    kind: receipt.status === "success" ? "cut" : "revert",
    text: `${receipt.status === "success" ? "leash cut" : "REVERTED"} block ${receipt.blockNumber}, expiry now ${expiry}`,
    txHash,
  });
  return {
    txHash,
    block: receipt.blockNumber.toString(),
    expiry: expiry.toString(),
    status: receipt.status,
  };
}

// ============ HTTP plumbing ============

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export function leashDemoPlugin(): Plugin {
  return {
    name: "leash-demo-server",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        try {
          if (url.pathname === "/api/agent-events" && req.method === "GET") {
            const after = Number(url.searchParams.get("after") ?? 0);
            return json(res, 200, {
              events: events.filter((e) => e.id > after),
              latest: nextId - 1,
            });
          }
          if (url.pathname === "/api/agent-events" && req.method === "DELETE") {
            events.length = 0;
            return json(res, 200, { cleared: true });
          }
          if (url.pathname === "/api/agent-events" && req.method === "POST") {
            const body = await readBody(req);
            const ev = push({
              source: typeof body.source === "string" ? body.source : "agent",
              kind: typeof body.kind === "string" ? body.kind : "info",
              text: typeof body.text === "string" ? body.text : JSON.stringify(body),
              ...body,
            } as never);
            return json(res, 200, { id: ev.id });
          }
          if (url.pathname === "/api/demo/status") {
            const ctx = context();
            return json(res, 200, {
              enabled: true,
              rpc: ctx.rpc,
              riskManager: ctx.riskManagerAddress,
              owner: ctx.ownerAddress,
              name: ctx.fullName,
            });
          }
          if (req.method !== "POST") return json(res, 405, { error: "POST only" });
          if (url.pathname === "/api/demo/tighten") {
            const body = await readBody(req);
            const cap = String(body.cap ?? "");
            if (!/^\d+(\.\d+)?$/.test(cap))
              return json(res, 400, { error: "cap must be a decimal number in lUSD" });
            return json(res, 200, await tighten(cap));
          }
          if (url.pathname === "/api/demo/forbid") return json(res, 200, await forbid());
          if (url.pathname === "/api/demo/cut") return json(res, 200, await cut());
          return json(res, 404, { error: "unknown demo endpoint" });
        } catch (err) {
          const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
          push({ source: "system", kind: "error", text: message });
          return json(res, 500, { error: message });
        }
      });
    },
  };
}
