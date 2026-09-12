// The `tool_calls: <names>` stop reason is gone from this repo, and this test
// is what keeps it gone.
//
// It was a string protocol between two HTTP drivers and the harness: an inner
// tool round settled the turn with that prefix, five consumers recognised it
// and skipped their work, and six others — the Sentry span closer,
// releaseLocalVmThread, the SSE broadcast, routines.handleRuntimeEvent, the
// repeat detector and the room waiter — did not, so they ran against an event
// that was not a real end of turn.  Every exit that was NOT "the model
// answered" emitted no terminal event at all, and the bot stayed busy until
// the twenty-minute stall watchdog fired.
//
// The drivers now run their own model-to-tool rounds and emit exactly one
// terminal event per user turn (server/drivers/chat-completions/loop.ts), so
// there is nothing left for a consumer to guard on.  A new driver that
// reinvented the prefix would silently re-arm all eleven consumers, which is
// exactly the kind of regression a grep is good at catching.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** This file names both dead symbols in its own prose, so it is the one file
 *  that cannot be its own violation. */
const SELF = "server/tool-calls-protocol.test.ts";

/** Every tracked or newly added source file, read once.  `git ls-files` is
 *  what makes this a whole-repo assertion that still runs in milliseconds —
 *  a recursive walk over ios/ and node_modules-adjacent trees took longer
 *  than the test timeout. */
const sources: Array<{ path: string; text: string }> = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
)
  .split("\n")
  .filter((rel) => rel && rel !== SELF && SOURCE.test(rel))
  .filter((rel) => existsSync(join(ROOT, rel)))
  .map((rel) => ({ path: rel, text: readFileSync(join(ROOT, rel), "utf8") }));

describe("the tool_calls stop-reason protocol is gone", () => {
  it("sees a real repo", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("no file references isToolCallsStopReason", () => {
    const offenders = sources.filter((f) => f.text.includes("isToolCallsStopReason")).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("no driver builds a `tool_calls: …` stop reason", () => {
    // The construction, not the OpenAI wire field: a `stopReason:` property
    // carrying the prefix.  `tool_calls: msg?.tool_calls` and friends are
    // request-body object literals and stay legal; a test that asserts the
    // prefix is ABSENT reads `stopReason ?? ""` and is not a construction.
    const built = /stopReason:\s*[^;\n]*tool_calls:\s/;
    const offenders = sources.filter((f) => built.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("server/tool-executor.ts no longer exists", () => {
    expect(existsSync(join(ROOT, "server/tool-executor.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "server/tool-executor.test.ts"))).toBe(false);
  });
});
