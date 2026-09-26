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
 *   POST /api/demo/slippage {bps}     owner: setText(leash.maxSlippageBps) on the org resolver, 1 to 9999
 *   POST /api/demo/issue {label, agent, cap, bps, ttlSeconds}
 *                                     owner: register a new (or expired) agent subname and write its policy
 *
 * Keys come from the repo root `.env` (RISK_MANAGER_PK, OWNER_PK) and never leave the dev server. The
 * static build has none of this: the dashboard then shows the feed and controls as unavailable.
 */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  isAddress,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Plugin } from "vite";
import {
  cutCall,
  forbiddenCalls,
  forbiddenOutcome,
  agentLabelError,
  issueCalls,
  registryWriteAbi,
  slippageCall,
  tightenCall,
  type LeashTarget,
} from "../src/lib/actions";
import { labelId, slippageInputError } from "../src/lib/leash";

const repoDir = resolve(__dirname, "..", "..");
const MAX_EVENTS = 200;
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
  const target: LeashTarget = {
    label: d.agentLabel,
    parentName: d.parentName,
    registry: d.orgRegistry as Address,
    resolver: d.orgResolver as Address,
  };
  return {
    d,
    rpc,
    publicClient,
    target,
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
    ...tightenCall(ctx.target, capHuman),
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
  const results: { ok: boolean; text: string }[] = [];
  for (const a of forbiddenCalls(ctx.target, account.address)) {
    try {
      await ctx.publicClient.simulateContract({ ...a.call, account } as never);
      results.push(forbiddenOutcome(a.what, null));
    } catch (err) {
      results.push(forbiddenOutcome(a.what, err));
    }
  }
  for (const r of results) push({ source: "risk", kind: r.ok ? "denied" : "error", text: r.text });
  return { results };
}

/// Owner only: the risk manager holds no role on this key (clearing it would switch the bound off).
async function setSlippage(bps: string) {
  const ctx = context();
  const { account, client } = ctx.owner();
  push({
    source: "owner",
    kind: "intent",
    text: `owner sets leash.maxSlippageBps to ${bps} bps (${Number(bps) / 100}%)`,
  });
  const txHash = await client.writeContract({
    ...slippageCall(ctx.target, bps),
    account,
    chain: client.chain,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  push({
    source: "owner",
    kind: receipt.status === "success" ? "ok" : "revert",
    text: `${receipt.status === "success" ? "OK" : "REVERTED"} block ${receipt.blockNumber}, max slippage is now ${bps} bps`,
    txHash,
  });
  return { txHash, block: receipt.blockNumber.toString(), status: receipt.status };
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
    ...cutCall(ctx.target),
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

/// Owner: the two transactions of script/ens/IssueAgent.s.sol, with the pool's quote and tokens.
async function issue(input: {
  label: string;
  agent: Address;
  cap: string;
  bps: string;
  ttlSeconds: bigint;
}) {
  const ctx = context();
  const { account, client } = ctx.owner();
  const fullName = `${input.label}.${ctx.d.parentName}`;
  const block = await ctx.publicClient.getBlock();
  const current = await ctx.publicClient.readContract({
    address: ctx.registry,
    abi: registryWriteAbi,
    functionName: "getExpiry",
    args: [labelId(input.label)],
  });
  if (current > block.timestamp)
    throw new Error(`${fullName} is already live. Cut it first, or pick another name.`);
  const calls = issueCalls(
    { parentName: ctx.d.parentName, registry: ctx.registry, resolver: ctx.resolver },
    {
      label: input.label,
      agent: input.agent,
      owner: account.address,
      quote: ctx.d.quote as Address,
      tokens: [ctx.d.token0, ctx.d.token1] as Address[],
      capHuman: input.cap,
      maxSlippageBps: input.bps,
      ttlSeconds: input.ttlSeconds,
    },
    block.timestamp,
  );
  push({
    source: "owner",
    kind: "intent",
    text: `owner issues ${fullName}: agent ${input.agent}, cap ${input.cap} lUSD, max slippage ${input.bps} bps`,
  });
  const registerHash = await client.writeContract({
    ...calls.register,
    account,
    chain: client.chain,
  });
  const registered = await ctx.publicClient.waitForTransactionReceipt({ hash: registerHash });
  if (registered.status !== "success") {
    push({
      source: "owner",
      kind: "revert",
      text: `REVERTED register ${fullName}`,
      txHash: registerHash,
    });
    return { txHash: registerHash, status: registered.status, expiry: calls.expiry.toString() };
  }
  const txHash = await client.writeContract({ ...calls.policy, account, chain: client.chain });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  push({
    source: "owner",
    kind: receipt.status === "success" ? "ok" : "revert",
    text: `${receipt.status === "success" ? "OK" : "REVERTED"} block ${receipt.blockNumber}, ${fullName} is live until ${new Date(Number(calls.expiry) * 1000).toISOString()}`,
    txHash,
  });
  return { txHash, registerHash, status: receipt.status, expiry: calls.expiry.toString() };
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
          if (url.pathname === "/api/demo/slippage") {
            const body = await readBody(req);
            const bps = String(body.bps ?? "").trim();
            const invalid = slippageInputError(bps);
            if (invalid) return json(res, 400, { error: invalid });
            return json(res, 200, await setSlippage(String(BigInt(bps))));
          }
          if (url.pathname === "/api/demo/forbid") return json(res, 200, await forbid());
          if (url.pathname === "/api/demo/cut") return json(res, 200, await cut());
          if (url.pathname === "/api/demo/issue") {
            const body = await readBody(req);
            const label = String(body.label ?? "").trim();
            const agent = String(body.agent ?? "").trim();
            const cap = String(body.cap ?? "").trim();
            const bps = String(body.bps ?? "").trim();
            const ttl = String(body.ttlSeconds ?? "").trim();
            const invalid =
              agentLabelError(label) ??
              (isAddress(agent) ? null : "agent is not an address") ??
              (/^\d+(\.\d+)?$/.test(cap) ? null : "cap must be a number") ??
              slippageInputError(bps) ??
              (/^\d+$/.test(ttl) && BigInt(ttl) >= 60n ? null : "ttlSeconds must be at least 60");
            if (invalid) return json(res, 400, { error: invalid });
            return json(
              res,
              200,
              await issue({ label, agent: agent as Address, cap, bps, ttlSeconds: BigInt(ttl) }),
            );
          }
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
