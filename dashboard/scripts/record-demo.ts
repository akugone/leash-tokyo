/**
 * Record the Leash demo (docs/demo.md, acts 1 to 5) as a video with Playwright.
 *
 * The browser shows the dashboard. Between acts the script runs the same shell commands as the
 * demo doc (agent bot, script/demo.sh) and mirrors their output in a terminal panel drawn over the
 * page, so the video is self explanatory.
 *
 *   bun run scripts/record-demo.ts                # writes docs/demo/leash-demo.webm (+ .mp4 when ffmpeg can)
 *
 * Preconditions (see docs/demo.md "Before the show"):
 *   - `script/demo.sh anvil` and `script/demo.sh setup` done, trader-1 LIVE with nothing spent today
 *   - the dashboard dev server on DASHBOARD_URL (default http://localhost:5173)
 *
 * Env: DASHBOARD_URL, RPC_URL (default http://127.0.0.1:8545), LEASH_DEPLOYMENTS_FILE
 * (default deployments/anvil.json), OUT_DIR (default docs/demo), HEADED=1 to watch the browser.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

// ============ Config ============

const dashboardDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(dashboardDir, "..");
const agentDir = join(repoDir, "agent");

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:5173";
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const DEPLOYMENTS_FILE = process.env.LEASH_DEPLOYMENTS_FILE ?? "deployments/anvil.json";
const OUT_DIR = resolve(repoDir, process.env.OUT_DIR ?? "docs/demo");
const LABEL = "trader-1";
const NEW_CAP = "10000000000000000000"; // 10 lUSD, as in docs/demo.md act 4

const SIZE = { width: 1440, height: 900 };
/** Slow the pace down so a viewer can read each state. */
const HOLD = { title: 3_500, act: 6_000, output: 5_000 };

const childEnv = {
  ...process.env,
  RPC_URL,
  LEASH_DEPLOYMENTS_FILE: DEPLOYMENTS_FILE,
  FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
  FORCE_COLOR: "0",
  NO_COLOR: "1",
};

// ============ Overlay drawn over the dashboard ============

const OVERLAY_CSS = `
#leash-demo-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 9999;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#leash-demo-overlay .act { position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  background: rgba(11,15,20,.92); color: #e6edf3; border: 1px solid #2b3540; border-radius: 10px;
  padding: 10px 18px; font-size: 15px; letter-spacing: .02em; box-shadow: 0 8px 30px rgba(0,0,0,.5);
  transition: opacity .3s; white-space: nowrap; }
#leash-demo-overlay .act b { color: #33d17a; margin-right: 10px; }
#leash-demo-overlay .term { position: absolute; right: 24px; bottom: 24px; width: 620px; max-height: 44%;
  background: rgba(8,11,15,.94); color: #d7dee6; border: 1px solid #2b3540; border-radius: 10px;
  padding: 14px 16px; font-size: 12.5px; line-height: 1.5; overflow: hidden;
  box-shadow: 0 8px 30px rgba(0,0,0,.55); white-space: pre-wrap; word-break: break-all; }
#leash-demo-overlay .term .cmd { color: #8ab4f8; }
#leash-demo-overlay .term .cmd::before { content: "$ "; color: #33d17a; }
#leash-demo-overlay .term .ok { color: #33d17a; }
#leash-demo-overlay .term .bad { color: #ff6b6b; }
#leash-demo-overlay .term .dim { color: #7d8896; }
#leash-demo-overlay .title { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px; background: rgba(11,15,20,.97); color: #e6edf3; }
#leash-demo-overlay .title h1 { font-size: 56px; margin: 0; letter-spacing: .04em; }
#leash-demo-overlay .title h1 span { color: #33d17a; }
#leash-demo-overlay .title p { font-size: 20px; color: #9aa7b4; margin: 0; max-width: 820px; text-align: center;
  font-family: -apple-system, system-ui, sans-serif; }
`;

class Overlay {
  constructor(private page: Page) {}

  async mount() {
    await this.page.evaluate((css) => {
      const root = document.createElement("div");
      root.id = "leash-demo-overlay";
      root.innerHTML = `<style>${css}</style><div class="act" style="opacity:0"></div><div class="term" hidden></div>`;
      document.body.appendChild(root);
      // Reserve a strip above the dashboard for the act banner so it never hides the name or the status pill.
      document.body.style.paddingTop = "64px";
    }, OVERLAY_CSS);
  }

  async title(heading: string, sub: string) {
    await this.page.evaluate(
      ([h, s]) => {
        const root = document.getElementById("leash-demo-overlay")!;
        const el = document.createElement("div");
        el.className = "title";
        el.innerHTML = `<h1>${h}</h1><p>${s}</p>`;
        root.appendChild(el);
      },
      [heading, sub],
    );
  }

  async clearTitle() {
    await this.page.evaluate(() => document.querySelector("#leash-demo-overlay .title")?.remove());
  }

  async act(n: number, text: string) {
    await this.page.evaluate(
      ([n, t]) => {
        const el = document.querySelector<HTMLElement>("#leash-demo-overlay .act")!;
        el.innerHTML = `<b>ACT ${n}</b>${t}`;
        el.style.opacity = "1";
      },
      [String(n), text],
    );
  }

  async terminal(cmd: string | null, lines: string[] = []) {
    await this.page.evaluate(
      ([cmd, lines]) => {
        const el = document.querySelector<HTMLElement>("#leash-demo-overlay .term")!;
        if (cmd === null) {
          el.hidden = true;
          return;
        }
        const esc = (s: string) =>
          s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
        const cls = (s: string) =>
          /REVERT|revert|EACUnauthorized|LeashRevoked|DailyCapExceeded/.test(s)
            ? "bad"
            : /^\s*(OK|PASS|sent|funded|after:)/.test(s)
              ? "ok"
              : /^(agent |==)/.test(s)
                ? "dim"
                : "";
        el.hidden = false;
        el.innerHTML =
          `<div class="cmd">${esc(cmd)}</div>` +
          lines.map((l) => `<div class="${cls(l)}">${esc(l) || " "}</div>`).join("");
      },
      [cmd, lines] as [string | null, string[]],
    );
  }
}

// ============ Shell helpers ============

type RunResult = { code: number; lines: string[] };

/** Run a command, stream its stdout+stderr into the overlay terminal as lines arrive. */
async function run(
  overlay: Overlay,
  display: string,
  cmd: string,
  args: string[],
  cwd: string,
  keep: (line: string) => boolean = () => true,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  console.log(`\n$ ${display}`);
  const lines: string[] = [];
  await overlay.terminal(display, lines);
  const child = spawn(cmd, args, {
    cwd,
    env: { ...childEnv, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    flushTimer = null;
    await overlay.terminal(display, lines.slice(-18));
  };
  const onData = (buf: Buffer) => {
    pending += buf.toString();
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const raw of parts) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
      console.log(line);
      if (line && keep(line)) lines.push(line);
    }
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), 150);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? 1)));
  if (pending.trim() && keep(pending)) lines.push(pending.trim());
  if (flushTimer) clearTimeout(flushTimer);
  await overlay.terminal(display, lines.slice(-18));
  return { code, lines };
}

const bot = (overlay: Overlay, flags: string[]) =>
  run(
    overlay,
    `bun run src/bot.ts ${flags.join(" ")}`,
    "bun",
    ["run", "src/bot.ts", ...flags],
    agentDir,
    (l) => !l.startsWith("agent 0x"),
  );

/** forge -vv prints a lot; keep the lines the demo doc quotes plus the step headers. */
const demoLine = (l: string) =>
  /^(  |== |Error|error)/.test(l) && !/Gas used|Chain \d+|Estimated/.test(l);

const demo = (overlay: Overlay, sub: string, env: Record<string, string> = {}) =>
  run(
    overlay,
    `${Object.entries(env)
      .map(([k, v]) => `${k}=${v} `)
      .join("")}script/demo.sh ${sub}`,
    "bash",
    ["script/demo.sh", sub],
    repoDir,
    demoLine,
    env,
  );

// ============ Dashboard waits ============

async function waitForBodyText(page: Page, re: RegExp, timeout = 30_000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re.source, {
    timeout,
  });
}

async function waitForSwapRows(page: Page, min: number, timeout = 30_000) {
  await page.waitForFunction(
    (n) => document.querySelectorAll(".swaps tbody td.num").length >= n * 4,
    min,
    {
      timeout,
    },
  );
}

// ============ Video post processing ============

function findPlaywrightFfmpeg(): string | null {
  const cache =
    process.platform === "darwin"
      ? join(homedir(), "Library/Caches/ms-playwright")
      : join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return null;
  const dirs = readdirSync(cache)
    .filter((d) => d.startsWith("ffmpeg-"))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const bin of ["ffmpeg-mac", "ffmpeg-mac-arm64", "ffmpeg-linux", "ffmpeg-linux-arm64"]) {
      const p = join(cache, d, bin);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function toMp4(webm: string, mp4: string): Promise<boolean> {
  const ffmpeg =
    process.env.FFMPEG ??
    (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : null) ??
    findPlaywrightFfmpeg();
  if (!ffmpeg) return false;
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-i",
    webm,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4,
  ];
  const code = await new Promise<number>((res) => {
    const c = spawn(ffmpeg, args, { stdio: "inherit" });
    c.on("close", (code) => res(code ?? 1));
  });
  if (code !== 0 && existsSync(mp4)) unlinkSync(mp4);
  return code === 0;
}

// ============ Main ============

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const videoDir = join(OUT_DIR, ".raw");
  mkdirSync(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
  const context = await browser.newContext({
    viewport: SIZE,
    colorScheme: "dark",
    recordVideo: { dir: videoDir, size: SIZE },
  });
  const page = await context.newPage();
  const overlay = new Overlay(page);

  const url = `${DASHBOARD_URL}/?label=${LABEL}&rpc=${encodeURIComponent(RPC_URL)}`;
  console.log(`opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await overlay.mount();

  // Title card while the first poll lands.
  await overlay.title(
    "<span>Leash</span> · demo",
    "ENS-native permissions for autonomous traders. A Uniswap v4 hook gates every swap on the agent's ENSv2 subname and on the policy stored in its resolver.",
  );
  await page.waitForSelector(".pill-live", { timeout: 60_000 }).catch(() => {
    throw new Error(
      `dashboard did not reach LIVE for ${LABEL}. Reset the fork: script/demo.sh anvil, then script/demo.sh setup.`,
    );
  });
  const rows = await page.locator(".swaps tbody td.num").count();
  if (rows > 0)
    console.warn(
      `!! ${rows / 4} swap(s) already on the dashboard, the fork is not fresh; recording anyway`,
    );
  await page.waitForTimeout(HOLD.title);
  await overlay.clearTitle();

  // Act 1: identity.
  await overlay.act(
    1,
    "identity: the name is the credential, the resolver holds the policy, the hook enforces it",
  );
  await page.waitForTimeout(HOLD.act);

  // Act 2: an honest swap.
  await overlay.act(2, "an honest swap: 25 lUSD, 10% of the daily cap");
  const honest = await bot(overlay, ["--once"]);
  if (honest.code !== 0) throw new Error("honest swap failed, see output above");
  await waitForSwapRows(page, rows / 4 + 1);
  await waitForBodyText(page, /\d+% of cap/);
  await page.waitForTimeout(HOLD.output);

  // Act 3: the agent oversteps.
  await overlay.act(
    3,
    "the agent oversteps: remaining + 1 wei, afterSwap reverts DailyCapExceeded",
  );
  await bot(overlay, ["--once", "--misbehave"]);
  await page.waitForTimeout(HOLD.output + 1_000);

  // Act 4: the risk desk tightens the leash.
  await overlay.act(
    4,
    "the risk desk tightens the leash: cap 250 → 10 lUSD, one scoped ROLE_SET_TEXT",
  );
  await demo(overlay, "tighten", { NEW_CAP });
  await page.waitForFunction(
    () => document.querySelector(".cap-mark")?.textContent?.trim() === "10",
    null,
    {
      timeout: 30_000,
    },
  );
  await page.waitForTimeout(HOLD.output);
  await bot(overlay, ["--once"]);
  await page.waitForTimeout(HOLD.output);

  await overlay.act(4, "… and what the risk-manager cannot do: revoke or re-point the agent");
  await demo(overlay, "forbid");
  await page.waitForTimeout(HOLD.output + 1_000);

  // Act 5: cut the leash.
  await overlay.act(
    5,
    "cut the leash: one transaction from the owner, the hook reverts LeashRevoked",
  );
  await demo(overlay, "cut");
  await page.waitForSelector(".pill-revoked", { timeout: 30_000 });
  await page.waitForTimeout(HOLD.output);
  await bot(overlay, ["--once"]);
  await page.waitForTimeout(HOLD.act + 1_000);

  await overlay.terminal(null);
  await overlay.title(
    "<span>Leash</span>",
    "No key rotation, no redeploy. Revoking the subname is the kill switch.",
  );
  await page.waitForTimeout(HOLD.title);

  const video = page.video();
  await context.close();
  await browser.close();

  const rawPath = await video!.path();
  const webm = join(OUT_DIR, "leash-demo.webm");
  if (existsSync(webm)) unlinkSync(webm);
  renameSync(rawPath, webm);
  rmSync(videoDir, { recursive: true, force: true });
  console.log(`\nvideo: ${webm}`);

  const mp4 = join(OUT_DIR, "leash-demo.mp4");
  if (await toMp4(webm, mp4)) console.log(`mp4:   ${mp4}`);
  else
    console.log(
      "mp4:   skipped (no ffmpeg with libx264; install ffmpeg or set FFMPEG=/path/to/ffmpeg)",
    );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
