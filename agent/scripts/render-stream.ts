/**
 * Render Claude Code's `--output-format stream-json` on a terminal for the demo: the agent's tool calls
 * (name and arguments), the tool results, then its answer. Everything else in the stream is dropped.
 *
 *   claude -p "buy 25 lUSD of lETH" --output-format stream-json --verbose | bun run scripts/render-stream.ts
 */
export {};

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const WIDTH = Math.max(40, (process.stdout.columns || 72) - 4);

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; content: string | { type: string; text?: string }[]; is_error?: boolean };

function wrap(text: string, indent: string): string {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > WIDTH) {
        out.push(indent + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(indent + line);
  }
  return out.join("\n");
}

function print(s: string) {
  process.stdout.write(s + "\n");
}

function renderBlock(block: Block) {
  if (block.type === "tool_use") {
    const name = block.name.replace(/^mcp__leash__/, "");
    const args = Object.entries(block.input ?? {})
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
    print(`  ${CYAN}⚙ ${name}(${args})${RESET}`);
    return;
  }
  if (block.type === "tool_result") {
    const text =
      typeof block.content === "string"
        ? block.content
        : (block.content ?? [])
            .map((c) => c.text ?? "")
            .filter(Boolean)
            .join("\n");
    const lines = text.split("\n").filter((l) => l.trim());
    const shown = lines.slice(0, 4);
    const color = block.is_error || /REVERT|refuses/.test(text) ? RED : GREEN;
    for (const l of shown) print(`  ${DIM}↳${RESET} ${color}${l.slice(0, WIDTH)}${RESET}`);
    if (lines.length > shown.length) print(`  ${DIM}↳ … ${lines.length - shown.length} more lines${RESET}`);
    return;
  }
  if (block.type === "text" && block.text.trim()) {
    print("");
    print(wrap(block.text.trim(), "  "));
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) handle(line);
}
if (buffer.trim()) handle(buffer);

function handle(line: string) {
  if (!line.trim()) return;
  let msg: { type?: string; message?: { content?: Block[] | string }; is_error?: boolean; result?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "assistant" || msg.type === "user") {
    const content = msg.message?.content;
    if (Array.isArray(content)) for (const block of content) renderBlock(block);
    return;
  }
  if (msg.type === "result" && msg.is_error) print(`  ${RED}${msg.result ?? "error"}${RESET}`);
}
