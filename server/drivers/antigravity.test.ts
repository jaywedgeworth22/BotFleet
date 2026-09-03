// Antigravity driver contract tests, run against the scripted fake `agy` CLI
// in server/testing/fake-agy-cli.ts: normalize the print-mode stream-json turn
// into canonical events, and report availability from `agy --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly;
// spawnCli resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import { isQuotaOrCapText, parseQuotaResetTime } from "../model-fallback.ts";
import type { ProviderInstance } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  ANTIGRAVITY_COMPUTER_MCP_KEY,
  AntigravityDriver,
  antigravityMcpServers,
  antigravityTurnErrorMessage,
  parseAntigravityTurnResult,
  ensureAntigravityMcp,
  readAntigravityModelCatalog,
  STATIC_ANTIGRAVITY_MODELS,
} from "./antigravity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

describe("readAntigravityModelCatalog", () => {
  it("returns the official list when settings are missing", () => {
    expect(readAntigravityModelCatalog({ HOME: join(tmpdir(), "omb-agy-missing-home") })).toEqual(
      STATIC_ANTIGRAVITY_MODELS,
    );
  });

  it("tags extra settings models as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-catalog-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ customModels: [{ id: "local-gemini", displayName: "Local Gemini" }] }),
    );
    try {
      const catalog = readAntigravityModelCatalog({ HOME: home });
      expect(catalog.options.slice(0, STATIC_ANTIGRAVITY_MODELS.options.length)).toEqual(STATIC_ANTIGRAVITY_MODELS.options);
      expect(catalog.options.at(-1)).toEqual({ id: "local-gemini", label: "Local Gemini", custom: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Antigravity decodeConfig", () => {
  it("publishes the official installer for every supported platform", () => {
    expect(AntigravityDriver.install).toMatchObject({
      command: {
        darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        win32: "irm https://antigravity.google/cli/install.ps1 | iex",
      },
    });
  });

  it("defaults to the agy binary with the permission bypass off", () => {
    // --dangerously-skip-permissions skips the broker entirely; a fresh bot
    // must not inherit that, and defaultConfig() goes through the same path
    expect(AntigravityDriver.decodeConfig({})).toEqual({ cli: "agy", fullAuto: false });
    expect(AntigravityDriver.decodeConfig(undefined)).toEqual({ cli: "agy", fullAuto: false });
    expect(AntigravityDriver.defaultConfig?.()).toEqual({ cli: "agy", fullAuto: false });
  });
  it("fullAuto is an explicit opt-in: true only when stored as true", () => {
    expect(AntigravityDriver.decodeConfig({}).fullAuto).toBe(false);
    expect(AntigravityDriver.decodeConfig({ fullAuto: false }).fullAuto).toBe(false);
    expect(AntigravityDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
  it("rejects invalid types (throws → shadow snapshot)", () => {
    expect(() => AntigravityDriver.decodeConfig({ cli: 5 })).toThrow(/invalid cli/);
    expect(() => AntigravityDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/invalid fullAuto/);
  });
});

// The real shapes agy 1.1.12–1.1.25 writes into `result.error` when a turn
// fails, copied verbatim from BotFleet's own native stream logs.
const AGY_QUOTA_ERROR =
  "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 44h3m45s.";
const AGY_ELIGIBILITY_ERROR =
  'Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": read tcp 192.168.1.253:55172->172.217.116.4:443: read: connection reset by peer';

describe("antigravityTurnErrorMessage", () => {
  it("names the engine and keeps agy's quota wording and reset window", () => {
    const message = antigravityTurnErrorMessage({ status: "ERROR", error: AGY_QUOTA_ERROR });
    expect(message).toBe(`Antigravity: ${AGY_QUOTA_ERROR}`);
    // The harness classifies the chip from this text: it has to read as a
    // quota hit, and the reset window has to parse, or the bot silently
    // retries the same exhausted provider on the next turn.
    expect(isQuotaOrCapText(`error: ${message}`)).toBe(true);
    const parsed = parseQuotaResetTime(message, Date.parse("2026-09-03T07:54:39Z"));
    expect(parsed.isQuotaOrCap).toBe(true);
    expect(parsed.resetsAt).toBe(Date.parse("2026-09-03T07:54:39Z") + 44 * 3600 * 1000);
  });

  it("passes through a non-quota failure without inventing a cap", () => {
    const message = antigravityTurnErrorMessage({ status: "ERROR", error: AGY_ELIGIBILITY_ERROR });
    expect(message.startsWith("Antigravity: Eligibility check failed:")).toBe(true);
    // A network reset must not be read as a usage cap — that would burn the
    // one auto-failover hop and park the engine on a cooldown it never hit.
    expect(isQuotaOrCapText(`error: ${message}`)).toBe(false);
    expect(antigravityTurnErrorMessage({ status: "ERROR", error: "timeout waiting for response" })).toBe(
      "Antigravity: timeout waiting for response",
    );
  });

  it("trims a long message but never drops the reset window", () => {
    const long = `Individual quota reached. Please upgrade your subscription to increase your limits. ${"provider detail ".repeat(40)}Resets in 12h30m0s.`;
    const message = antigravityTurnErrorMessage({ status: "ERROR", error: long });
    expect(message.length).toBeLessThan(500); // model-fallback's quota-chip ceiling
    expect(message).toContain("Resets in 12h30m0s.");
    expect(isQuotaOrCapText(`error: ${message}`)).toBe(true);
  });

  it("still says something when agy sends a bare status", () => {
    expect(antigravityTurnErrorMessage({ status: "ERROR", error: null })).toBe(
      "Antigravity: the turn ended with status ERROR and no reply",
    );
    expect(antigravityTurnErrorMessage({ status: null, error: "   " })).toBe(
      "Antigravity: the turn ended with status ERROR and no reply",
    );
    // Shape drift must still end the turn, never widen a failure into success.
    expect(parseAntigravityTurnResult({ status: 7, error: { message: "x" } })).toEqual({
      status: null,
      error: null,
    });
    expect(parseAntigravityTurnResult("not an object")).toEqual({ status: null, error: null });
  });
});

describe("Antigravity turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-test",
      displayName: "Antigravity Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full print-mode turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "gemini-3.1-pro-high" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // tool ACTIVE
      "item.completed", // tool DONE
      "thread.token-usage.updated", // agent_response usage
      "content.delta", // result.response
      "item.completed", // assistant_text
      "thread.token-usage.updated", // result usage
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "antigravityAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as any).sessionId).toBe("conv-fake-123");

    const tool = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "tool")!;
    expect((tool as any).ok).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 105, output: 20 });

    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("done from fake agy");

    const done = recorder.events.at(-1)!;
    // result.usage is the turn total (the per-step figures precede it)
    expect(done).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 105, output: 20 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  // The stuck-forever bug. Every one of these used to leave the turn
  // unsettled or settled in silence, so the mascot kept counting seconds
  // with nothing ever arriving in its place.
  it("surfaces a provider quota as a runtime error and ends the turn", async () => {
    await create({ FAKE_AGY_RESULT_ERROR: AGY_QUOTA_ERROR });
    await instance.adapter.sendTurn({ threadId: "t-quota", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error).toBeDefined();
    expect((error as any).message).toBe(`Antigravity: ${AGY_QUOTA_ERROR}`);
    // the error has to reach the fold BEFORE the turn settles, or the chip
    // is not there yet when turn.completed decides whether to fail over
    const types = recorder.events.map((e) => e.type);
    expect(types.indexOf("runtime.error")).toBeLessThan(types.indexOf("turn.completed"));

    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: false, stopReason: "ERROR" });
    expect(instance.adapter.hasSession("t-quota")).toBe(false);
  });

  it("ends the turn on a bare non-zero exit, with the CLI's stderr", async () => {
    await create({ FAKE_AGY_DIE: "3", FAKE_AGY_STDERR: "agy: authentication expired\n" });
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect((error as any).message).toContain("agy exited 3 before result");
    expect((error as any).message).toContain("authentication expired");
    expect(recorder.events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: false,
      stopReason: "exit_before_result",
    });
    expect(instance.adapter.hasSession("t-crash")).toBe(false);
  });

  it("ends the turn on a silent EOF — exit 0, no stream, no result", async () => {
    await create({ FAKE_AGY_DIE: "0" });
    await instance.adapter.sendTurn({ threadId: "t-silent", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect((error as any).message).toBe("agy exited 0 before result");
    expect(recorder.events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: false,
      stopReason: "exit_before_result",
    });
    expect(instance.adapter.hasSession("t-silent")).toBe(false);
  });

  // `close` waits on the stdio pipes, so a grandchild that outlives agy —
  // one of agy's own MCP servers — holds it back forever. `exit` is the
  // process's real death, and the turn has to end on that alone.
  it.skipIf(process.platform === "win32")(
    "ends the turn on exit even when a grandchild holds stdout open",
    async () => {
      await create({ FAKE_AGY_LEAK_STDOUT: "1" });
      await instance.adapter.sendTurn({ threadId: "t-leak", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");

      const error = recorder.events.find((e) => e.type === "runtime.error")!;
      expect((error as any).message).toContain("before result");
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
      expect(instance.adapter.hasSession("t-leak")).toBe(false);
    },
    10_000,
  );

  it("respondToRequest resolves `unavailable` — no interactive permission channel, so the caller denies", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-happy", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("spawns agy with --mode accept-edits by default, and the bypass only when opted in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-agy-args-"));
    const argvFor = async (config: { cli: string; fullAuto?: boolean }, name: string) => {
      const dump = join(dir, `${name}.json`);
      const inst = await AntigravityDriver.create({
        instanceId: `agy-args-${name}`,
        displayName: undefined,
        environment: { FAKE_AGY_DUMP: dump },
        enabled: true,
        // through decodeConfig on purpose: the default is the thing under test
        config: AntigravityDriver.decodeConfig(config),
      });
      const rec = recordEvents(inst.adapter);
      try {
        await inst.adapter.sendTurn({ threadId: `t-args-${name}`, text: "hi" });
        await rec.until((e) => e.type === "turn.completed");
        return JSON.parse(readFileSync(dump, "utf8")).argv as string[];
      } finally {
        rec.stop();
        await inst.dispose();
      }
    };
    try {
      const defaults = await argvFor({ cli: FAKE_CLI }, "default");
      expect(defaults).not.toContain("--dangerously-skip-permissions");
      const mode = defaults.indexOf("--mode");
      expect(defaults.slice(mode, mode + 2)).toEqual(["--mode", "accept-edits"]);

      const opted = await argvFor({ cli: FAKE_CLI, fullAuto: true }, "bypass");
      expect(opted).toContain("--dangerously-skip-permissions");
      expect(opted).not.toContain("--mode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Antigravity snapshot", () => {
  it("reports available with the CLI version against the fake", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("1.1.12");
    // agy auth is keyring-backed with no reliable file marker, so the snapshot
    // must NOT claim signed-in from a mere directory — authenticated stays unset.
    expect((snap as any).authenticated).toBeUndefined();
    await instance.dispose();
  });

  it("a missing binary is unavailable", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "agy-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-agy-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("strips workspace credentials from snapshot and helper children", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-env-"));
    const dump = join(scratch, "dump.json");
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "OPENCODE_API_KEY", "OMB_TTS_KEY"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.FAKE_AGY_DUMP = dump;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;
    const instance = await AntigravityDriver.create({
      instanceId: "agy-env",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await instance.snapshot();
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();

      await instance.generateText?.("summarize safely");
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_DUMP;
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("Antigravity computer MCP config", () => {
  const configPath = (home: string) => join(home, ".gemini", "config", "mcp_config.json");
  const readConfig = (home: string) => JSON.parse(readFileSync(configPath(home), "utf8"));
  const boxIntegrations = {
    computer: {
      kind: "box" as const,
      boxId: "bx_1",
      token: "box-tok",
      control: { url: "http://127.0.0.1:9/control", token: "ctl-tok" },
    },
  };
  const boxEntry = () => antigravityMcpServers(boxIntegrations)["botfleet-computer"]!;

  it("builds the cloud-box spec on the shared computer proxy (never path-resolved locally)", () => {
    expect(antigravityMcpServers(boxIntegrations)["botfleet-computer"]).toEqual({
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: "bx_1",
        OGB_BOX_TOKEN: "box-tok",
        OMB_CONTROL_URL: "http://127.0.0.1:9/control",
        OMB_CONTROL_TOKEN: "ctl-tok",
      },
    });
  });

  it("passes a Local VM / VPS stdio connection through unchanged, and yields null without a computer", () => {
    expect(
      antigravityMcpServers({
        localComputer: { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
      }),
    ).toEqual({ "botfleet-localComputer": { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } } });
    expect(antigravityMcpServers({})["botfleet-localComputer"]).toBeUndefined();
    expect(antigravityMcpServers(undefined)["botfleet-localComputer"]).toBeUndefined();
  });

  it("upserts only its own key — the user's servers and unknown top-level keys survive", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpcfg-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } },
          futureTopLevelKey: { keep: true },
        }),
      );
      ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });
      let config = readConfig(home);
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      // A later turn on a different computer overwrites the key in place.
      ensureAntigravityMcp(
        { [ANTIGRAVITY_COMPUTER_MCP_KEY]: { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } } },
        { HOME: home },
      );
      config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY].command).toBe("/opt/cua");
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts fresh from malformed JSON instead of failing the turn", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpbad-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(configPath(home), "{{{ not json");
      ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restricts the token-bearing config directory and file to the current user", () => {
    if (process.platform === "win32") return;
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpperms-"));
    try {
      const directory = dirname(configPath(home));
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      writeFileSync(configPath(home), "{}\n", { mode: 0o644 });

      ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves concurrent config edits while restoring only its own MCP entry", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpconcurrent-"));
    try {
      const restoreNewFile = ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });
      const concurrentlyCreated = readConfig(home);
      concurrentlyCreated.mcpServers["external-helper"] = { command: "external-mcp" };
      concurrentlyCreated.futureTopLevelKey = { keep: true };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyCreated));

      restoreNewFile();
      expect(existsSync(configPath(home))).toBe(true);
      let restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(restored.mcpServers["external-helper"]).toEqual({ command: "external-mcp" });
      expect(restored.futureTopLevelKey).toEqual({ keep: true });

      const originalEntry = { command: "user-owned-mcp", args: ["--serve"] };
      writeFileSync(
        configPath(home),
        JSON.stringify({ mcpServers: { [ANTIGRAVITY_COMPUTER_MCP_KEY]: originalEntry } }),
      );
      const restoreExistingEntry = ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });
      const concurrentlyEdited = readConfig(home);
      concurrentlyEdited.mcpServers["another-helper"] = { command: "another-mcp" };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyEdited));

      restoreExistingEntry();
      restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(originalEntry);
      expect(restored.mcpServers["another-helper"]).toEqual({ command: "another-mcp" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a computer-less turn removes only its own key, and never creates the file just to remove", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcprm-"));
    try {
      // No file at all: removal is a no-op, not an empty file in the user's home.
      ensureAntigravityMcp({}, { HOME: home });
      expect(existsSync(configPath(home))).toBe(false);

      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: {
            "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] },
            [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
          },
        }),
      );
      ensureAntigravityMcp({}, { HOME: home });
      const config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("advertises computerMcp and the tool integrations, but never host control (print mode has no approval channel)", async () => {
    ensureDirs();
    const fullAuto = await AntigravityDriver.create({
      instanceId: "agy-caps-full",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const acceptEdits = await AntigravityDriver.create({
      instanceId: "agy-caps-safe",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(fullAuto.adapter.capabilities.computerMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.localComputerMcp).toBe(false);
      expect(fullAuto.adapter.capabilities.agentsMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.composioMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.phoneMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.qdrantMcp).toBe(true);
      expect(acceptEdits.adapter.capabilities.computerMcp).toBe(true);
      expect(acceptEdits.adapter.capabilities.localComputerMcp).toBe(false);
      expect(acceptEdits.adapter.capabilities.agentsMcp).toBe(true);
    } finally {
      await fullAuto.dispose();
      await acceptEdits.dispose();
    }
  });

  it("uses the spawned CLI's HOME and restores the prior config when the turn exits", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpturn-"));
    const dump = join(home, "mcp-at-spawn.json");
    const original = JSON.stringify({ mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } } });
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(configPath(home), original);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-mcp-turn",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "100", FAKE_AGY_MCP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-mcp-on",
        text: "click things",
        integrations: boxIntegrations,
      });
      // sendTurn resolves after the child is spawned; the write happens
      // synchronously before that spawn, so this IS the spawn-time content.
      const mounted = readConfig(home);
      expect(mounted.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(mounted.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => readFileSync(configPath(home), "utf8")).toBe(original);
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serializes overlapping turns so each child sees only its own computer mount", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcplease-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-first",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "150", FAKE_AGY_MCP_DUMP: firstDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-second",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-first", text: "first", integrations: boxIntegrations });
      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-second", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondSpawned).toBe(false);
      await firstRecorder.until((event) => event.type === "turn.completed");
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps a child that hangs after result, restores the mount, and unblocks the next turn", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpreaper-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-zombie",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_MCP_DUMP: firstDump,
        FAKE_AGY_POST_RESULT_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-zombie",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-zombie", text: "first", integrations: boxIntegrations });
      await firstRecorder.until((event) => event.type === "turn.completed");
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-zombie", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("force-reaps an interrupted child that ignores SIGTERM before result", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpinterrupt-"));
    const readyFile = join(home, "ready");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-interrupted",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
        FAKE_AGY_READY_FILE: readyFile,
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-interrupt",
      displayName: undefined,
      environment: { HOME: home },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-interrupted", text: "first", integrations: boxIntegrations });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => existsSync(readyFile), { timeout: 2_000 }).toBe(true);
      await first.adapter.interruptTurn("t-mcp-interrupted");

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-interrupt", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");
      await expect.poll(() => existsSync(configPath(home)), { timeout: 6_000 }).toBe(false);
    } finally {
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
