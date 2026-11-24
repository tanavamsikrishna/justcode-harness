# justcode harness

**Do not use this in production.** This is an experiment in tool calling: the only way to call a tool is to send Python code in the assistant message itself. There is no tool-schema section and no native provider tool calls.

Interactive REPL. One tool: a Python 3 script run with `python3` on `PATH`. The model requests it by ending an assistant reply with a `===TOOL CALL===` block. See `AGENTS.md`.

To install dependencies:

```bash
bun install
```

To run (`AI_GATEWAY_API_KEY` comes from envchain):

```bash
envchain vercel bun run index.ts
```

`/exit` or Ctrl-D quits. Ctrl-C exits immediately, cancels an in-flight reply, and does not append a message. A line ending in `\` continues the prompt. Messages are appended to `sessions/<start-timestamp>.jsonl`. `--need-permissions` defaults to true, so the REPL asks before each tool script; pass `--need-permissions false` to skip the prompt.

To type check:

```bash
bun check
```

Run `bun fmt` to format the code.
