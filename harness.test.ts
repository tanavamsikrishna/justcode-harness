/**
 * Contract tests for the assistant-message tool block, result-only user
 * message, and python3 snippet runner.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildInstructions,
  formatToolResult,
  MAX_TOOL_CALLS,
  parseToolCall,
  runSnippet,
  runTurn,
  TOOL_MARK,
  type ChatMessage,
  type Generate,
} from "./harness.ts";

async function withToolFixture<T>(
  run: (fixture: {
    cwd: string;
    toolsDir: string;
    inherited: string;
  }) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), "justcode-"));
  const toolsDir = await mkdtemp(path.join(tmpdir(), "justcode-"));
  const inherited = await mkdtemp(path.join(tmpdir(), "justcode-"));
  try {
    return await run({ cwd, toolsDir, inherited });
  } finally {
    await Promise.all(
      [cwd, toolsDir, inherited].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  }
}

async function writeModule(
  dir: string,
  name: string,
  value: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${name}.py`),
    `VALUE = ${JSON.stringify(value)}\n`,
  );
}

describe("parseToolCall", () => {
  test("reads the script after the marker at the end of the assistant message", () => {
    const text = `I'll add them.\n\n${TOOL_MARK}\nconsole.log(1 + 1)`;
    expect(parseToolCall(text)).toEqual({
      prose: "I'll add them.",
      source: "console.log(1 + 1)",
    });
  });

  test("ignores a marker that does not occupy its own line", () => {
    expect(parseToolCall(`use ${TOOL_MARK} to run code`)).toBeNull();
    expect(
      parseToolCall(`Listing the folder.${TOOL_MARK}\nconsole.log(1)`),
    ).toBeNull();
  });

  test("returns null when the assistant message has no block", () => {
    expect(parseToolCall("just an answer")).toBeNull();
  });

  test("the last marker starts the script", () => {
    const text = `${TOOL_MARK}\nnope\n${TOOL_MARK}\nconsole.log(2)`;
    expect(parseToolCall(text)?.source).toBe("console.log(2)");
  });

  test("keeps script indentation and accepts a padded marker line", () => {
    const text = `  ${TOOL_MARK}  \n  console.log(1)\n`;
    expect(parseToolCall(text)?.source).toBe("  console.log(1)");
  });
});

describe("formatToolResult", () => {
  test("is the result only and does not repeat the tool call", () => {
    const text = formatToolResult({ exitCode: 0, stdout: "1\n", stderr: "" });
    expect(text).toBe("exit: 0\n--- stdout ---\n1\n--- stderr ---\n");
    expect(text).not.toContain(TOOL_MARK);
  });

  test("uses error when the process did not exit", () => {
    expect(
      formatToolResult({ exitCode: null, stdout: "", stderr: "timed out" }),
    ).toContain("exit: error");
  });
});

describe("runTurn", () => {
  test("runs the assistant block and appends a result user message", async () => {
    const messages: ChatMessage[] = [];
    const ran: string[] = [];
    const generate: Generate = async (msgs) => {
      if (msgs.length === 1) {
        return {
          text: `ok\n${TOOL_MARK}\nconsole.log(1)`,
          finishReason: "stop",
        };
      }
      expect(msgs.at(-1)?.role).toBe("user");
      expect(msgs.at(-1)?.content).not.toContain(TOOL_MARK);
      return { text: "done", finishReason: "stop" };
    };
    const status = await runTurn(messages, "hi", generate, async (source) => {
      ran.push(source);
      return { exitCode: 0, stdout: "1\n", stderr: "" };
    });
    expect(status).toBe("done");
    expect(ran).toEqual(["console.log(1)"]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[1]?.content).toContain(TOOL_MARK);
    expect(messages[2]?.content).toBe(
      "exit: 0\n--- stdout ---\n1\n--- stderr ---\n",
    );
  });

  test("logs each appended message", async () => {
    const logged: ChatMessage[] = [];
    await runTurn(
      [],
      "hi",
      async (msgs) => {
        if (msgs.length === 1)
          return { text: `${TOOL_MARK}\nconsole.log(1)`, finishReason: "stop" };
        return { text: "done", finishReason: "stop" };
      },
      async () => ({ exitCode: 0, stdout: "1\n", stderr: "" }),
      async (message) => {
        logged.push(message);
      },
    );
    expect(logged.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(logged[0]?.content).toBe("hi");
    expect(logged[2]?.content).toContain("exit: 0");
  });

  test("does not run a truncated reply", async () => {
    let ran = false;
    const status = await runTurn(
      [],
      "hi",
      async () => ({
        text: `${TOOL_MARK}\nconsole.log(1)`,
        finishReason: "length",
      }),
      async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );
    expect(status).toBe("incomplete");
    expect(ran).toBe(false);
  });

  test("stops at the tool-call limit", async () => {
    let ran = 0;
    const status = await runTurn(
      [],
      "hi",
      async () => ({
        text: `${TOOL_MARK}\nconsole.log(1)`,
        finishReason: "stop",
      }),
      async () => {
        ran += 1;
        return { exitCode: 0, stdout: "1\n", stderr: "" };
      },
    );
    expect(status).toBe("limit");
    expect(ran).toBe(MAX_TOOL_CALLS);
  });

  test("does not run when the marker shares a line with prose", async () => {
    let ran = false;
    const status = await runTurn(
      [],
      "hi",
      async () => ({
        text: `Listing.${TOOL_MARK}\nconsole.log(1)`,
        finishReason: "stop",
      }),
      async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );
    expect(status).toBe("done");
    expect(ran).toBe(false);
  });

  test("does not spawn when the block is empty", async () => {
    let ran = false;
    await runTurn(
      [],
      "hi",
      async (msgs) => {
        if (msgs.length === 1) return { text: TOOL_MARK, finishReason: "stop" };
        return { text: "fixed", finishReason: "stop" };
      },
      async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );
    expect(ran).toBe(false);
  });
});

describe("runSnippet", () => {
  test("runs a Python snippet with python3 on PATH", async () => {
    const result = await runSnippet("print(2 + 2)");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4\n");
  });

  test("returns a non-zero exit when the snippet raises", async () => {
    const result = await runSnippet('raise RuntimeError("nope")');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("does not pass AI_GATEWAY_API_KEY to the snippet", async () => {
    const previous = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "secret-value";
    try {
      const result = await runSnippet(
        'import os\nprint(os.environ.get("AI_GATEWAY_API_KEY", "missing"))',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("missing\n");
    } finally {
      if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previous;
    }
  });

  test("times out a hung snippet", async () => {
    const result = await runSnippet("import time\ntime.sleep(30)", {
      timeoutMs: 200,
    });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("timed out");
  });

  test("imports a module from the harness tools directory", async () => {
    await withToolFixture(async ({ cwd, toolsDir }) => {
      await writeModule(toolsDir, "jchprobe_harness", "harness");
      const result = await runSnippet(
        "import jchprobe_harness\nprint(jchprobe_harness.VALUE)",
        {
          cwd,
          toolsDir,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("harness\n");
    });
  });

  test("imports a module from .jch/tools in the working directory", async () => {
    await withToolFixture(async ({ cwd, toolsDir }) => {
      await writeModule(
        path.join(cwd, ".jch", "tools"),
        "jchprobe_local",
        "local",
      );
      const result = await runSnippet(
        "import jchprobe_local\nprint(jchprobe_local.VALUE)",
        {
          cwd,
          toolsDir,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("local\n");
    });
  });

  test("prefers .jch/tools over the harness tools directory", async () => {
    await withToolFixture(async ({ cwd, toolsDir }) => {
      await writeModule(toolsDir, "jchprobe_override", "harness");
      await writeModule(
        path.join(cwd, ".jch", "tools"),
        "jchprobe_override",
        "local",
      );
      const result = await runSnippet(
        "import jchprobe_override\nprint(jchprobe_override.VALUE)",
        {
          cwd,
          toolsDir,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("local\n");
    });
  });

  test("prefers a working-directory module over both tool directories", async () => {
    await withToolFixture(async ({ cwd, toolsDir }) => {
      await writeModule(cwd, "jchprobe_cwd", "cwd");
      await writeModule(
        path.join(cwd, ".jch", "tools"),
        "jchprobe_cwd",
        "local",
      );
      await writeModule(toolsDir, "jchprobe_cwd", "harness");
      const result = await runSnippet(
        "import jchprobe_cwd\nprint(jchprobe_cwd.VALUE)",
        {
          cwd,
          toolsDir,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("cwd\n");
    });
  });

  test("prefers the harness tools directory over inherited PYTHONPATH", async () => {
    const previous = process.env.PYTHONPATH;
    await withToolFixture(async ({ cwd, toolsDir, inherited }) => {
      process.env.PYTHONPATH = inherited;
      try {
        await writeModule(toolsDir, "jchprobe_env", "harness");
        await writeModule(inherited, "jchprobe_env", "inherited");
        await writeModule(inherited, "jchprobe_env_only", "inherited-only");
        const result = await runSnippet(
          [
            "import jchprobe_env",
            "import jchprobe_env_only",
            "print(jchprobe_env.VALUE)",
            "print(jchprobe_env_only.VALUE)",
          ].join("\n"),
          { cwd, toolsDir },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("harness\ninherited-only\n");
      } finally {
        if (previous === undefined) delete process.env.PYTHONPATH;
        else process.env.PYTHONPATH = previous;
      }
    });
  });
});

describe("buildInstructions", () => {
  test("lists top-level defs and docstrings instead of the import sentence", async () => {
    await withToolFixture(async ({ cwd, toolsDir }) => {
      await writeFile(
        path.join(toolsDir, "alpha.py"),
        'def alpha(n: int) -> int:\n    """Double\n    it."""\n    return n\n',
      );
      const text = buildInstructions({ cwd, toolsDir });
      expect(text).not.toContain("Snippets can import");
      expect(text.indexOf("The following modules are available to you")).toBeGreaterThan(
        text.indexOf("===TOOL CALL==="),
      );
      expect(text).toContain(
        '```\nalpha\nFollowing funcs are available\ndef alpha(n: int) -> int:\n    """Double\n    it."""',
      );
      expect(text.endsWith("```"));
    });
  });

  test("excludes async defs and nested defs", async () => {
    await withToolFixture(async ({ cwd, toolsDir }) => {
      await writeFile(
        path.join(toolsDir, "alpha.py"),
        [
          "async def fetch(url: str) -> str:",
          '    """get"""',
          "    return url",
          "",
          "def outer():",
          "    def inner():",
          '        """nested"""',
          "        return 1",
          "    return inner",
          "",
          "class C:",
          "    def method(self):",
          '        """no"""',
          "        return 1",
          "",
          "def kept():",
          '    """yes"""',
          "",
        ].join("\n"),
      );
      const text = buildInstructions({ cwd, toolsDir });
      expect(text).toContain("def kept():");
      expect(text).not.toContain("fetch");
      expect(text).not.toContain("inner");
      expect(text).not.toContain("method");
    });
  });

  test("keeps the earlier PYTHONPATH definition and drops the later name", async () => {
    await withToolFixture(async ({ cwd, toolsDir }) => {
      const local = path.join(cwd, ".jch", "tools");
      await mkdir(local, { recursive: true });
      await writeFile(
        path.join(local, "b.py"),
        'def shared():\n    """from b"""\n\ndef only_local():\n    pass\n',
      );
      await writeFile(
        path.join(local, "a.py"),
        'def shared():\n    """from a"""\n',
      );
      await writeFile(
        path.join(toolsDir, "alpha.py"),
        'def shared():\n    """harness"""\n\ndef only_harness():\n    """later"""\n',
      );
      const text = buildInstructions({ cwd, toolsDir });
      expect(text).toContain(
        'a\nFollowing funcs are available\ndef shared():\n    """from a"""',
      );
      expect(text).not.toContain("from b");
      expect(text).not.toContain('"""harness"""');
      expect(text).toContain(
        "b\nFollowing funcs are available\ndef only_local():",
      );
      expect(text).toContain(
        'alpha\nFollowing funcs are available\ndef only_harness():\n    """later"""',
      );
      expect(text.endsWith("```"));
    });
  });

  test("omits the catalog when neither tools directory has a matching def", async () => {
    await withToolFixture(async ({ cwd, toolsDir }) => {
      const text = buildInstructions({ cwd, toolsDir });
      expect(text).not.toContain("Snippets can import");
      expect(text).not.toContain("The following modules are available to you");
      expect(text).not.toContain(".jch/tools/");
      expect(text).not.toContain("tools/");
      expect(text).toContain("You have one tool:");
    });
  });
});
