/**
 * Interactive REPL. Reads a meta/muse-ember reply through the Vercel AI Gateway,
 * prints it as terminal Markdown, and runs a Python 3 script when the reply ends
 * with a tool block.
 *
 * `--need-permissions` defaults to true: the REPL asks before each script. A denial
 * does not spawn python3; the turn still records a result-only message.
 * Requires AI_GATEWAY_API_KEY. Invoke with `envchain vercel bun run index.ts`.
 * `/exit` or Ctrl-D quits. Ctrl-C exits immediately, cancels an in-flight reply,
 * and does not append a message. Messages are appended to `sessions/<start-timestamp>.jsonl`.
 */

import { writeSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { streamText, type ModelMessage } from "ai";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  INSTRUCTIONS,
  killActiveSnippet,
  parseToolCall,
  runSnippet,
  runTurn,
  type ChatMessage,
  type SnippetResult,
} from "./harness.ts";

const MODEL = "meta/muse-ember";

marked.use(
  markedTerminal({
    reflowText: true,
    width: output.isTTY && output.columns ? output.columns : 10_000,
  }),
);

export function sessionLogPath(start: Date, root = process.cwd()): string {
  const stamp = start.toISOString().replaceAll(":", "-");
  return path.join(root, "sessions", `${stamp}.jsonl`);
}

export async function logMessage(
  file: string,
  message: { role: string; content: string },
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(message)}\n`);
}

const PERMISSIONS_FLAG = "--need-permissions";

/** `--need-permissions` defaults to true. A bare flag is true; `false` turns the prompt off. */
export function parseNeedPermissions(argv: readonly string[]): boolean {
  let needPermissions = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const inline = arg.startsWith(`${PERMISSIONS_FLAG}=`);
    if (arg !== PERMISSIONS_FLAG && !inline)
      throw new Error(`unknown argument: ${arg}`);
    if (!inline) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        needPermissions = true;
        continue;
      }
      i += 1;
      needPermissions = parsePermissionsValue(next);
      continue;
    }
    needPermissions = parsePermissionsValue(
      arg.slice(PERMISSIONS_FLAG.length + 1),
    );
  }
  return needPermissions;
}

function parsePermissionsValue(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(
    `--need-permissions must be true or false, got ${JSON.stringify(value)}`,
  );
}

/** y/yes, case-insensitive. Anything else, including an empty answer, denies. */
export function allowsRun(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/** Result fed back when the user denies a script. python3 is not spawned. */
export const PERMISSION_DENIED: SnippetResult = {
  exitCode: null,
  stdout: "",
  stderr: "permission denied; script was not run",
};

/** Runs the script only when permission is off or the user allows it. */
export async function runIfPermitted(
  source: string,
  needPermissions: boolean,
  ask: (source: string) => Promise<boolean>,
  run: (source: string) => Promise<SnippetResult>,
): Promise<SnippetResult> {
  if (needPermissions && !(await ask(source))) return PERMISSION_DENIED;
  return run(source);
}

/** Renders the reply. A trailing tool block is omitted; the harness runs it separately. */
export async function renderAssistant(text: string): Promise<string> {
  const call = parseToolCall(text);
  const markdown = call === null ? text : call.prose;
  if (markdown.trim().length === 0) return "";
  return await marked.parse(markdown);
}

function printResult(result: SnippetResult): void {
  const exit = result.exitCode === null ? "error" : String(result.exitCode);
  console.error(`\n[tool] exit ${exit}`);
  const stdout = result.stdout.replace(/\n$/, "");
  const stderr = result.stderr.replace(/\n$/, "");
  if (stdout.length > 0) console.error(stdout);
  if (stderr.length > 0) console.error(stderr);
}

export const SIGINT_EXIT_CODE = 130;

type SigintSource = {
  on(event: "SIGINT", listener: () => void): unknown;
};

/** Abort the reply, stop a running snippet, restore the terminal, and exit. */
export function interruptSession(opts: {
  abort: () => void;
  stop?: () => void;
  close?: () => void;
  exit?: (code: number) => never;
}): void {
  const exit = opts.exit ?? process.exit;
  try {
    opts.abort();
  } finally {
    try {
      opts.stop?.();
    } finally {
      try {
        opts.close?.();
      } finally {
        exit(SIGINT_EXIT_CODE);
      }
    }
  }
}

export function listenForInterrupt(
  sources: readonly SigintSource[],
  interrupt: () => void,
): void {
  for (const source of sources) source.on("SIGINT", interrupt);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException("The operation was aborted", "AbortError");
}

function createGenerate(signal: AbortSignal): (
  messages: ChatMessage[],
) => Promise<{ text: string; finishReason: string }> {
  return async (messages) => {
    const result = streamText({
      model: MODEL,
      instructions: INSTRUCTIONS,
      messages: messages as ModelMessage[],
      abortSignal: signal,
    });
    let text = "";
    for await (const part of result.textStream) text += part;
    throwIfAborted(signal);
    if (text.length > 0) {
      const rendered = await renderAssistant(text);
      throwIfAborted(signal);
      if (rendered.length > 0)
        output.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
    }
    return { text, finishReason: await result.finishReason };
  };
}

if (import.meta.main) {
  let needPermissions = true;
  try {
    needPermissions = parseNeedPermissions(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const started = new Date();
  const sessionFile = sessionLogPath(started);
  const log = (message: { role: string; content: string }) =>
    logMessage(sessionFile, message);
  const rl = createInterface({ input, output });
  const messages: ChatMessage[] = [];
  const replyAbort = new AbortController();
  const generate = createGenerate(replyAbort.signal);
  let interrupting = false;
  const interrupt = () => {
    if (interrupting) return;
    interrupting = true;
    // Raw mode: LF alone does not return the cursor.
    try {
      writeSync(output.fd, "\r\n");
    } catch {
      // stdout may already be closed.
    }
    interruptSession({
      abort: () => replyAbort.abort(),
      stop: killActiveSnippet,
      close: () => rl.close(),
    });
  };
  listenForInterrupt([rl, process], interrupt);
  console.error(`${MODEL}  tool block: ===TOOL CALL===`);
  console.error(`need-permissions: ${needPermissions}`);
  console.error(`session: ${path.relative(process.cwd(), sessionFile)}`);
  await log({ role: "system", content: INSTRUCTIONS });

  try {
    while (true) {
      let text: string;
      try {
        text = await rl.question("> ");
      } catch {
        break;
      }
      if (text === "/exit" || text === "/quit") break;
      while (text.endsWith("\\")) {
        const next = await rl.question("… ");
        text = `${text.slice(0, -1)}\n${next}`;
      }
      if (text.trim().length === 0) continue;

      try {
        const status = await runTurn(
          messages,
          text,
          generate,
          (source) =>
            runIfPermitted(
              source,
              needPermissions,
              async (script) => {
                console.error("\n[tool] script:");
                console.error(script.replace(/\n$/, ""));
                const answer = await rl.question(
                  "[tool] run this script? [y/N] ",
                );
                const allowed = allowsRun(answer);
                if (!allowed) console.error("[tool] denied");
                return allowed;
              },
              async (script) => {
                console.error("\n[tool] running");
                const result = await runSnippet(script);
                printResult(result);
                return result;
              },
            ),
          log,
        );
        if (status === "limit") console.error("error: tool call limit is 20");
        else if (status === "incomplete")
          console.error("error: reply incomplete; tool not run");
      } catch (err: unknown) {
        if (replyAbort.signal.aborted) process.exit(SIGINT_EXIT_CODE);
        console.error(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    rl.close();
  }
}
