import type { ReactNode } from "react";
import type { Snapshot } from "../lib/chain";
import type { Deployments } from "../lib/leash";
import { CopyHex } from "./CopyHex";

type Props = {
  snapshot: Snapshot | null;
  deployments: Deployments | null;
};

const ZERO = "0x0000000000000000000000000000000000000000";

/// The facts behind the leash, as two rows of definitions: what the mandate says, where it lives.
export function Cards({ snapshot, deployments }: Props) {
  const policy = snapshot?.policy.value ?? null;
  const lastKnown = policy?.source === "resolver";
  const quote = policy?.quote ?? deployments?.quote ?? null;

  return (
    <section className="facts" aria-label="facts">
      <div className="facts-row">
        <h2>
          Mandate {lastKnown && <span className="note">last known, the hook refuses the name</span>}
        </h2>
        <dl>
          <Fact label="agent" error={snapshot?.policy.error}>
            <Addr value={policy?.agent ?? null} />
          </Fact>
          <Fact label="nonce">
            {snapshot?.nonce.value !== null && snapshot?.nonce.value !== undefined ? (
              <span className="num">{snapshot.nonce.value.toString()}</span>
            ) : (
              <Pending />
            )}
          </Fact>
          <Fact label="quote token">
            <Addr value={quote} />
            {quote && deployments && (
              <small>
                {quote.toLowerCase() === deployments.token0?.toLowerCase() ? "token0" : "token1"}
              </small>
            )}
          </Fact>
          <Fact label="max slippage" error={snapshot?.policy.error}>
            {policy ? (
              policy.maxSlippageError ? (
                <span className="fact-error" title={policy.maxSlippageError}>
                  {policy.maxSlippageError}
                </span>
              ) : policy.maxSlippageBps === null ? (
                <small>not bounded</small>
              ) : (
                <>
                  <span className="num">{Number(policy.maxSlippageBps) / 100}%</span>
                  <small>{policy.maxSlippageBps.toString()} bps</small>
                </>
              )
            ) : (
              <Pending />
            )}
          </Fact>
          <Fact label="allowed tokens" error={snapshot?.policy.error}>
            {policy ? (
              policy.tokens.length === 0 ? (
                <small>none</small>
              ) : (
                <span className="token-list">
                  {policy.tokens.map((t) => (
                    <span key={t}>
                      <Addr value={t} />
                      {deployments && <small>{tokenRole(t, deployments)}</small>}
                    </span>
                  ))}
                </span>
              )
            ) : (
              <Pending />
            )}
          </Fact>
        </dl>
      </div>

      <div className="facts-row">
        <h2>Onchain</h2>
        <dl>
          <Fact label="name owner" error={snapshot?.owner.error}>
            <Addr value={snapshot?.owner.value ?? null} />
            {snapshot?.owner.value === ZERO && <small>burned, unregistered</small>}
          </Fact>
          <Fact label="hook">
            <Addr value={deployments?.hook ?? null} />
          </Fact>
          <Fact label="org registry">
            <Addr value={deployments?.orgRegistry ?? null} />
            <small title={deployments?.parentNode}>parent {deployments?.parentName ?? "?"}</small>
          </Fact>
          <Fact label="resolver" error={snapshot?.resolver.error}>
            <Addr value={snapshot?.resolver.value ?? null} />
            {snapshot?.resolver.value === ZERO && <small>none, name expired or revoked</small>}
          </Fact>
        </dl>
      </div>
    </section>
  );
}

function tokenRole(t: string, d: Deployments): string {
  const l = t.toLowerCase();
  const parts: string[] = [];
  if (l === d.token0?.toLowerCase()) parts.push("token0");
  if (l === d.token1?.toLowerCase()) parts.push("token1");
  if (l === d.quote?.toLowerCase()) parts.push("quote");
  return parts.join(", ");
}

function Fact({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>
        {children}
        {error && (
          <span className="fact-error" title={error}>
            {error}
          </span>
        )}
      </dd>
    </div>
  );
}

function Addr({ value }: { value: string | null }) {
  if (!value) return <Pending />;
  return <CopyHex value={value} />;
}

function Pending() {
  return <span className="pending">…</span>;
}
