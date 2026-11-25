# justcode harness

Minimal interactive REPL. One tool: run a Python 3 script with `python3` from `PATH`. Native provider tool calls are not used.

The tool call is at the end of the assistant message. The marker must occupy its own line. The script is every following line through the end of that message:

```
===TOOL CALL===
<python3 script>
```

A line whose trimmed text is not exactly `===TOOL CALL===` is not a marker. The script must not contain that line. A reply that does not end with the block ends the turn. A truncated reply is not executed.

The harness runs the script with the first `python3` on `PATH`, in the working directory, unsandboxed. `AI_GATEWAY_API_KEY` is removed from the child environment. Timeout is 30s. Captured output is truncated at 48KB. The child `PYTHONPATH` lists `<cwd>/.jch/tools`, then the harness `tools` directory next to the TypeScript sources, then any inherited `PYTHONPATH`, so a working-directory module overrides a harness module of the same name. The system instructions end with a code block listing each top-level `def` and its docstring from those two directories, and omit a later definition of a name already found earlier on that path.

Before that run, the REPL asks for permission. `--need-permissions` defaults to true. Pass `--need-permissions false` to skip the prompt. A denial does not spawn python3; the next user message is a result-only denial and the model may continue.

The next user message is the result only. It does not contain the tool call:

```
exit: <code or error>
--- stdout ---
<stdout>
--- stderr ---
<stderr>
```

The model may call the tool again by ending its next reply with another block. At most 20 calls per human turn.

Model: `meta/muse-ember` through the Vercel AI Gateway. The AI SDK reads `AI_GATEWAY_API_KEY`. Run with `envchain vercel bun run index.ts`. `/exit` or Ctrl-D quits. Ctrl-C exits immediately, cancels an in-flight reply, and does not append a message.

Each process appends every message, including the system instructions, to `sessions/<ISO-start-timestamp>.jsonl`. Colons in the timestamp are hyphens.
