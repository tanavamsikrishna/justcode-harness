/**
 * Tool protocol for the justcode REPL.
 *
 * Parses a trailing `===TOOL CALL===` block from an assistant reply, runs that
 * source with `python3` from PATH, and formats a result-only user message.
 * The tool call stays in the assistant message. Native provider tool calls are not used.
 *
 * The script runs unsandboxed in the working directory. `AI_GATEWAY_API_KEY`
 * is stripped from the child. The active child can be killed without waiting.
 * The marker must occupy its own line. A later marker line starts the script instead.
 * Child PYTHONPATH is <cwd>/.jch/tools, then this file's tools directory, then any
 * inherited PYTHONPATH. A local module overrides a harness module of the same name.
 * System instructions list each module name with its top-level defs and
 * docstrings from those two directories. A name already found earlier on that
 * path is omitted. Modules are files at each tools directory root.
 */

import { readdirSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const TOOL_MARK = "===TOOL CALL===";
export const MAX_TOOL_CALLS = 20;
export const TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 48 * 1024;

/** Harness tools next to this file, not the process working directory. */
const HARNESS_TOOLS_DIR = path.join(import.meta.dir, "tools");

/** Column-0 `def` plus an optional docstring. `async def` and indented defs are not matched. */
const TOOL_DEF_SOURCE = String.raw`^(def\s+\w+\s*\(.*?\)\s*(?:->\s*[^:]+)?\s*:)(?:\s*("""|''').*?\2)?`;

type ToolFunction = { label: string; name: string; text: string };

function pythonFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.name.endsWith(".py") &&
          (entry.isFile() || entry.isSymbolicLink()),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function functionsInFile(file: string, label: string): ToolFunction[] {
  let source: string;
  try {
    source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  } catch {
    return [];
  }
  const found: ToolFunction[] = [];
  for (const match of source.matchAll(new RegExp(TOOL_DEF_SOURCE, "gms"))) {
    const text = match[0];
    const name = /^def\s+(\w+)/.exec(text)?.[1];
    if (name === undefined) continue;
    found.push({ label, name, text });
  }
  return found;
}

/** Earlier directories win. A repeated name later on the path is dropped. */
function findToolFunctions(dirs: readonly string[]): ToolFunction[] {
  const seen = new Set<string>();
  const found: ToolFunction[] = [];
  for (const dir of dirs) {
    for (const file of pythonFiles(dir)) {
      const label = file.slice(0, -3);
      for (const fn of functionsInFile(path.join(dir, file), label)) {
        if (seen.has(fn.name)) continue;
        seen.add(fn.name);
        found.push(fn);
      }
    }
  }
  return found;
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
      : `\n\nThe following modules are available to you\n\`\`\`\n${body}\n\`\`\``;
  return `You are a coding assistant in an interactive AI harness.
You have one tool: execute a Python 3 script in the working directory.
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
Your message to user is rendered as Markdown content.${modules}`;
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

/** Stops the python3 child from the current snippet, if one is running. */
export function killActiveSnippet(): boolean {
  const pid = activeSnippetPid;
  if (pid === undefined) return false;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }
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

export async function runSnippet(
  source: string,
  opts?: { timeoutMs?: number; cwd?: string; toolsDir?: string },
): Promise<SnippetResult> {
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const cwd = path.resolve(opts?.cwd ?? process.cwd());
  const toolsDir = opts?.toolsDir ?? HARNESS_TOOLS_DIR;
  // Written in cwd so the script directory stays first on sys.path.
  const file = path.join(
    cwd,
    `.justcode-snippet-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.py`,
  );
  const python = Bun.which("python3");
  if (!python)
    return { exitCode: null, stdout: "", stderr: "python3 not found on PATH" };
  await writeFile(file, source);
  const timeout = AbortSignal.timeout(timeoutMs);
  const proc = Bun.spawn([python, file], {
    cwd,
    env: childEnv(cwd, toolsDir),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: timeout,
  });
  activeSnippetPid = proc.pid;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timeout.aborted) {
      return {
        exitCode: null,
        stdout: truncate(stdout),
        stderr: `timed out after ${timeoutMs}ms`,
      };
    }
    return { exitCode, stdout: truncate(stdout), stderr: truncate(stderr) };
  } catch (err: unknown) {
    if (timeout.aborted) {
      return {
        exitCode: null,
        stdout: "",
        stderr: `timed out after ${timeoutMs}ms`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: null, stdout: "", stderr: message };
  } finally {
    if (activeSnippetPid === proc.pid) activeSnippetPid = undefined;
    await rm(file, { force: true });
  }
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
