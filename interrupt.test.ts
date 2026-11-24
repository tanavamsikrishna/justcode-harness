/**
 * Ctrl-C exits immediately. It aborts an in-flight reply and does not record
 * or send a message.
 */

import { describe, expect, test } from "bun:test";
import { killActiveSnippet, runSnippet } from "./harness.ts";
import {
  interruptSession,
  listenForInterrupt,
  SIGINT_EXIT_CODE,
} from "./index.ts";

function exitWith(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("interruptSession", () => {
  test("aborts, stops, closes, and exits without recording a message", () => {
    const events: string[] = [];
    const logged: string[] = [];
    expect(() =>
      interruptSession({
        abort: () => events.push("abort"),
        stop: () => events.push("stop"),
        close: () => events.push("close"),
        exit: (code) => {
          events.push(`exit:${code}`);
          return exitWith(code);
        },
      }),
    ).toThrow(`exit:${SIGINT_EXIT_CODE}`);
    expect(events).toEqual([
      "abort",
      "stop",
      "close",
      `exit:${SIGINT_EXIT_CODE}`,
    ]);
    expect(logged).toEqual([]);
  });

  test("still exits when abort and close throw", () => {
    const events: string[] = [];
    expect(() =>
      interruptSession({
        abort: () => {
          throw new Error("abort failed");
        },
        close: () => {
          events.push("close");
          throw new Error("close failed");
        },
        exit: (code) => {
          events.push(`exit:${code}`);
          return exitWith(code);
        },
      }),
    ).toThrow(`exit:${SIGINT_EXIT_CODE}`);
    expect(events).toEqual(["close", `exit:${SIGINT_EXIT_CODE}`]);
  });
});

describe("listenForInterrupt", () => {
  test("runs the handler for readline and process SIGINT", () => {
    const sources = [fakeSigint(), fakeSigint()];
    let calls = 0;
    listenForInterrupt(sources, () => {
      calls += 1;
    });
    sources[0]?.emit();
    sources[1]?.emit();
    expect(calls).toBe(2);
  });
});

describe("killActiveSnippet", () => {
  test("does nothing when no snippet is running", () => {
    expect(killActiveSnippet()).toBe(false);
  });

  test("stops a running snippet without waiting for it to finish", async () => {
    const pending = runSnippet("import time\ntime.sleep(30)", {
      timeoutMs: 10_000,
    });
    const started = Date.now();
    let killed = false;
    while (!killed && Date.now() - started < 2_000) {
      killed = killActiveSnippet();
      if (!killed) await Bun.sleep(10);
    }
    expect(killed).toBe(true);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.exitCode).not.toBe(0);
  });
});

function fakeSigint(): {
  on(event: "SIGINT", listener: () => void): void;
  emit(): void;
} {
  const listeners: Array<() => void> = [];
  return {
    on(_event, listener) {
      listeners.push(listener);
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
}
