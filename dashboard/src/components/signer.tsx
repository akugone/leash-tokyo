// Who signs the humans' transactions, shared by the role cards, the New agent page and the org bar. Under
// `bun run dev` the dev server signs with the keys from the repo root .env. Anywhere else (the hosted build)
// the connected wallet signs, through Reown AppKit, when a project id is set.
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { isAddress } from "viem";
import { agentLabelError, EAC_UNAUTHORIZED, revertSelector } from "../lib/actions";
import { shortHex, slippageInputError, type Deployments } from "../lib/leash";

export type Outcome = {
  tone: "ok" | "bad" | "info";
  text: string;
  txHash?: string;
  link?: { href: string; text: string };
} | null;

/// A new agent as the owner fills it in: its label, signing address and mandate.
export type IssueForm = {
  label: string;
  agent: string;
  cap: string;
  bps: string;
  duration: string;
  unit: "minutes" | "days";
  /// Let the risk manager edit this agent's cap and tokens, on the agent's own resolver. Off: no risk manager.
  delegateRisk: boolean;
};

/// The human actions, however they get signed.
export type RoleActions = {
  tighten: (cap: string) => Promise<Outcome>;
  forbid: () => Promise<Outcome>;
  slippage: (bps: string) => Promise<Outcome>;
  cut: () => Promise<Outcome>;
  issue: (form: IssueForm) => Promise<Outcome>;
  fund: () => Promise<Outcome>;
};

/// Whether this page can sign as a role right now, and what to show when it cannot.
export type RoleGate = { canSign: true } | { canSign: false; reason: string };

export type Signer = {
  actions: RoleActions;
  riskGate: RoleGate;
  ownerGate: RoleGate;
  riskManager: string | null;
  owner: string | null;
  /// Wallet mode only: who is connected, and the connect or switch button.
  walletBar: ReactNode | null;
  /// Explorer transaction URL prefix, e.g. `https://sepolia.etherscan.io/tx/`.
  txUrl?: string;
};

const SignerContext = createContext<Signer | null>(null);

/// Null when nothing can sign here: no dev server and no Reown project id.
export function useSigner(): Signer | null {
  return useContext(SignerContext);
}

export const SignerValue = SignerContext.Provider;

export const SEPOLIA_TX_URL = "https://sepolia.etherscan.io/tx/";
const SEPOLIA_CHAIN_ID = 11155111;
const REOWN_PROJECT_ID = import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined;
const WalletSigner = lazy(() => import("./WalletSigner"));

type Status = { enabled: boolean; riskManager: string | null; owner: string | null; name: string };

type ProviderProps = {
  deployments: Deployments | null;
  label: string;
  rpc: string;
  children: ReactNode;
};

export function SignerProvider({ deployments, label, rpc, children }: ProviderProps) {
  const [status, setStatus] = useState<Status | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/demo/status", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  const none = <SignerValue value={null}>{children}</SignerValue>;
  if (status === undefined || !deployments) return none;
  if (status?.enabled) {
    return (
      <SignerValue value={serverSigner(status, deployments, label, rpc)}>{children}</SignerValue>
    );
  }
  const walletReady = REOWN_PROJECT_ID && Number(deployments.chainId) === SEPOLIA_CHAIN_ID;
  if (!walletReady) return none;
  return (
    <Suspense fallback={none}>
      <WalletSigner projectId={REOWN_PROJECT_ID} rpc={rpc} deployments={deployments} label={label}>
        {children}
      </WalletSigner>
    </Suspense>
  );
}

/// Dev server mode: keys from the repo root .env, never in the browser.
function serverSigner(
  status: Status,
  deployments: Deployments,
  label: string,
  rpc: string,
): Signer {
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
    return data;
  };
  const tone = (r: Record<string, unknown>) => (r.status === "success" ? "ok" : "bad");
  const fullName = `${label}.${deployments.parentName}`;
  const open: RoleGate = { canSign: true };
  const local = /localhost|127\.0\.0\.1/.test(rpc);
  return {
    riskManager: status.riskManager,
    owner: status.owner,
    riskGate: open,
    ownerGate: open,
    walletBar: null,
    // A local fork has no explorer.
    txUrl: !local && Number(deployments.chainId) === SEPOLIA_CHAIN_ID ? SEPOLIA_TX_URL : undefined,
    actions: {
      tighten: async (cap) => {
        const r = await post("/api/demo/tighten", { cap, label });
        if (r.status === "refused") return { tone: "bad", text: String(r.text) };
        return { tone: tone(r), text: `Cap set to ${cap} lUSD.`, txHash: String(r.txHash) };
      },
      forbid: async () => {
        const r = await post("/api/demo/forbid", { label });
        const results = r.results as { ok: boolean; text: string }[];
        return {
          tone: results.every((x) => x.ok) ? "ok" : "bad",
          text: results.map((x) => x.text).join(" · "),
        };
      },
      slippage: async (bps) => {
        const r = await post("/api/demo/slippage", { bps, label });
        return {
          tone: tone(r),
          text: `Max slippage set to ${bps} bps (${Number(bps) / 100}%).`,
          txHash: String(r.txHash),
        };
      },
      cut: async () => {
        const r = await post("/api/demo/cut", { label });
        return {
          tone: tone(r),
          text: `${fullName} cut, expiry ${String(r.expiry)}.`,
          txHash: String(r.txHash),
        };
      },
      issue: async (form) => {
        const r = await post("/api/demo/issue", {
          label: form.label,
          agent: form.agent,
          cap: form.cap,
          bps: form.bps,
          ttlSeconds: ttlSeconds(form).toString(),
          delegateRisk: form.delegateRisk,
        });
        if (r.status !== "success") {
          return {
            tone: "bad",
            text: String(r.text ?? "Reverted on chain."),
            txHash: String(r.txHash),
          };
        }
        return issuedOutcome(
          form,
          deployments.parentName,
          BigInt(String(r.expiry)),
          String(r.resolver),
          String(r.txHash),
        );
      },
      fund: async () => {
        const r = await post("/api/demo/fund", {});
        return { tone: tone(r), text: String(r.text), txHash: String(r.txHash) };
      },
    },
  };
}

// ============ Issue form helpers ============

export function ttlSeconds(form: IssueForm): bigint {
  return BigInt(Math.round(Number(form.duration) * (form.unit === "days" ? 86_400 : 60)));
}

/// First problem with the form, or null when it can be sent.
export function issueFormError(form: IssueForm): string | null {
  const label = agentLabelError(form.label);
  if (label) return `name: ${label}`;
  if (!isAddress(form.agent)) return "agent: not an address";
  if (!/^\d+(\.\d+)?$/.test(form.cap)) return "daily cap: a number of lUSD";
  const bps = slippageInputError(form.bps);
  if (bps) return `max slippage: ${bps}`;
  if (!/^\d+(\.\d+)?$/.test(form.duration) || ttlSeconds(form) < 60n) {
    return "mandate: at least one minute";
  }
  return null;
}

export function issuedOutcome(
  form: IssueForm,
  parentName: string,
  expiry: bigint,
  resolver: string,
  txHash: string,
): Outcome {
  const until = new Date(Number(expiry) * 1000).toISOString().slice(0, 16).replace("T", " ");
  const risk = form.delegateRisk ? "risk manager delegated on it" : "no risk manager on it";
  return {
    tone: "ok",
    text: `${form.label}.${parentName} issued with its own resolver ${shortHex(resolver)} (${risk}): cap ${form.cap} lUSD, max slippage ${form.bps} bps, until ${until} UTC.`,
    txHash,
  };
}

/// viem errors carry a one line `shortMessage`; a rejected wallet prompt should read as such.
export function errorText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; name?: string };
  if (e?.name === "UserRejectedRequestError" || /rejected/i.test(e?.shortMessage ?? "")) {
    return "Signature rejected in the wallet, nothing was sent.";
  }
  if (revertSelector(err) === EAC_UNAUTHORIZED) {
    return "Refused by ENS: EACUnauthorizedAccountRoles, this account holds no role for that record on the agent's resolver.";
  }
  return e?.shortMessage ?? e?.message ?? String(err);
}
