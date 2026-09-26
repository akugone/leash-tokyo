/**
 * Vite dev server plugin for the demo: an in-memory activity feed and the two human actions of the story.
 *
 *   POST /api/agent-events            the agent (MCP server) pushes {kind, text, ...}
 *   GET  /api/agent-events?after=<id> the dashboard polls new events
 *   DELETE /api/agent-events          clear the feed between rehearsals
 *   GET  /api/demo/status             {enabled, riskManager, owner, rpc}
 *   Every action below takes an optional `label` (the dashboard's selected tab), default the record's agentLabel.
 *   POST /api/demo/tighten {cap}      risk-manager: setText(leash.dailyNotional) on the agent's own resolver,
 *                                     simulated first: an ENS refusal comes back as {status: "refused", text},
 *                                     and nothing is sent
 *   POST /api/demo/forbid             risk-manager tries unregister / setAddress / setText(leash.quote) /
 *                                     setText(leash.maxSlippageBps): must revert
 *   POST /api/demo/cut                owner: unregister(labelId) on the org registry
 *   POST /api/demo/slippage {bps}     owner: setText(leash.maxSlippageBps) on the agent's own resolver, 1 to 9999
 *   POST /api/demo/fund               owner: mint test lUSD and lETH to the org vault
 *   POST /api/demo/issue {label, agent, cap, bps, ttlSeconds, delegateRisk}
 *                                     owner: deploy the agent's own resolver with its policy, register the new (or
 *                                     expired) subname pointing to it, then grant the risk manager on it if asked
 *
 * Keys come from the repo root `.env` (RISK_MANAGER_PK, OWNER_PK) and never leave the dev server. The
 * static build has none of this: the dashboard then shows the feed and controls as unavailable.
 */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  isAddress,
  zeroAddress,
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
  deployedResolver,
  EAC_UNAUTHORIZED,
  forbiddenCalls,
  forbiddenOutcome,
  agentLabelError,
  FUND_AMOUNT,
  fundCalls,
  grantRiskManagerCall,
  issueCalls,
  liveResolver,
  preflight,
  registryWriteAbi,
  revertSelector,
  slippageCall,
  tightenCall,
  tightenRefusalText,
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

function context(label?: string) {
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
  const agentLabel = label ?? d.agentLabel;
  const registry = d.orgRegistry as Address;
  return {
    d,
    rpc,
    publicClient,
    /// The name with its own resolver, read from the registry now.
    target: async (): Promise<LeashTarget> => ({
      label: agentLabel,
      parentName: d.parentName,
      registry,
      resolver: await liveResolver(publicClient, registry, agentLabel),
    }),
    agentLabel,
    fullName: `${agentLabel}.${d.parentName}`,
    registry,
    riskManager: () => wallet(env.RISK_MANAGER_PK, "RISK_MANAGER_PK"),
    owner: () => wallet(env.OWNER_PK, "OWNER_PK"),
    riskManagerAddress: env.RISK_MANAGER_PK
      ? privateKeyToAccount(env.RISK_MANAGER_PK as Hex).address
      : null,
    ownerAddress: env.OWNER_PK ? privateKeyToAccount(env.OWNER_PK as Hex).address : null,
  };
}

// ============ Actions ============

async function tighten(capHuman: string, label?: string) {
  const ctx = context(label);
  const raw = parseUnits(capHuman, 18).toString();
  const { account, client } = ctx.riskManager();
  push({
    source: "risk",
    kind: "intent",
    text: `risk-manager sets leash.dailyNotional of ${ctx.fullName} to ${capHuman} lUSD (${raw})`,
  });
  // Simulated first: a write ENS would refuse is never sent.
  const call = tightenCall(await ctx.target(), capHuman);
  const refused = await preflight(ctx.publicClient, call, account.address);
  if (refused) {
    const text = tightenRefusalText(ctx.agentLabel, refused);
    push({ source: "risk", kind: refused.ens ? "denied" : "error", text });
    return { status: "refused", text };
  }
  const txHash = await client.writeContract({
    ...call,
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

async function forbid(label?: string) {
  const ctx = context(label);
  const { account } = ctx.riskManager();
  const results: { ok: boolean; text: string }[] = [];
  for (const a of forbiddenCalls(await ctx.target(), account.address)) {
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
async function setSlippage(bps: string, label?: string) {
  const ctx = context(label);
  const { account, client } = ctx.owner();
  push({
    source: "owner",
    kind: "intent",
    text: `owner sets leash.maxSlippageBps to ${bps} bps (${Number(bps) / 100}%)`,
  });
  const txHash = await client.writeContract({
    ...slippageCall(await ctx.target(), bps),
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

async function cut(label?: string) {
  const ctx = context(label);
  const { account, client } = ctx.owner();
  const id = labelId(ctx.agentLabel);
  push({
    source: "owner",
    kind: "intent",
    text: `owner cuts ${ctx.fullName}: unregister(labelId)`,
  });
  const txHash = await client.writeContract({
    ...cutCall({
      label: ctx.agentLabel,
      parentName: ctx.d.parentName,
      registry: ctx.registry,
      resolver: zeroAddress,
    }),
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

/// Owner: mint test tokens to the org vault, one `mint` per pool token. The demo tokens have an open mint.
async function fund() {
  const ctx = context();
  const { account, client } = ctx.owner();
  const vault = ctx.d.vault as Address | undefined;
  if (!vault) throw new Error("no vault in the deployment record");
  push({
    source: "owner",
    kind: "intent",
    text: `owner funds the org vault with ${FUND_AMOUNT} lUSD and ${FUND_AMOUNT} lETH`,
  });
  let txHash: Hex = "0x";
  let status: "success" | "reverted" = "success";
  for (const call of fundCalls(vault, [ctx.d.token0, ctx.d.token1] as Address[])) {
    txHash = await client.writeContract({ ...call, account, chain: client.chain });
    status = (await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })).status;
    if (status !== "success") break;
  }
  const text =
    status === "success"
      ? `Vault funded with ${FUND_AMOUNT} lUSD and ${FUND_AMOUNT} lETH (test tokens).`
      : "mint reverted on chain.";
  push({ source: "owner", kind: status === "success" ? "ok" : "revert", text, txHash });
  return { txHash, status, text };
}

/// Owner: the transactions of script/ens/IssueAgent.s.sol and GrantRiskManager.s.sol, with the pool's quote and
/// tokens: the agent's own resolver holding its policy, the subname pointing to it, the risk manager if asked.
async function issue(input: {
  label: string;
  agent: Address;
  cap: string;
  bps: string;
  ttlSeconds: bigint;
  delegateRisk: boolean;
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
  const riskManager = ctx.riskManagerAddress;
  if (input.delegateRisk && !riskManager) throw new Error("RISK_MANAGER_PK missing in .env");
  const calls = issueCalls(
    { parentName: ctx.d.parentName, registry: ctx.registry },
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
    text: `owner issues ${fullName} with its own resolver: agent ${input.agent}, cap ${input.cap} lUSD, max slippage ${input.bps} bps${input.delegateRisk ? ", risk manager delegated" : ", no risk manager"}`,
  });
  const send = async (call: Parameters<typeof client.writeContract>[0]) => {
    const hash = await client.writeContract({ ...call, account, chain: client.chain } as never);
    return { hash, receipt: await ctx.publicClient.waitForTransactionReceipt({ hash }) };
  };
  const failed = (step: string, hash: Hex) => {
    const text = `REVERTED ${step} for ${fullName}`;
    push({ source: "owner", kind: "revert", text, txHash: hash });
    return { txHash: hash, status: "reverted", text, expiry: calls.expiry.toString() };
  };

  const deployed = await send(calls.deployResolver as never);
  if (deployed.receipt.status !== "success") return failed("resolver deployment", deployed.hash);
  const resolver = deployedResolver(deployed.receipt.logs);
  push({
    source: "owner",
    kind: "ok",
    text: `${fullName} has its own resolver ${resolver}, policy written in initialize`,
    txHash: deployed.hash,
  });
  const registered = await send(calls.register(resolver) as never);
  if (registered.receipt.status !== "success") return failed("register", registered.hash);
  let txHash = registered.hash;
  if (input.delegateRisk && riskManager) {
    const granted = await send(grantRiskManagerCall(resolver, riskManager) as never);
    if (granted.receipt.status !== "success") return failed("risk manager grant", granted.hash);
    txHash = granted.hash;
  }
  push({
    source: "owner",
    kind: "ok",
    text: `OK ${fullName} is live until ${new Date(Number(calls.expiry) * 1000).toISOString()}`,
    txHash,
  });
  return { txHash, resolver, status: "success", expiry: calls.expiry.toString() };
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
          const body = await readBody(req);
          const rawLabel = body.label === undefined ? undefined : String(body.label).trim();
          const labelError = rawLabel === undefined ? null : agentLabelError(rawLabel);
          if (labelError) return json(res, 400, { error: `label: ${labelError}` });
          if (url.pathname === "/api/demo/tighten") {
            const cap = String(body.cap ?? "");
            if (!/^\d+(\.\d+)?$/.test(cap))
              return json(res, 400, { error: "cap must be a decimal number in lUSD" });
            return json(res, 200, await tighten(cap, rawLabel));
          }
          if (url.pathname === "/api/demo/slippage") {
            const bps = String(body.bps ?? "").trim();
            const invalid = slippageInputError(bps);
            if (invalid) return json(res, 400, { error: invalid });
            return json(res, 200, await setSlippage(String(BigInt(bps)), rawLabel));
          }
          if (url.pathname === "/api/demo/forbid") return json(res, 200, await forbid(rawLabel));
          if (url.pathname === "/api/demo/cut") return json(res, 200, await cut(rawLabel));
          if (url.pathname === "/api/demo/fund") return json(res, 200, await fund());
          if (url.pathname === "/api/demo/issue") {
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
              await issue({
                label,
                agent: agent as Address,
                cap,
                bps,
                ttlSeconds: BigInt(ttl),
                delegateRisk: body.delegateRisk !== false,
              }),
            );
          }
          return json(res, 404, { error: "unknown demo endpoint" });
        } catch (err) {
          const message =
            revertSelector(err) === EAC_UNAUTHORIZED
              ? "Refused by ENS: EACUnauthorizedAccountRoles, this account holds no role for that record on the agent's resolver."
              : err instanceof Error
                ? err.message.split("\n")[0]
                : String(err);
          push({ source: "system", kind: "error", text: message });
          return json(res, 500, { error: message });
        }
      });
    },
  };
}
