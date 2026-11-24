/**
 * REPL permission gate. `--need-permissions` defaults to true. A denial does
 * not run the script; the turn still appends a result-only user message.
 */

import { describe, expect, test } from "bun:test";
import {
  formatToolResult,
  runTurn,
  TOOL_MARK,
  type ChatMessage,
} from "./harness.ts";
import {
  allowsRun,
  parseNeedPermissions,
  PERMISSION_DENIED,
  runIfPermitted,
} from "./index.ts";

describe("parseNeedPermissions", () => {
  test("defaults to true", () => {
    expect(parseNeedPermissions([])).toBe(true);
  });

  test("a bare flag is true", () => {
    expect(parseNeedPermissions(["--need-permissions"])).toBe(true);
    expect(parseNeedPermissions(["--need-permissions", "true"])).toBe(true);
    expect(parseNeedPermissions(["--need-permissions=true"])).toBe(true);
  });

  test("false skips the prompt", () => {
    expect(parseNeedPermissions(["--need-permissions", "false"])).toBe(false);
    expect(parseNeedPermissions(["--need-permissions=false"])).toBe(false);
    expect(parseNeedPermissions(["--need-permissions", "False"])).toBe(false);
  });

  test("the last value wins", () => {
    expect(
      parseNeedPermissions([
        "--need-permissions=false",
        "--need-permissions",
        "true",
      ]),
    ).toBe(true);
  });

  test("rejects unknown arguments and invalid values", () => {
    expect(() => parseNeedPermissions(["--nope"])).toThrow(
      "unknown argument: --nope",
    );
    expect(() => parseNeedPermissions(["--need-permissions", "no"])).toThrow(
      '--need-permissions must be true or false, got "no"',
    );
    expect(() => parseNeedPermissions(["--need-permissions="])).toThrow(
      '--need-permissions must be true or false, got ""',
    );
  });
});

describe("allowsRun", () => {
  test("accepts y or yes only", () => {
    expect(allowsRun("y")).toBe(true);
    expect(allowsRun("Y")).toBe(true);
    expect(allowsRun("  yes  ")).toBe(true);
    expect(allowsRun("")).toBe(false);
    expect(allowsRun("n")).toBe(false);
    expect(allowsRun("no")).toBe(false);
    expect(allowsRun("yep")).toBe(false);
  });
});

describe("runIfPermitted", () => {
  test("does not run or spawn when permission is denied, and the denial is logged like any other result", async () => {
    const logged: ChatMessage[] = [];
    let ran = false;
    let asked = "";
    const messages: ChatMessage[] = [];
    const status = await runTurn(
      messages,
      "hi",
      async (msgs) => {
        if (msgs.length === 1)
          return { text: `${TOOL_MARK}\nprint(1)`, finishReason: "stop" };
        expect(msgs.at(-1)?.content).toBe(formatToolResult(PERMISSION_DENIED));
        expect(msgs.at(-1)?.content).not.toContain(TOOL_MARK);
        expect(msgs.at(-1)?.content).not.toContain("print(1)");
        return { text: "stopped", finishReason: "stop" };
      },
      (source) =>
        runIfPermitted(
          source,
          true,
          async (script) => {
            asked = script;
            return false;
          },
          async () => {
            ran = true;
            return { exitCode: 0, stdout: "1\n", stderr: "" };
          },
        ),
      async (message) => {
        logged.push(message);
      },
    );
    expect(status).toBe("done");
    expect(asked).toBe("print(1)");
    expect(ran).toBe(false);
    expect(messages[2]).toEqual({
      role: "user",
      content: formatToolResult(PERMISSION_DENIED),
    });
    expect(logged.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(logged[2]).toEqual(messages[2]);
    expect(logged[2]?.content).toContain("permission denied");
    expect(logged[2]?.content).toContain("script was not run");
  });

  test("keeps the result protocol when permission is granted", async () => {
    const ran: string[] = [];
    const messages: ChatMessage[] = [];
    const status = await runTurn(
      messages,
      "hi",
      async (msgs) => {
        if (msgs.length === 1)
          return { text: `${TOOL_MARK}\nprint(1)`, finishReason: "stop" };
        return { text: "done", finishReason: "stop" };
      },
      (source) =>
        runIfPermitted(
          source,
          true,
          async () => true,
          async (script) => {
            ran.push(script);
            return { exitCode: 0, stdout: "1\n", stderr: "" };
          },
        ),
    );
    expect(status).toBe("done");
    expect(ran).toEqual(["print(1)"]);
    expect(messages[2]?.content).toBe(
      formatToolResult({ exitCode: 0, stdout: "1\n", stderr: "" }),
    );
    expect(messages[1]?.content).toContain(TOOL_MARK);
  });

  test("does not ask when the flag is false", async () => {
    let asked = false;
    const result = await runIfPermitted(
      "print(1)",
      false,
      async () => {
        asked = true;
        return false;
      },
      async () => ({ exitCode: 0, stdout: "1\n", stderr: "" }),
    );
    expect(asked).toBe(false);
    expect(result).toEqual({ exitCode: 0, stdout: "1\n", stderr: "" });
  });

  test("a denial does not end the turn; the next script asks again", async () => {
    const answers = [false, true];
    const ran: string[] = [];
    const status = await runTurn(
      [],
      "hi",
      async (msgs) => {
        const results = msgs.filter((message) =>
          message.content.startsWith("exit:"),
        );
        if (results.length === 0)
          return { text: `${TOOL_MARK}\nprint("a")`, finishReason: "stop" };
        if (results.length === 1)
          return { text: `${TOOL_MARK}\nprint("b")`, finishReason: "stop" };
        return { text: "done", finishReason: "stop" };
      },
      (source) =>
        runIfPermitted(
          source,
          true,
          async () => answers.shift() ?? false,
          async (script) => {
            ran.push(script);
            return { exitCode: 0, stdout: "ok\n", stderr: "" };
          },
        ),
    );
    expect(status).toBe("done");
    expect(ran).toEqual(['print("b")']);
    expect(answers).toEqual([]);
  });

  test("returns the denial result without calling the runner", async () => {
    const result = await runIfPermitted(
      "print(1)",
      true,
      async () => false,
      () => {
        throw new Error("runner must not be called");
      },
    );
    expect(result).toBe(PERMISSION_DENIED);
  });
});
