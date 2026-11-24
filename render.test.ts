/**
 * Terminal rendering of an assistant reply. The tool block is not printed.
 */

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_MARK } from "./harness.ts";
import { logMessage, renderAssistant, sessionLogPath } from "./index.ts";

test("renders markdown and omits the tool block", async () => {
  const rendered = await renderAssistant(
    `See **this** and \`code\`.\n\n${TOOL_MARK}\nconsole.log("**x**")`,
  );
  expect(rendered).not.toContain("**this**");
  expect(rendered).toContain("this");
  expect(rendered).not.toContain("`code`");
  expect(rendered).toContain("code");
  expect(rendered).not.toContain(TOOL_MARK);
  expect(rendered).not.toContain("console.log");
});

test("prints nothing when the reply is only a tool block", async () => {
  expect(await renderAssistant(`${TOOL_MARK}\nconsole.log(1)`)).toBe("");
});

test("appends messages as JSONL under sessions/", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "justcode-session-"));
  try {
    const start = new Date("2026-03-22T18:04:05.123Z");
    const file = sessionLogPath(start, root);
    expect(file).toBe(path.join(root, "sessions", "2026-03-22T18-04-05.123Z.jsonl"));
    await logMessage(file, { role: "system", content: "instructions" });
    await logMessage(file, { role: "user", content: "hi\nthere" });
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { role: "system", content: "instructions" },
      { role: "user", content: "hi\nthere" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
