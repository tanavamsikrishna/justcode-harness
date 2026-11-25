/**
 * Tool protocol for the justcode REPL.
 *
 * Parses a trailing `===TOOL CALL===` block from an assistant reply, runs that
 * source in a python3 interactive console, and formats a result-only user message.
 * The tool call stays in the assistant message. Native provider tool calls are not used.
 *
 * `runSnippet` is one-shot unless `persistent` is set. A persistent console is
 * reused while cwd and the child env stay the same. A timeout or
 * killActiveSnippet destroys it; the next persistent call starts fresh. An
 * exception does not. `AI_GATEWAY_API_KEY` is stripped. The marker must occupy
 * its own line. A later marker line starts the script instead.
 * Child PYTHONPATH is <cwd>/.jch/tools, then this file's tools directory, then any
 * inherited PYTHONPATH. The working directory stays first on sys.path.
 * System instructions list each module name with its top-level defs and
 * docstrings from those two directories. The repl worker reads them with ast
 * and does not import them or touch the interactive console. A name already
 * found earlier on that path is omitted. Modules are files at each tools
 * directory root.
 */

import path from "node:path";

export const TOOL_MARK = "===TOOL CALL===";
export const MAX_TOOL_CALLS = 20;
export const TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 48 * 1024;

/** Harness tools next to this file, not the process working directory. */
const HARNESS_TOOLS_DIR = path.join(import.meta.dir, "tools");
const REPL_WORKER = path.join(import.meta.dir, "repl_worker.py");

type CatalogEntry = { path: string; name: string; text: string };
type ToolFunction = { label: string; name: string; text: string };

/** Top-level defs via ast. Does not import the modules. Earlier dirs win. */
function findToolFunctions(dirs: readonly string[]): ToolFunction[] {
  const seen = new Set<string>();
  const found: ToolFunction[] = [];
  for (const fn of catalogEntries(dirs)) {
    if (seen.has(fn.name)) continue;
    seen.add(fn.name);
    const base = path.basename(fn.path);
    found.push({
      label: base.slice(0, -3),
      name: fn.name,
      text: fn.text,
    });
  }
  return found;
}

function catalogEntries(dirs: readonly string[]): CatalogEntry[] {
  const python = Bun.which("python3");
  if (!python) return [];
  const proc = Bun.spawnSync([python, "-u", REPL_WORKER], {
    stdin: Buffer.from(`${JSON.stringify({ op: "catalog", dirs })}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim() || stdout.trim();
    throw new Error(detail || `repl_worker.py exited ${proc.exitCode}`);
  }
  return JSON.parse(stdout) as CatalogEntry[];
}

function formatToolFunctions(functions: readonly ToolFunction[]): string {
  const groups: string[] = [];
  for (const fn of functions) {
    const header = `${fn.label}\nFollowing funcs are available`;
    const last = groups.at(-1);
    if (last?.startsWith(`${header}\n`))
      groups[groups.length - 1] = `${last}\n\n${fn.text}`;
    else groups.push(`${header}\n${fn.text}`);
  }
  return groups.join("\n\n");
}

/** Instructions for this process. Tool signatures are read from the launch cwd. */
export function buildInstructions(opts?: {
  cwd?: string;
  toolsDir?: string;
}): string {
  const cwd = path.resolve(opts?.cwd ?? process.cwd());
  const toolsDir = path.resolve(opts?.toolsDir ?? HARNESS_TOOLS_DIR);
  const body = formatToolFunctions(
    findToolFunctions([path.join(cwd, ".jch", "tools"), toolsDir]),
  );
  const modules =
    body.length === 0
      ? ""
      : `\n\nThe following modules are available to you to import.\n\`\`\`\n${body}\n\`\`\``;
  return `You are a coding assistant in an interactive AI harness.
 You have one tool: run Python in a persistent interactive console in the working directory. Names, imports, and definitions from previous tool calls are available in later tool calls unless overridden. input() sees EOF.
To call it, end your reply with a block. The marker must be on its own line. Put a newline before it. Never append ===TOOL CALL=== to the previous sentence.

Example:
<assistant message>
Listing the folder.

===TOOL CALL===
from pathlib import Path
print("\\n".join(p.name for p in Path(".").iterdir()))


Every line after the marker, through the end of the reply, is the source.
Do not write anything after the source.
Do not emit that marker line unless you are calling the tool.
The source must not contain a line that is exactly ===TOOL CALL===.
The next user message is the result only: exit, stdout, and stderr.
It does not repeat the tool call.
You may call the tool again by ending your next reply with another block.
When you are done, reply with no tool block.
Do not claim the tool ran unless a later user message reports the result.
The tool call code block is not presented to the user, but is shown as a notification.
Your message to user is rendered as Markdown content${modules}`;
}

export const INSTRUCTIONS = buildInstructions();

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type SnippetResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type Generate = (
  messages: ChatMessage[],
) => Promise<{ text: string; finishReason: string }>;

export type TurnStatus = "done" | "limit" | "incomplete";

export function parseToolCall(
  text: string,
): { prose: string; source: string } | null {
  const trimmed = text.replace(/(?:\r?\n)+$/, "");
  if (trimmed.length === 0) return null;
  const lines = trimmed.split(/\r?\n/);
  let marker = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trim() === TOOL_MARK) {
      marker = i;
      break;
    }
  }
  if (marker < 0) return null;
  return {
    prose: lines.slice(0, marker).join("\n").replace(/\n+$/, ""),
    source: lines.slice(marker + 1).join("\n"),
  };
}

/** True when a trailing marker shares its line, so the block is not a call. */
export function hasToolCallFormatError(text: string): boolean {
  if (parseToolCall(text) !== null) return false;
  const at = text.lastIndexOf(TOOL_MARK);
  if (at < 0) return false;
  return /^[ \t]*(?:\r?\n|$)/.test(text.slice(at + TOOL_MARK.length));
}

export function formatToolResult(result: SnippetResult): string {
  const exit = result.exitCode === null ? "error" : String(result.exitCode);
  const stdout = result.stdout.replace(/\n$/, "");
  const stderr = result.stderr.replace(/\n$/, "");
  return `exit: ${exit}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated, ${text.length} chars total`;
}

let activeSnippetPid: number | undefined;
let active: PythonRepl | undefined;
let session: PythonRepl | undefined;
let sessionQueue: Promise<unknown> = Promise.resolve();

type WorkerReply = { stdout: string; stderr: string; exit: number };

class PythonRepl {
  readonly key: string;
  dead = false;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(key: string, cwd: string, env: Record<string, string>) {
    const python = Bun.which("python3");
    if (!python) throw new Error("python3 not found on PATH");
    this.key = key;
    this.proc = Bun.spawn([python, "-u", REPL_WORKER], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const stdout = this.proc.stdout;
    if (stdout == null || typeof stdout === "number")
      throw new Error("Python REPL stdout is not a pipe");
    this.reader = stdout.getReader();
  }

  get pid(): number | undefined {
    return this.dead ? undefined : this.proc.pid;
  }

  kill(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  async run(source: string, timeoutMs: number): Promise<SnippetResult> {
    const stdin = this.proc.stdin;
    if (stdin == null || typeof stdin === "number")
      throw new Error("Python REPL stdin is not a pipe");
    stdin.write(`${JSON.stringify({ code: source })}\n`);
    await stdin.flush();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.kill();
    }, timeoutMs);
    try {
      const line = await this.readLine();
      clearTimeout(timer);
      if (timedOut)
        return {
          exitCode: null,
          stdout: "",
          stderr: `timed out after ${timeoutMs}ms`,
        };
      const reply = JSON.parse(line) as WorkerReply;
      return {
        exitCode: reply.exit,
        stdout: truncate(reply.stdout),
        stderr: truncate(reply.stderr),
      };
    } catch (err: unknown) {
      this.kill();
      if (timedOut)
        return {
          exitCode: null,
          stdout: "",
          stderr: `timed out after ${timeoutMs}ms`,
        };
      const message = err instanceof Error ? err.message : String(err);
      return { exitCode: null, stdout: "", stderr: message };
    } finally {
      clearTimeout(timer);
    }
  }

  private async readLine(): Promise<string> {
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 1);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("Python REPL process exited unexpectedly");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
}

process.on("exit", () => {
  session?.kill();
  active?.kill();
});

/** Stops the python3 child from the current snippet, if one is running. */
export function killActiveSnippet(): boolean {
  const pid = activeSnippetPid;
  if (pid === undefined) return false;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }
  active?.kill();
  return true;
}

function childEnv(cwd: string, toolsDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "AI_GATEWAY_API_KEY") env[key] = value;
  }
  const pythonPath = [
    path.resolve(cwd, ".jch", "tools"),
    path.resolve(toolsDir),
  ];
  if (process.env.PYTHONPATH !== undefined)
    pythonPath.push(process.env.PYTHONPATH);
  env.PYTHONPATH = pythonPath.join(path.delimiter);
  return env;
}

function sessionKey(
  cwd: string,
  toolsDir: string,
  env: Record<string, string>,
): string {
  return JSON.stringify({ cwd, toolsDir: path.resolve(toolsDir), env });
}

function reuseRepl(
  cwd: string,
  toolsDir: string,
  env: Record<string, string>,
): PythonRepl {
  const key = sessionKey(cwd, toolsDir, env);
  if (session !== undefined && !session.dead && session.key === key)
    return session;
  session?.kill();
  session = new PythonRepl(key, cwd, env);
  return session;
}

async function runSnippetNow(
  source: string,
  opts?: {
    timeoutMs?: number;
    cwd?: string;
    toolsDir?: string;
    persistent?: boolean;
  },
): Promise<SnippetResult> {
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const cwd = path.resolve(opts?.cwd ?? process.cwd());
  const toolsDir = opts?.toolsDir ?? HARNESS_TOOLS_DIR;
  if (!Bun.which("python3"))
    return { exitCode: null, stdout: "", stderr: "python3 not found on PATH" };
  const env = childEnv(cwd, toolsDir);
  const persistent = opts?.persistent === true;
  let repl: PythonRepl;
  try {
    repl = persistent
      ? reuseRepl(cwd, toolsDir, env)
      : new PythonRepl(sessionKey(cwd, toolsDir, env), cwd, env);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: null, stdout: "", stderr: message };
  }
  active = repl;
  activeSnippetPid = repl.pid;
  try {
    return await repl.run(source, timeoutMs);
  } finally {
    if (active === repl) active = undefined;
    if (activeSnippetPid === repl.pid) activeSnippetPid = undefined;
    if (!persistent) repl.kill();
  }
}

/** One-shot unless `persistent` is set. A persistent console keeps names across calls. */
export async function runSnippet(
  source: string,
  opts?: {
    timeoutMs?: number;
    cwd?: string;
    toolsDir?: string;
    persistent?: boolean;
  },
): Promise<SnippetResult> {
  if (opts?.persistent !== true) return runSnippetNow(source, opts);
  const job = sessionQueue.then(() => runSnippetNow(source, opts));
  sessionQueue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

const emptySource: SnippetResult = {
  exitCode: null,
  stdout: "",
  stderr: "tool source is empty",
};

export async function runTurn(
  messages: ChatMessage[],
  userText: string,
  generate: Generate,
  run: (source: string) => Promise<SnippetResult>,
  log?: (message: ChatMessage) => void | Promise<void>,
): Promise<TurnStatus> {
  const push = async (message: ChatMessage): Promise<void> => {
    messages.push(message);
    await log?.(message);
  };
  await push({ role: "user", content: userText });
  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const { text, finishReason } = await generate(messages);
    await push({ role: "assistant", content: text });
    if (finishReason !== "stop") return "incomplete";
    const call = parseToolCall(text);
    if (!call) return "done";
    const result =
      call.source.trim().length === 0 ? emptySource : await run(call.source);
    await push({ role: "user", content: formatToolResult(result) });
  }
  return "limit";
}
