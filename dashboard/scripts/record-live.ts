/**
 * Record the two window demo (docs/demo.md) as a screen capture: an iTerm2 window on the left where
 * Claude Code trades as trader-1, the dashboard in Chromium on the right where the risk-manager and the
 * owner act. This script drives both and records the screen region with macOS `screencapture -v`.
 *
 *   cd dashboard && bun run record-live            # -> docs/demo/leash-demo-live.mov
 *
 * Preconditions: fresh fork (trader-1 LIVE, nothing spent), dashboard dev server running, `claude` on
 * the PATH and logged in, and Screen Recording allowed for the app running this script (System Settings,
 * Privacy & Security, Screen Recording). macOS only. NO_CAPTURE=1 runs the choreography without recording.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

// ============ Config ============

const dashboardDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(dashboardDir, "..");
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:5173";
const OUT = resolve(repoDir, process.env.OUT ?? "docs/demo/leash-demo-live.mov");
const LABEL = "trader-1";
const NO_CAPTURE = process.env.NO_CAPTURE === "1";
const TERMINAL_APP = process.env.TERMINAL_APP === "Terminal" ? "Terminal" : "iTerm";

/** Screen layout in points: Terminal left, Chromium right, menu bar excluded. */
const TOP = 25;
const HEIGHT = 900;
const TERM_W = 620;
const BROWSER_W = 850;
const GAP = 4;
/** Pauses so a viewer can read each state. */
const HOLD = { open: 4_000, afterAgent: 4_000, afterClick: 5_000, end: 6_000 };

// ============ Helpers ============

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function osascript(script: string): string {
  const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`osascript failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Write one order for the terminal script; blocks until it reads it (FIFO semantics). */
async function sendOrder(fifo: string, order: string, timeoutMs = 30_000) {
  const p = spawn("bash", ["-c", 'printf "%s\\n" "$0" > "$1"', order, fifo]);
  const t = setTimeout(() => p.kill(), timeoutMs);
  await new Promise<void>((res, rej) =>
    p.on("close", (c) =>
      c === 0
        ? res()
        : rej(
            new Error(
              "the agent terminal is not reading orders: did its window close? (check PATH for bun and claude)",
            ),
          ),
    ),
  );
  clearTimeout(t);
}

/** Wait for the Terminal script to report the order done. */
async function waitDone(fifo: string, timeoutMs = 180_000) {
  const p = spawn("cat", [fifo]);
  const t = setTimeout(() => p.kill(), timeoutMs);
  await new Promise<void>((res, rej) =>
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("agent timed out")))),
  );
  clearTimeout(t);
}

/** Click a control and wait for a new, settled outcome line under it (not the previous one). */
async function clickAndWait(page: Page, section: string, button: string, timeout = 60_000) {
  const before =
    (await page
      .locator(`${section} .outcome`)
      .textContent()
      .catch(() => null)) ?? "";
  await page.click(`${section} ${button}`);
  await page.waitForFunction(
    ([sel, prev]) => {
      const el = document.querySelector(`${sel} .outcome`);
      return !!el && !el.classList.contains("info") && el.textContent !== prev;
    },
    [section, before] as [string, string],
    { timeout },
  );
}

// ============ Main ============

async function main() {
  if (process.platform !== "darwin") throw new Error("macOS only (Terminal.app + screencapture)");
  mkdirSync(dirname(OUT), { recursive: true });

  const fifoDir = mkdtempSync(join(tmpdir(), "leash-demo-"));
  const orders = join(fifoDir, "orders");
  const done = join(fifoDir, "done");
  spawnSync("mkfifo", [orders, done]);

  // Browser first: it also tells us whether the fork is fresh.
  const browser = await chromium.launch({
    headless: false,
    args: [`--window-position=${TERM_W + GAP},${TOP}`, `--window-size=${BROWSER_W},${HEIGHT}`],
  });
  const context = await browser.newContext({ viewport: null, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(`${DASHBOARD_URL}/?label=${LABEL}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(".pill-live", { timeout: 60_000 });
  } catch {
    throw new Error(
      `dashboard is not LIVE for ${LABEL}: reset the fork (script/demo.sh anvil, then setup)`,
    );
  }
  if ((await page.locator(".swaps tbody td.num").count()) > 0) {
    console.warn("!! swaps already on the dashboard, the fork is not fresh; recording anyway");
  }
  await fetch(`${DASHBOARD_URL}/api/agent-events`, { method: "DELETE" }).catch(() => undefined);
  // Slight zoom out so feed, controls and cards all fit in the right window.
  await page.evaluate(() => {
    (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = "0.85";
  });

  // iTerm2 on the left running the operator script (TERMINAL_APP=Terminal for Terminal.app).
  const script = join(repoDir, "script", "agent-session.sh");
  // iTerm runs the command without a shell: go through a login shell so bun and claude are on the PATH.
  const command = `/bin/bash -lc \\"exec bash '${script}' '${orders}' '${done}'\\"`;
  const bounds = `{0, ${TOP}, ${TERM_W}, ${TOP + HEIGHT}}`;
  const windowId =
    TERMINAL_APP === "Terminal"
      ? osascript(`
    tell application "Terminal"
      activate
      do script "${command}"
      delay 0.5
      set w to front window
      try
        set current settings of w to settings set "Pro"
      end try
      set font size of w to 14
      set bounds of w to ${bounds}
      return id of w
    end tell`)
      : osascript(`
    tell application "iTerm"
      activate
      set w to (create window with default profile command "${command}")
      delay 0.5
      set bounds of w to ${bounds}
      return id of w
    end tell`);
  await sleep(1_500);
  // Bring Chromium back on top of Terminal, both stay visible side by side.
  await page.bringToFront();

  // Screen recording of the region covering both windows.
  let capture: ReturnType<typeof spawn> | null = null;
  if (!NO_CAPTURE) {
    if (existsSync(OUT)) rmSync(OUT);
    capture = spawn(
      "screencapture",
      ["-v", "-x", "-R", `0,${TOP},${TERM_W + GAP + BROWSER_W},${HEIGHT}`, "-V", "900", OUT],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    let exited = false;
    capture.on("exit", () => (exited = true));
    await sleep(2_000);
    if (exited) {
      throw new Error(
        "screencapture stopped immediately: allow Screen Recording for the app running this script (System Settings > Privacy & Security > Screen Recording), restart it, and run again. Or run with NO_CAPTURE=1 to rehearse.",
      );
    }
    console.log(`recording -> ${OUT}`);
  }
  await sleep(HOLD.open);

  const order = async (text: string) => {
    console.log(`› ${text}`);
    await sendOrder(orders, text);
    await waitDone(done);
    await sleep(HOLD.afterAgent);
  };

  // Act 1: identity.
  await order("What is your mandate right now?");

  // Act 2: an honest order.
  await order("Buy 25 lUSD worth of lETH.");

  // Act 3: the agent oversteps.
  await order("Buy 300 lUSD worth of lETH, all at once.");

  // Act 4: the risk desk tightens the leash, then shows what it cannot do.
  console.log("click: tighten the leash (10)");
  await page.fill(".controls .role:not(.owner) input", "10");
  await clickAndWait(page, ".controls .role:not(.owner)", "button.btn");
  await sleep(HOLD.afterClick);
  await order("Buy 5 lUSD worth of lETH.");
  console.log("click: try to revoke");
  await clickAndWait(page, ".controls .role:not(.owner)", "button.ghost");
  await sleep(HOLD.afterClick);

  // Act 5: the owner cuts the leash.
  console.log("click: cut the leash");
  await page.click(".controls .role.owner button.btn");
  await page.waitForSelector(".pill-revoked", { timeout: 60_000 });
  await sleep(HOLD.afterClick);
  await order("Buy 5 lUSD worth of lETH.");
  await sleep(HOLD.end);

  // Wrap up.
  await sendOrder(orders, "__quit__").catch(() => undefined);
  if (capture) {
    capture.kill("SIGINT");
    await new Promise((r) => capture!.on("exit", r));
    console.log(`\nvideo: ${OUT}`);
  }
  await browser.close();
  try {
    osascript(
      `tell application "Terminal" to close (first window whose id is ${windowId}) saving no`,
    );
  } catch {
    // leave the window open if AppleScript cannot find it
  }
  rmSync(fifoDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
