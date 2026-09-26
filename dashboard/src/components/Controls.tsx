import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { isAddress } from "viem";
import { agentLabelError } from "../lib/actions";
import { shortHex, slippageInputError, type Deployments } from "../lib/leash";

type Status = { enabled: boolean; riskManager: string | null; owner: string | null; name: string };

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
};

/// The human actions, however they get signed.
export type RoleActions = {
  tighten: (cap: string) => Promise<Outcome>;
  forbid: () => Promise<Outcome>;
  slippage: (bps: string) => Promise<Outcome>;
  cut: () => Promise<Outcome>;
  issue: (form: IssueForm) => Promise<Outcome>;
};

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
  if (!/^\d+(\.\d+)?$/.test(form.duration) || ttlSeconds(form) < 60n)
    return "mandate: at least one minute";
  return null;
}

/// This page, switched to another agent name.
export function agentHref(label: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("label", label);
  return `${url.pathname}${url.search}`;
}

export function issuedOutcome(
  form: IssueForm,
  parentName: string,
  expiry: bigint,
  txHash: string,
): Outcome {
  const until = new Date(Number(expiry) * 1000).toISOString().slice(0, 16).replace("T", " ");
  return {
    tone: "ok",
    text: `${form.label}.${parentName} issued: cap ${form.cap} lUSD, max slippage ${form.bps} bps, until ${until} UTC.`,
    txHash,
    link: { href: agentHref(form.label), text: `Open ${form.label}.${parentName}` },
  };
}

/// Whether this page can sign as a role right now, and what to show when it cannot.
export type RoleGate = { canSign: true } | { canSign: false; reason: string };

const REOWN_PROJECT_ID = import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined;
const WalletControls = lazy(() => import("./WalletControls"));

type Props = {
  onChanged: () => void;
  revoked: boolean;
  deployments: Deployments | null;
  label: string;
  rpc: string;
};

/// The two human roles of the story. Under `bun run dev` they sign through the dev server, which holds their
/// keys. Anywhere else (the hosted build) they sign with a connected wallet, when a Reown project id is set.
export function Controls(props: Props) {
  const [status, setStatus] = useState<Status | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/demo/status", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  if (status === undefined) return null;
  if (status?.enabled) return <ServerControls status={status} {...props} />;
  if (!REOWN_PROJECT_ID || !props.deployments) return null;
  return (
    <Suspense fallback={null}>
      <WalletControls
        projectId={REOWN_PROJECT_ID}
        rpc={props.rpc}
        deployments={props.deployments}
        label={props.label}
        revoked={props.revoked}
        onChanged={props.onChanged}
      />
    </Suspense>
  );
}

/// Dev server mode: keys from the repo root .env, never in the browser.
function ServerControls({ status, onChanged, revoked, deployments }: Props & { status: Status }) {
  const parentName = deployments?.parentName ?? "";
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
  const actions: RoleActions = {
    tighten: async (cap) => {
      const r = await post("/api/demo/tighten", { cap });
      return { tone: tone(r), text: `Cap set to ${cap} lUSD.`, txHash: String(r.txHash) };
    },
    forbid: async () => {
      const r = await post("/api/demo/forbid", {});
      const results = r.results as { ok: boolean; text: string }[];
      return {
        tone: results.every((x) => x.ok) ? "ok" : "bad",
        text: results.map((x) => x.text).join(" · "),
      };
    },
    slippage: async (bps) => {
      const r = await post("/api/demo/slippage", { bps });
      return {
        tone: tone(r),
        text: `Max slippage set to ${bps} bps (${Number(bps) / 100}%).`,
        txHash: String(r.txHash),
      };
    },
    cut: async () => {
      const r = await post("/api/demo/cut", {});
      return {
        tone: tone(r),
        text: `${status.name} cut, expiry ${String(r.expiry)}.`,
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
      });
      if (r.status !== "success")
        return { tone: "bad", text: "Reverted on chain.", txHash: String(r.txHash) };
      return issuedOutcome(form, parentName, BigInt(String(r.expiry)), String(r.txHash));
    },
  };
  const open: RoleGate = { canSign: true };
  return (
    <RoleCards
      actions={actions}
      riskManager={status.riskManager}
      owner={status.owner}
      riskGate={open}
      ownerGate={open}
      revoked={revoked}
      onChanged={onChanged}
      parentName={parentName}
      defaultAgent={deployments?.agent ?? ""}
    />
  );
}

type CardsProps = {
  actions: RoleActions;
  riskManager: string | null;
  owner: string | null;
  riskGate: RoleGate;
  ownerGate: RoleGate;
  revoked: boolean;
  onChanged: () => void;
  /// Rendered above the two roles, e.g. the wallet bar.
  header?: ReactNode;
  /// Explorer transaction URL prefix, e.g. `https://sepolia.etherscan.io/tx/`.
  txUrl?: string;
  /// The org name new agents are issued under, e.g. `leash.eth`.
  parentName: string;
  /// Prefilled agent address: the demo agent key, so the agent terminal can trade under the new name.
  defaultAgent: string;
};

export function RoleCards({
  actions,
  riskManager,
  owner,
  riskGate,
  ownerGate,
  revoked,
  onChanged,
  header,
  txUrl,
  parentName,
  defaultAgent,
}: CardsProps) {
  const [cap, setCap] = useState("10");
  const [slippage, setSlippage] = useState("50");
  const [busy, setBusy] = useState<string | null>(null);
  const [riskOut, setRiskOut] = useState<Outcome>(null);
  const [ownerOut, setOwnerOut] = useState<Outcome>(null);
  const [issueOut, setIssueOut] = useState<Outcome>(null);
  const [form, setForm] = useState<IssueForm>({
    label: "trader-2",
    agent: defaultAgent,
    cap: "100",
    bps: "50",
    duration: "7",
    unit: "days",
  });
  const setField = <K extends keyof IssueForm>(key: K, value: IssueForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  // The deployment record loads after the first render: prefill the agent once it is known.
  useEffect(() => {
    if (defaultAgent) setForm((f) => (f.agent ? f : { ...f, agent: defaultAgent }));
  }, [defaultAgent]);
  const formError = issueFormError(form);

  const run = async (key: string, set: (o: Outcome) => void, action: () => Promise<Outcome>) => {
    setBusy(key);
    set({ tone: "info", text: "Sending…" });
    try {
      set(await action());
      onChanged();
    } catch (err) {
      set({ tone: "bad", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const riskOff = busy !== null || revoked || !riskGate.canSign;
  const ownerOff = busy !== null || revoked || !ownerGate.canSign;

  return (
    <section className="controls" aria-label="controls">
      {header}
      <div className="role">
        <div className="role-head">
          <h2 className="role-name">Risk manager</h2>
          {riskManager && (
            <span className="addr hint" title={riskManager}>
              {shortHex(riskManager)}
            </span>
          )}
        </div>
        <p className="role-hint">
          Can edit two records of the agent's name, <code>leash.dailyNotional</code> and{" "}
          <code>leash.tokens</code>. Nothing else, not even <code>leash.maxSlippageBps</code>.
        </p>
        <div className="role-row">
          <label className="field">
            <span>daily cap</span>
            <input
              id="risk-cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              inputMode="decimal"
              size={8}
              disabled={riskOff}
            />
            <span className="unit">lUSD</span>
          </label>
          <button
            className="btn"
            disabled={riskOff || !/^\d+(\.\d+)?$/.test(cap)}
            onClick={() => run("tighten", setRiskOut, () => actions.tighten(cap))}
          >
            {busy === "tighten" ? "Sending…" : "Tighten the leash"}
          </button>
          <button
            className="ghost"
            disabled={busy !== null}
            title="Simulate unregister, setAddress, setText(leash.quote) and clearing leash.maxSlippageBps as the risk manager. All four must revert."
            onClick={() => run("forbid", setRiskOut, actions.forbid)}
          >
            {busy === "forbid" ? "Trying…" : "Try to revoke"}
          </button>
        </div>
        {!riskGate.canSign && <p className="role-gate">{riskGate.reason}</p>}
        <OutcomeLine outcome={riskOut} txUrl={txUrl} />
      </div>

      <div className="role owner">
        <div className="role-head">
          <h2 className="role-name">Owner</h2>
          {owner && (
            <span className="addr hint" title={owner}>
              {shortHex(owner)}
            </span>
          )}
        </div>
        <p className="role-hint">
          Owns the parent name and the org registry. Revoking is one transaction, no key rotation.
          The only one who can set <code>leash.maxSlippageBps</code>.
        </p>
        <div className="role-row">
          <label className="field">
            <span>max slippage</span>
            <input
              id="owner-slippage"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              inputMode="numeric"
              size={6}
              disabled={ownerOff}
              title={slippageInputError(slippage) ?? `${Number(slippage) / 100}% of the pool price`}
            />
            <span className="unit">bps</span>
          </label>
          <button
            className="btn"
            disabled={ownerOff || slippageInputError(slippage) !== null}
            onClick={() => run("slippage", setOwnerOut, () => actions.slippage(slippage))}
          >
            {busy === "slippage" ? "Sending…" : "Set slippage"}
          </button>
          <button
            className="btn danger"
            disabled={ownerOff}
            onClick={() => run("cut", setOwnerOut, actions.cut)}
          >
            {busy === "cut" ? "Cutting…" : revoked ? "Leash cut" : "Cut the leash"}
          </button>
        </div>
        {!ownerGate.canSign && <p className="role-gate">{ownerGate.reason}</p>}
        <OutcomeLine outcome={ownerOut} txUrl={txUrl} />
      </div>

      <div className="role owner issue">
        <div className="role-head">
          <h2 className="role-name">New agent</h2>
          <span className="hint">signed by the owner</span>
        </div>
        <p className="role-hint">
          Issue a subname with its own mandate: address record, daily cap, max slippage and expiry.
          Two transactions, no new contract. An expired or cut name can be issued again.
        </p>
        <div className="issue-fields">
          <label className="field">
            <span>name</span>
            <input
              id="issue-label"
              className="wide"
              value={form.label}
              onChange={(e) => setField("label", e.target.value.trim().toLowerCase())}
              disabled={busy !== null || !ownerGate.canSign}
            />
            <span className="unit">.{parentName}</span>
          </label>
          <label className="field">
            <span>agent</span>
            <input
              id="issue-agent"
              className="wide addr"
              value={form.agent}
              onChange={(e) => setField("agent", e.target.value.trim())}
              disabled={busy !== null || !ownerGate.canSign}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>daily cap</span>
            <input
              id="issue-cap"
              value={form.cap}
              onChange={(e) => setField("cap", e.target.value)}
              inputMode="decimal"
              disabled={busy !== null || !ownerGate.canSign}
            />
            <span className="unit">lUSD</span>
          </label>
          <label className="field">
            <span>max slippage</span>
            <input
              id="issue-bps"
              value={form.bps}
              onChange={(e) => setField("bps", e.target.value)}
              inputMode="numeric"
              disabled={busy !== null || !ownerGate.canSign}
            />
            <span className="unit">bps</span>
          </label>
          <label className="field">
            <span>mandate</span>
            <input
              id="issue-duration"
              value={form.duration}
              onChange={(e) => setField("duration", e.target.value)}
              inputMode="decimal"
              disabled={busy !== null || !ownerGate.canSign}
            />
            <select
              id="issue-unit"
              value={form.unit}
              onChange={(e) => setField("unit", e.target.value as IssueForm["unit"])}
              disabled={busy !== null || !ownerGate.canSign}
            >
              <option value="minutes">minutes</option>
              <option value="days">days</option>
            </select>
          </label>
        </div>
        <div className="role-row">
          <button
            className="btn"
            disabled={busy !== null || !ownerGate.canSign || formError !== null}
            title={formError ?? undefined}
            onClick={() => run("issue", setIssueOut, () => actions.issue(form))}
          >
            {busy === "issue" ? "Issuing…" : "Issue agent"}
          </button>
          {formError && ownerGate.canSign && <span className="hint">{formError}</span>}
        </div>
        {!ownerGate.canSign && <p className="role-gate">{ownerGate.reason}</p>}
        <OutcomeLine outcome={issueOut} txUrl={txUrl} />
      </div>
    </section>
  );
}

function OutcomeLine({ outcome, txUrl }: { outcome: Outcome; txUrl?: string }) {
  if (!outcome) return null;
  return (
    <div className={`outcome ${outcome.tone}`}>
      {outcome.text}
      {outcome.txHash && (
        <>
          {" "}
          Tx{" "}
          {txUrl ? (
            <a href={`${txUrl}${outcome.txHash}`} target="_blank" rel="noreferrer">
              {shortHex(outcome.txHash, 10, 6)}
            </a>
          ) : (
            shortHex(outcome.txHash, 10, 6)
          )}
        </>
      )}
      {outcome.link && (
        <>
          {" "}
          <a href={outcome.link.href}>{outcome.link.text}</a>
        </>
      )}
    </div>
  );
}

/// viem errors carry a one line `shortMessage`; a rejected wallet prompt should read as such.
function errorText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; name?: string };
  if (e?.name === "UserRejectedRequestError" || /rejected/i.test(e?.shortMessage ?? "")) {
    return "Signature rejected in the wallet, nothing was sent.";
  }
  return e?.shortMessage ?? e?.message ?? String(err);
}
