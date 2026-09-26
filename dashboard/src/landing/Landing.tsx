import type { CSSProperties, ReactNode } from "react";
import { Logo } from "../components/Logo";
import { Icon, type IconName } from "./icons";

const REPO = "https://github.com/akugone/leash-tokyo";
const DASHBOARD = "/app?label=trader-1";

/// Deterministic pseudo random, so the drift layout is stable across reloads.
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

const DRIFT_ICONS: IconName[] = [
  "robot", "key", "shield", "coin", "robot", "chart", "link", "lock",
  "robot", "clock", "swap", "signature", "robot", "coin", "key", "shield",
  "robot", "chart", "lock", "swap", "robot", "link", "clock", "coin",
];

const drift = (() => {
  const r = rng(42);
  return DRIFT_ICONS.map((name, i) => ({
    name,
    key: i,
    style: {
      left: `${(i % 6) * 16.6 + r() * 12}%`,
      top: `${Math.floor(i / 6) * 25 + r() * 18}%`,
      width: `${18 + r() * 18}px`,
      opacity: 0.1 + r() * 0.16,
      "--dx": `${(r() - 0.5) * 120}px`,
      "--dy": `${(r() - 0.5) * 90}px`,
      "--rot": `${(r() - 0.5) * 40}deg`,
      animationDuration: `${22 + r() * 22}s`,
      animationDelay: `${-r() * 30}s`,
    } as CSSProperties,
  }));
})();

export function Landing() {
  return (
    <div className="lp">
      <Nav />
      <Hero />
      <main>
        <WhatAndWho />
        <Problems />
        <HowItWorks />
        <InsideTheHook />
        <GetStarted />
        <Market />
        <Closing />
      </main>
      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <span className="lp-brand">
            <Logo className="lp-logo" /> Leash
          </span>
          <span className="lp-muted">ENS holds the mandate. A Uniswap v4 hook enforces it.</span>
          <a href={REPO}>GitHub</a>
        </div>
      </footer>
    </div>
  );
}


function Nav() {
  return (
    <header className="lp-nav">
      <div className="lp-wrap lp-nav-row">
        <a className="lp-brand" href="/">
          <Logo className="lp-logo" /> Leash
        </a>
        <nav className="lp-links" aria-label="Sections">
          <a href="#what">What</a>
          <a href="#use-cases">Use cases</a>
          <a href="#how">How it works</a>
          <a href="#hook">Hook</a>
          <a href="#start">Get started</a>
          <a href="#market">Market</a>
        </nav>
        <a className="lp-btn lp-btn-dark lp-btn-sm" href={DASHBOARD}>
          Dashboard
        </a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="lp-hero">
      <div className="lp-drift" aria-hidden="true">
        {drift.map((d) => (
          <Icon key={d.key} name={d.name} className="lp-drift-icon" style={d.style} />
        ))}
      </div>
      <div className="lp-wrap lp-hero-inner">
        <span className="lp-chip">
          <Icon name="shield" /> Built on ENSv2 and Uniswap v4
        </span>
        <h1>
          Put your trading agents
          <br />
          on a leash.
        </h1>
        <p className="lp-lede">
          Give an AI agent or a bot the right to trade for your treasury, within limits you set and
          can pull back in one transaction. Name it, bound it, revoke it.
        </p>
        <div className="lp-cta">
          <a className="lp-btn lp-btn-dark" href="#start">
            Get started <Icon name="arrow" />
          </a>
          <a className="lp-btn" href={DASHBOARD}>
            Open the dashboard
          </a>
        </div>
        <HeroConsole />
      </div>
    </section>
  );
}

/// Replays the demo script: one swap goes through, one hits the cap, one after the leash is cut.
function HeroConsole() {
  const rows: { ok: boolean; text: string; note: string }[] = [
    { ok: true, text: "trader-1.acme.eth  buy 25 lUSD of lETH", note: "swap settled · 10% of daily cap" },
    { ok: false, text: "trader-1.acme.eth  buy 300 lUSD of lETH", note: "DailyCapExceeded" },
    { ok: false, text: "risk-manager  unregister(trader-1)", note: "EACUnauthorizedAccountRoles" },
    { ok: false, text: "trader-1.acme.eth  buy 5 lUSD of lETH", note: "LeashRevoked" },
  ];
  return (
    <div className="lp-console" role="img" aria-label="Example of swaps checked by the Leash hook">
      <div className="lp-console-bar">
        <span />
        <span />
        <span />
        <em>leash hook · beforeSwap / afterSwap</em>
      </div>
      <ol>
        {rows.map((r, i) => (
          <li key={i} style={{ animationDelay: `${0.4 + i * 0.7}s` }}>
            <span className={r.ok ? "lp-ok" : "lp-ko"}>{r.ok ? "✓" : "✕"}</span>
            <code>{r.text}</code>
            <span className="lp-note">{r.note}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function SectionHead({ id, eyebrow, title, children }: {
  id: string;
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="lp-head" id={id}>
      <span className="lp-eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {children && <p className="lp-sub">{children}</p>}
    </div>
  );
}

function WhatAndWho() {
  const who: { icon: IconName; title: string; body: string }[] = [
    {
      icon: "building",
      title: "DAOs and treasuries",
      body: "Let a bot rebalance or run a strategy without handing it the keys to the whole treasury.",
    },
    {
      icon: "chart",
      title: "Trading desks and funds",
      body: "Run many agents, one name each, with a risk desk that can tighten limits in real time.",
    },
    {
      icon: "robot",
      title: "AI agent builders",
      body: "Ship agents that trade onchain with a credential a user can inspect, cap and kill.",
    },
  ];
  return (
    <section className="lp-section">
      <div className="lp-wrap">
        <SectionHead id="what" eyebrow="01 · What is Leash" title="ENS holds the mandate. The hook enforces it.">
          The agent's ENS subname carries its identity and limits. A Uniswap v4 hook checks them on
          every swap, inside the pool. Revoked, expired or over the limit: the swap reverts.
        </SectionHead>
        <div className="lp-callout">
          <Icon name="link" />
          <p>
            <b>trader-1.acme.eth</b> is not a label on a dashboard. It is the credential. Its{" "}
            <code>addr</code> record is the only key that may sign for it, its text records are the
            limits, its expiry is the mandate's end date.
          </p>
        </div>
        <h3 className="lp-h3">Who it is for</h3>
        <div className="lp-grid lp-grid-3">
          {who.map((w) => (
            <article className="lp-card" key={w.title}>
              <Icon name={w.icon} className="lp-card-icon" />
              <h4>{w.title}</h4>
              <p>{w.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Problems() {
  const problems = [
    { t: "All or nothing keys", d: "A bot's key holds full authority over everything the account can touch." },
    { t: "One leak, empty treasury", d: "If the key leaks or the agent misbehaves, funds leave in one block." },
    { t: "Slow revocation", d: "Stopping an agent means rotating keys and redeploying, not flipping a switch." },
  ];
  const cases: { icon: IconName; title: string; body: string }[] = [
    { icon: "coin", title: "Daily notional caps", body: "Cap what an agent can move per UTC day, measured on the real settlement delta, not an oracle." },
    { icon: "lock", title: "Token allowlists", body: "Restrict an agent to the pairs it is meant to trade. Anything else reverts in beforeSwap." },
    { icon: "chart", title: "Slippage bounds", body: "Cap the price impact of every swap with leash.maxSlippageBps. A looser price limit reverts with SlippageTooLoose." },
    { icon: "clock", title: "Time boxed mandates", body: "Give a subname an expiry. The mandate lapses on its own, no one has to remember." },
    { icon: "user", title: "Split duties", body: "A risk manager edits the limits, never the identity. Only the owner can issue or revoke." },
    { icon: "scissors", title: "Instant kill switch", body: "Cut the leash: unregister the subname and the next swap reverts with LeashRevoked." },
    { icon: "signature", title: "Router agnostic", body: "The agent signs an EIP-712 intent, so any Uniswap v4 router works. No bespoke frontend." },
  ];
  return (
    <section className="lp-section lp-alt">
      <div className="lp-wrap">
        <SectionHead id="use-cases" eyebrow="02 · The problem" title="Delegating to a bot is all or nothing.">
          Treasuries and desks hand private keys to bots and AI agents. There is no onchain answer
          to a simple question: is this address still allowed to trade for us, and within what
          limits?
        </SectionHead>
        <div className="lp-problems">
          {problems.map((p) => (
            <div key={p.t}>
              <span className="lp-ko">✕</span>
              <div>
                <b>{p.t}</b>
                <p>{p.d}</p>
              </div>
            </div>
          ))}
        </div>
        <h3 className="lp-h3">What Leash lets you do</h3>
        <div className="lp-grid lp-grid-3">
          {cases.map((c) => (
            <article className="lp-card" key={c.title}>
              <Icon name={c.icon} className="lp-card-icon" />
              <h4>{c.title}</h4>
              <p>{c.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps: { n: string; title: string; body: string }[] = [
    { n: "1", title: "Own a namespace", body: "The org owns acme.eth and deploys its own ENSv2 Permissioned Registry." },
    { n: "2", title: "Issue the agent", body: "Register trader-1.acme.eth with an expiry. Its addr record is the agent's key." },
    { n: "3", title: "Write the policy", body: "Text records hold the quote token, daily cap, allowed tokens and max slippage." },
    { n: "4", title: "Sign and swap", body: "The agent signs a SwapIntent and passes it in hookData through any v4 router." },
    { n: "5", title: "Hook enforces", body: "Every swap is checked in the pool before and after it settles. See below." },
  ];
  const stack: { layer: string; role: string }[] = [
    { layer: "ENSv2 Permissioned Registry", role: "The org's namespace. Issues and revokes agent identities." },
    { layer: "Subname expiry", role: "Time boxed mandates that lapse on their own." },
    { layer: "ENSv2 Permissioned Resolver", role: "Where the risk policy lives, read onchain by the hook on every swap." },
    { layer: "Enhanced Access Control", role: "Per record delegation: the risk desk edits leash.dailyNotional, never the name." },
    { layer: "Uniswap v4 hook", role: "beforeSwap and afterSwap. The enforcement point, at the venue itself." },
    { layer: "EIP-712 SwapIntent", role: "Name, pool, direction, amount, nonce, deadline. Signed by the agent." },
  ];
  return (
    <section className="lp-section">
      <div className="lp-wrap">
        <SectionHead id="how" eyebrow="03 · How it works" title="Identity in ENS. Enforcement in the pool." />
        <ol className="lp-steps">
          {steps.map((s) => (
            <li key={s.n}>
              <span className="lp-step-n">{s.n}</span>
              <h4>{s.title}</h4>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="lp-split">
          <div>
            <h3 className="lp-h3">The policy, as ENS records</h3>
            <pre className="lp-code">
              <code>
                <span className="lp-c">{"# trader-1.acme.eth"}</span>
                {"\naddr                 0xA9e1…42c0"}
                {"\nleash.quote          0x…lUSD"}
                {"\nleash.dailyNotional  250000000"}
                {"\nleash.tokens         0x…lETH,0x…lUSD"}
                {"\nleash.maxSlippageBps 100"}
                {"\nexpiry               2026-12-31"}
              </code>
            </pre>
            <p className="lp-muted lp-small">
              Human readable strings, parsed onchain by LeashPolicyLib. The cap is in raw quote token
              units, per UTC day, across every pool that uses the hook.
            </p>
          </div>
          <div>
            <h3 className="lp-h3">Stack</h3>
            <table className="lp-table">
              <tbody>
                {stack.map((s) => (
                  <tr key={s.layer}>
                    <th>{s.layer}</th>
                    <td>{s.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

/// The enforcement point, at a glance: what beforeSwap checks, what afterSwap counts, and why it holds.
function InsideTheHook() {
  const checks: { what: string; error: string }[] = [
    { what: "Name is alive", error: "LeashRevoked" },
    { what: "Signed by the addr record", error: "BadSignature" },
    { what: "Fresh, used once", error: "BadNonce" },
    { what: "Matches the swap", error: "IntentMismatch" },
    { what: "Tokens allowed", error: "TokenNotAllowed" },
    { what: "Price impact bounded", error: "SlippageTooLoose" },
  ];
  const traits: { t: string; d: string }[] = [
    { t: "Live policy", d: "Read from the resolver on every swap. No cache." },
    { t: "Fails closed", d: "A malformed record reverts the swap, never loosens it." },
    { t: "No oracle", d: "The cap counts the settled delta, not a price feed." },
  ];
  return (
    <section className="lp-section lp-alt">
      <div className="lp-wrap">
        <SectionHead id="hook" eyebrow="04 · Inside the hook" title="Every swap passes two checkpoints.">
          The hook lives in the pool, so the check is part of the swap. No agent can route around it.
        </SectionHead>
        <div className="lp-flow">
          <article className="lp-flow-step">
            <code className="lp-flow-tag">beforeSwap</code>
            <ul className="lp-checks">
              {checks.map((c) => (
                <li key={c.error}>
                  <span>{c.what}</span>
                  <code>{c.error}</code>
                </li>
              ))}
            </ul>
          </article>
          <span className="lp-flow-arrow" aria-hidden="true">→</span>
          <article className="lp-flow-step lp-flow-mid">
            <code className="lp-flow-tag">swap</code>
            <p>Uniswap v4 settles the trade, through any router.</p>
          </article>
          <span className="lp-flow-arrow" aria-hidden="true">→</span>
          <article className="lp-flow-step">
            <code className="lp-flow-tag">afterSwap</code>
            <p>The real amount moved is added to today's spend.</p>
            <ul className="lp-checks">
              <li>
                <span>Over the daily cap</span>
                <code>DailyCapExceeded</code>
              </li>
            </ul>
          </article>
        </div>
        <div className="lp-grid lp-grid-3">
          {traits.map((t) => (
            <article className="lp-card lp-card-plain" key={t.t}>
              <h4>{t.t}</h4>
              <p>{t.d}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function GetStarted() {
  const roles: { icon: IconName; who: string; does: string[] }[] = [
    {
      icon: "building",
      who: "Org owner",
      does: [
        "Register the parent name and deploy the org registry, resolver and hook",
        "Issue a subname per agent, with an expiry",
        "Grant the risk-manager role on the policy keys only",
        "Set the slippage bound, leash.maxSlippageBps, which only the owner can change",
        "Cut the leash when needed",
      ],
    },
    {
      icon: "shield",
      who: "Risk manager",
      does: [
        "Watch spend against the cap on the dashboard",
        "Tighten leash.dailyNotional or leash.tokens at any time",
        "Cannot mint, revoke or re-point an agent, nor loosen the slippage bound",
      ],
    },
    {
      icon: "robot",
      who: "Agent",
      does: [
        "Reads its enforced policy before trading",
        "Signs an EIP-712 SwapIntent per swap",
        "Runs as a CLI bot or as Claude Code with two MCP tools: leash_policy and leash_swap",
      ],
    },
  ];
  return (
    <section className="lp-section">
      <div className="lp-wrap">
        <SectionHead id="start" eyebrow="05 · Get started" title="Three roles, one name.">
          Each party gets exactly the authority it needs, enforced by ENS roles rather than by a
          promise in an ops doc.
        </SectionHead>
        <div className="lp-grid lp-grid-3">
          {roles.map((r) => (
            <article className="lp-card" key={r.who}>
              <Icon name={r.icon} className="lp-card-icon" />
              <h4>{r.who}</h4>
              <ul className="lp-list">
                {r.does.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <h3 className="lp-h3">Run the demo locally</h3>
        <div className="lp-split">
          <pre className="lp-code">
            <code>
              <span className="lp-c">{"# anvil fork of Sepolia, real ENSv2 + Uniswap v4"}</span>
              {"\nscript/demo.sh anvil"}
              <span className="lp-c">{"\n\n# register leash.eth, deploy registry, resolver,\n# hook and pool, issue trader-1 with its policy"}</span>
              {"\nscript/demo.sh setup"}
              <span className="lp-c">{"\n\n# dashboard on http://localhost:5173/app"}</span>
              {"\ncd dashboard && bun run dev"}
              <span className="lp-c">{"\n\n# Claude Code as trader-1"}</span>
              {"\nscript/demo.sh agent"}
            </code>
          </pre>
          <div className="lp-demo-steps">
            <p><b>Try it.</b> Ask the agent to <code>buy 25 lUSD of lETH</code>: the swap settles and the leash bar moves.</p>
            <p>Ask for <code>300 lUSD</code>: the hook answers <code>DailyCapExceeded</code>, nothing moves.</p>
            <p>As risk manager, tighten the cap. Try to revoke: <code>EACUnauthorizedAccountRoles</code>.</p>
            <p>As owner, cut the leash. The next trade reverts with <code>LeashRevoked</code>.</p>
            <div className="lp-cta">
              <a className="lp-btn lp-btn-dark" href={DASHBOARD}>Open the dashboard</a>
              <a className="lp-btn" href={REPO}>View on GitHub</a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Market() {
  const cols = ["Hot key in a bot", "Multisig + modules", "Session keys", "Custodial policy engine", "Leash"];
  const rows: { label: string; v: (boolean | "partial")[] }[] = [
    { label: "Enforced onchain, at the venue", v: [false, "partial", "partial", false, true] },
    { label: "Agent keeps its own key", v: [true, false, true, false, true] },
    { label: "Human readable, public identity", v: [false, false, false, false, true] },
    { label: "Scoped role for a risk desk", v: [false, "partial", false, true, true] },
    { label: "One transaction revocation", v: [false, "partial", true, true, true] },
    { label: "Works with any router", v: [true, false, "partial", false, true] },
  ];
  const value: { t: string; d: string }[] = [
    { t: "ENS is the product, not decoration", d: "Registry, expiry, resolver and access control each carry a real role. Strip ENS out and the design collapses into a bespoke allowlist contract." },
    { t: "Enforcement where the trade happens", d: "The hook sits in the pool. A compromised agent cannot route around it, because the check is part of the swap." },
    { t: "No oracle, no custody change", d: "Caps are counted on the real BalanceDelta. Funds stay where they are. Nothing new to trust but the org's own registry." },
  ];
  const mark = (v: boolean | "partial") =>
    v === true ? <span className="lp-ok">✓</span> : v === "partial" ? <span className="lp-muted">~</span> : <span className="lp-ko">✕</span>;
  return (
    <section className="lp-section lp-alt">
      <div className="lp-wrap">
        <SectionHead id="market" eyebrow="06 · Where it fits" title="The missing permission layer for onchain agents.">
          Autonomous agents are starting to trade real money. Today's options either trust the bot
          with everything, or move custody somewhere else. Leash sits in between: identity and limits
          in ENS, enforcement in the pool.
        </SectionHead>
        <div className="lp-table-wrap">
          <table className="lp-compare">
            <thead>
              <tr>
                <th />
                {cols.map((c) => (
                  <th key={c} className={c === "Leash" ? "lp-hl" : undefined}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th>{r.label}</th>
                  {r.v.map((v, i) => (
                    <td key={i} className={i === cols.length - 1 ? "lp-hl" : undefined}>{mark(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="lp-muted lp-small">~ partial: depends on the setup or the modules installed.</p>
        <div className="lp-grid lp-grid-3">
          {value.map((v) => (
            <article className="lp-card lp-card-plain" key={v.t}>
              <h4>{v.t}</h4>
              <p>{v.d}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="lp-closing">
      <div className="lp-wrap">
        <h2>Name your agent. Bound it. Revoke it.</h2>
        <div className="lp-cta lp-cta-center">
          <a className="lp-btn lp-btn-dark" href={DASHBOARD}>Open the dashboard</a>
          <a className="lp-btn" href={REPO}>Read the code</a>
        </div>
      </div>
    </section>
  );
}
