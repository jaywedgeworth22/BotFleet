#!/usr/bin/env node
// Fake of the Antigravity `agy` CLI's print-mode stdio surface, for driver
// tests of drivers/antigravity.ts. On `--version` it prints a version; on a
// print-mode invocation (`--print <prompt> … --output-format stream-json`) it
// reads the prompt from the `--print` ARGV value (the real CLI does NOT read a
// piped prompt in print mode), then emits a canned NDJSON turn: init → tool
// step (ACTIVE then DONE) → agent_response step with usage → result with
// status SUCCESS. Deterministic, no network.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
if (process.env.FAKE_AGY_READY_FILE) {
  writeFileSync(process.env.FAKE_AGY_READY_FILE, "ready");
}
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env }, null, 2));
}
if (argv.includes("--version")) {
  console.log("1.1.12");
  process.exit(0);
}

const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
if (process.env.FAKE_AGY_MCP_DUMP) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let config = "null";
  try {
    config = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
  } catch {}
  writeFileSync(process.env.FAKE_AGY_MCP_DUMP, config);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const CONV = "conv-fake-123";

// Failure shapes the real agy produces, for the driver's error-mapping tests.
// FAKE_AGY_RESULT_ERROR: emit init, then one `result` with status ERROR and
// this text — how agy reports a provider quota, a failed eligibility check,
// and its own "timeout waiting for response".
// FAKE_AGY_DIE: exit with this code after writing FAKE_AGY_STDERR (if any)
// and no NDJSON at all — a crash, or the silent EOF of an exit-0 no-op.
// FAKE_AGY_LEAK_STDOUT: hand stdout to a detached grandchild that outlives
// this process, so the driver's `close` never fires and only `exit` does.
// writeSync: a piped stderr is async, and process.exit below would drop it.
if (process.env.FAKE_AGY_STDERR) writeSync(2, process.env.FAKE_AGY_STDERR);
if (process.env.FAKE_AGY_DIE) process.exit(Number(process.env.FAKE_AGY_DIE));

// The prompt is the value that follows --print on argv (mirrors the driver,
// which no longer pipes stdin). A bare --print with no value yields no turn.
const printIdx = argv.indexOf("--print");
const prompt = printIdx !== -1 ? argv[printIdx + 1] : undefined;
if (!prompt) process.exit(0);

if (process.env.FAKE_AGY_LEAK_STDOUT) {
  // The grandchild inherits this process's stdout pipe and keeps it open
  // after this process is gone — the real shape of an agy-spawned MCP server
  // that outlives its parent.
  const { spawn } = await import("node:child_process");
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  }).unref();
  process.exit(0);
}

if (process.env.FAKE_AGY_RESULT_ERROR) {
  out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: [], permission_mode: "accept-edits" } });
  out({
    event: "result",
    conversation_id: CONV,
    result: {
      conversation_id: CONV,
      status: "ERROR",
      response: "",
      error: process.env.FAKE_AGY_RESULT_ERROR,
      duration_seconds: 1,
      num_turns: 1,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    },
  });
  process.exit(0);
}

out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file"], permission_mode: "accept-edits" } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
out({ event: "result", conversation_id: CONV, result: { conversation_id: CONV, status: "SUCCESS", response: "done from fake agy", duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
const postResultDelayMs = Number(process.env.FAKE_AGY_POST_RESULT_DELAY_MS ?? 0);
if (Number.isFinite(postResultDelayMs) && postResultDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
}
process.exit(0);
