import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createPatchCleanup, dshMcpPatchPaths } from "../dsh-acp-bridge.ts";
import {
  classifyDshError,
  dshCredentialCandidates,
  dshSupport,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshSpawnArgs,
  dshVersionCompatibilityReason,
  dshWrapSpawn,
  DshAgentDriver,
  DSH_MINIMUM_ACP_VERSION,
  STATIC_DSH_MODELS,
} from "./dsh.ts";
import type { AcpStdioMcpServer } from "./core.ts";
import { dshMcpPatchYaml, isStockDshCli, writeDshMcpPatch } from "./dsh-mcp.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** Remove a written patch overlay and the private directory it lives in.
 *
 * Guarded on the directory's own name rather than trusting whatever
 * `writeDshMcpPatch` returned: a regression that puts the overlay back in the
 * shared temp root must fail an assertion, never make this teardown delete
 * that root.  The same guard the bridge's cleanup uses, for the same reason. */
function removeWrittenPatch(patch: string): void {
  rmSync(patch, { force: true });
  const directory = dirname(patch);
  if (basename(directory).startsWith("botfleet-dsh-mcp-")) {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("DshAgentDriver config", () => {
  it("uses the published ACP profile and current package setup", () => {
    expect(DshAgentDriver.defaultConfig().cli).toBe("dsh");
    expect(dshSpawnArgs({ cli: "dsh", fullAuto: false }, { integrations: undefined })).toEqual([
      "--profile",
      "acp",
    ]);
    expect(DshAgentDriver.install).toMatchObject({
      command: {
        darwin: "npm install -g @deepseek-ai/dsh@latest",
        linux: "npm install -g @deepseek-ai/dsh@latest",
        win32: "npm install -g @deepseek-ai/dsh@latest",
      },
      docsUrl: "https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/acp-app",
      needsNode: true,
    });
  });

  it("defaults to the model ids published by the DeepSeek provider package", () => {
    expect(STATIC_DSH_MODELS.default).toBe("deepseek-v4-flash");
    // MiniMax-M2.7 dropped — M3 dominates it on context (1M vs 204k) and is
    // the canonical DSH-hosted MiniMax row that gets the full tool surface.
    expect(STATIC_DSH_MODELS.options.map((option) => option.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "MiniMax-M3",
    ]);
  });

  it("encodes the ACP model option with its provider while preserving the picker id", () => {
    expect(dshModelOptionValue("deepseek-v4-pro")).toBe('["deepseek-official","deepseek-v4-pro"]');
    expect(dshModelIdFromOptionValue('["deepseek-official","deepseek-v4-pro"]')).toBe("deepseek-v4-pro");
    expect(dshModelOptionValue("MiniMax-M3")).toBe('["minimax","MiniMax-M3"]');
    expect(dshModelIdFromOptionValue('["minimax","MiniMax-M3"]')).toBe("MiniMax-M3");
    expect(dshModelIdFromOptionValue('["other-provider","deepseek-v4-pro"]')).toBeNull();
    expect(dshModelIdFromOptionValue("deepseek-v4-pro")).toBeNull();
  });

  it("rejects stock DSH versions older than the native ACP profile", () => {
    expect(DSH_MINIMUM_ACP_VERSION).toBe("0.1.5-rc.1");
    expect(dshVersionCompatibilityReason("dsh 0.1.5-rc.1")).toBeNull();
    expect(dshVersionCompatibilityReason("0.1.5-rc.2")).toBeNull();
    expect(dshVersionCompatibilityReason("0.1.5")).toBeNull();
    expect(dshVersionCompatibilityReason("0.2.0")).toBeNull();
    expect(dshVersionCompatibilityReason("dsh 0.1.5-rc.0")).toMatch(/0\.1\.5-rc\.1 or newer/);
    expect(dshVersionCompatibilityReason("dsh 0.1.4")).toMatch(/0\.1\.5-rc\.1 or newer/);
    expect(dshVersionCompatibilityReason("development build")).toMatch(/0\.1\.5-rc\.1 or newer/);
    expect(dshVersionCompatibilityReason("development build", "/opt/dsh-wrapper")).toBeNull();
  });
});

describe("native DSH ACP turns", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "botfleet-dsh-acp-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_RPC_DUMP;
    delete process.env.FAKE_ACP_MODELS;
    delete process.env.FAKE_ACP_MODELS_JSON;
    delete process.env.FAKE_ACP_REASONING_EFFORTS;
    delete process.env.FAKE_ACP_REASONING_STICKS;
    delete process.env.FAKE_ACP_CONFIG_REPLY_BARE;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  const create = async () => {
    instance = await DshAgentDriver.create({
      instanceId: "dsh-native-test",
      displayName: "DeepSeek Harness",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  it("mounts standard MCP servers and applies confirmed model and reasoning options", async () => {
    const dump = join(scratch, "dsh.json");
    const flash = dshModelOptionValue("deepseek-v4-flash");
    const pro = dshModelOptionValue("deepseek-v4-pro");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([flash, pro]);
    process.env.FAKE_ACP_REASONING_EFFORTS = "off,high,max";
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-turn",
      text: "test the native ACP path",
      model: "deepseek-v4-pro",
      effort: "max",
      integrations: {
        agents: { command: "/usr/bin/node", args: ["/tmp/agents-proxy.mjs"], env: {} },
      },
    });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: true });
    expect(recorder!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.started", model: "deepseek-v4-pro" }),
    ]));
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["--profile", "acp"]);
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toEqual([
      expect.objectContaining({ name: "agents", command: "/usr/bin/node", args: ["/tmp/agents-proxy.mjs"] }),
    ]);
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toEqual([
      { method: "session/set_config_option", params: { sessionId: "fake-acp-session", configId: "model", value: pro } },
      { method: "session/set_config_option", params: { sessionId: "fake-acp-session", configId: "reasoning_effort", value: "max" } },
    ]);
  });

  it("uses session/resume because current DSH rejects session/load", async () => {
    const dump = join(scratch, "resume.json");
    process.env.FAKE_ACP_RPC_DUMP = dump;
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([dshModelOptionValue("deepseek-v4-flash")]);
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-resume",
      text: "continue",
      model: "deepseek-v4-flash",
      resumeCursor: "persisted-dsh-session",
    });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: true });
    const methods = JSON.parse(readFileSync(dump, "utf8")) as string[];
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/load");
    expect(methods).not.toContain("session/new");
  });

  it("reports the picker model id when a turn accepts the native session default", async () => {
    const flash = dshModelOptionValue("deepseek-v4-flash");
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([flash]);
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-default-model",
      text: "use the session default",
    });
    await recorder!.until((event) => event.type === "turn.completed");

    expect(recorder!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.started", model: "deepseek-v4-flash" }),
    ]));
  });

  it("fails before prompting if DSH acknowledges but does not apply reasoning effort", async () => {
    const rpcDump = join(scratch, "reasoning-stuck.json");
    process.env.FAKE_ACP_RPC_DUMP = rpcDump;
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([dshModelOptionValue("deepseek-v4-flash")]);
    process.env.FAKE_ACP_REASONING_EFFORTS = "off,high,max";
    process.env.FAKE_ACP_REASONING_STICKS = "1";
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-reasoning-stuck",
      text: "do not spend this turn on the wrong setting",
      model: "deepseek-v4-flash",
      effort: "max",
    });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: false });
    expect(recorder!.events.find((event) => event.type === "runtime.error")?.message).toMatch(
      /did not switch reasoning effort to max/,
    );
    const methods = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
    expect(methods).not.toContain("session/prompt");
  });

  it("accepts a bare set_config_option acknowledgement instead of failing the turn", async () => {
    const flash = dshModelOptionValue("deepseek-v4-flash");
    const pro = dshModelOptionValue("deepseek-v4-pro");
    process.env.FAKE_ACP_MODELS_JSON = JSON.stringify([flash, pro]);
    process.env.FAKE_ACP_REASONING_EFFORTS = "off,high,max";
    process.env.FAKE_ACP_CONFIG_REPLY_BARE = "1";
    await create();

    await instance!.adapter.sendTurn({
      threadId: "dsh-native-bare-config-reply",
      text: "run on the pinned model and effort",
      model: "deepseek-v4-pro",
      effort: "max",
    });
    const done = await recorder!.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: true });
    expect(recorder!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.started", model: "deepseek-v4-pro" }),
    ]));
  });
});

describe("dsh MCP delivery", () => {
  const localComputer = {
    command: "/opt/cua-driver",
    args: ["mcp", "--embedded"],
    env: { CUA_DRIVER_EMBEDDED: "1" },
    platform: "darwin" as const,
    scope: "local-computer" as const,
  };

  it("treats stock dsh binaries as the published CLI that needs the ACP bridge", () => {
    expect(isStockDshCli("dsh")).toBe(true);
    expect(isStockDshCli("/Users/jay/apps/dsh-runtime/dsh")).toBe(true);
    expect(isStockDshCli("/Users/jay/apps/dsh-runtime/dsh.sh")).toBe(true);
    expect(isStockDshCli(FAKE_CLI)).toBe(false);
    expect(isStockDshCli("/opt/dsh-wrapper")).toBe(false);
  });

  it("renders BotFleet stdio mounts as dsh-mcp-client --patch rows", () => {
    const yaml = dshMcpPatchYaml([
      {
        name: "computer",
        command: "/opt/cua-driver",
        args: ["mcp", "--embedded"],
        env: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }],
      },
    ]);
    expect(yaml).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(yaml).toContain('serverName: "computer"');
    expect(yaml).toContain('command: "/opt/cua-driver"');
    expect(yaml).toContain('          - "mcp"');
    expect(yaml).toContain("          CUA_DRIVER_EMBEDDED: \"1\"");
  });

  it("wraps stock dsh with the ACP bridge and a --patch overlay when mounts exist", () => {
    const wrapped = dshWrapSpawn("dsh", ["--profile", "acp"], {
      integrations: { localComputer },
    });
    expect(wrapped.cli).toBe(process.execPath);
    expect(wrapped.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(wrapped.args[0]).toBe(SPAWNED_PROXIES.dshAcpBridge);
    expect(wrapped.args.slice(1, 5)).toEqual(["--", "dsh", "--profile", "acp"]);
    const patch = wrapped.args[wrapped.args.indexOf("--patch") + 1];
    expect(basename(patch)).toContain("botfleet-dsh-mcp-");
    expect(readFileSync(patch, "utf8")).toContain('serverName: "computer"');
    removeWrittenPatch(patch);
  });

  // The overlay holds every mount's environment verbatim — OMB_COMMS_TOKEN,
  // OMB_CONTROL_TOKEN and any Composio key — so it must never be readable by
  // anyone else on a shared machine.  POSIX mode bits only: Windows has no
  // group or other bits to assert on, and a per-user temp directory there is
  // already private.
  it.skipIf(process.platform === "win32")(
    "writes the patch overlay into a private directory, readable only by this user",
    () => {
      const patch = writeDshMcpPatch([
        {
          name: "agents",
          command: "/opt/agents-mcp",
          args: [],
          env: [{ name: "OMB_COMMS_TOKEN", value: "not-a-real-token" }],
        },
      ]);
      try {
        expect(readFileSync(patch, "utf8")).toContain("not-a-real-token");
        expect(statSync(patch).mode & 0o077).toBe(0);
        expect(statSync(dirname(patch)).mode & 0o777).toBe(0o700);
      } finally {
        removeWrittenPatch(patch);
      }
    },
  );

  it("still hands the bridge a path it recognises, and the bridge removes the file and its directory", async () => {
    const patch = writeDshMcpPatch([
      { name: "computer", command: "/opt/cua-driver", args: ["mcp"], env: [] },
    ]);
    const directory = dirname(patch);
    expect(dshMcpPatchPaths(["--profile", "acp", "--patch", patch])).toEqual([patch]);
    try {
      createPatchCleanup([patch])();
      await vi.waitFor(() => {
        expect(existsSync(patch)).toBe(false);
        expect(existsSync(directory)).toBe(false);
      });
    } finally {
      removeWrittenPatch(patch);
    }
  });

  it("leaves no directory behind when the overlay cannot be written", () => {
    const listing = () => readdirSync(tmpdir()).filter((name) => name.startsWith("botfleet-dsh-mcp-"));
    const before = listing();
    const malformed: Partial<AcpStdioMcpServer>[] = [{ name: "computer", command: "/opt/cua-driver" }];
    // SAFETY: deliberately incomplete — a mount with no `args` makes the YAML
    // build throw inside writeDshMcpPatch, which is the only portable way to
    // reach its failure path; making the filesystem itself fail is not.
    expect(() => writeDshMcpPatch(malformed as AcpStdioMcpServer[])).toThrow();
    expect(listing()).toEqual(before);
  });

  it("leaves a non-dsh CLI unwrapped so tests still see session/new mcpServers", () => {
    expect(
      dshWrapSpawn(FAKE_CLI, ["--profile", "acp"], { integrations: { localComputer } }),
    ).toEqual({ cli: FAKE_CLI, args: ["--profile", "acp"] });
  });
});

describe("dsh capability honesty", () => {
  it("advertises only the controls implemented by the native ACP profile", async () => {
    const instance = await DshAgentDriver.create({
      instanceId: "dsh-capabilities",
      displayName: "DeepSeek Harness",
      environment: {},
      enabled: true,
      config: DshAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.adapter.capabilities).toMatchObject({
        agentsMcp: true,
        computerMcp: true,
        composioMcp: true,
        phoneMcp: true,
        qdrantMcp: true,
        localComputerMcp: true,
        images: false,
        effortLevels: ["none", "high", "max"],
      });
    } finally {
      await instance.dispose();
    }
  });
});

describe("classifyDshError", () => {
  it("maps provider failures to canonical fallback codes", () => {
    expect(classifyDshError(new Error("authentication required"))).toBe("invalid_credentials");
    expect(classifyDshError(new Error("inactive subscription"))).toBe("inactive_subscription");
    expect(classifyDshError(new Error("rate limit exceeded"))).toBe("quota_or_region_restriction");
    expect(classifyDshError(new Error("service unavailable"))).toBe("upstream_outage");
    expect(classifyDshError(new Error("model not found"))).toBe("model_catalog_outage");
    expect(classifyDshError(new Error("empty prompt"))).toBeUndefined();
  });
});

describe("dshCredentialCandidates", () => {
  it("recognizes only the credential file read by the published DSH package", () => {
    expect(dshCredentialCandidates({ HOME: "/home/jay" })).toEqual([
      join("/home/jay", ".dsh", ".credentials.yaml"),
    ]);
    expect(dshCredentialCandidates({ HOME: "/home/jay", DSH_HOME: "/opt/dsh" })).toEqual([
      join("/opt/dsh", ".credentials.yaml"),
    ]);
    expect(dshCredentialCandidates({})[0]).toContain(".credentials.yaml");
  });
});

describe("dsh authentication and credentials", () => {
  it("includes MINIMAX_API_KEY in credentialEnv", () => {
    expect(dshSupport.credentialEnv).toContain("MINIMAX_API_KEY");
    expect(dshSupport.credentialEnv).toContain("DEEPSEEK_API_KEY");
  });

  it("authenticates when MINIMAX_API_KEY is present", () => {
    expect(
      dshSupport.isAuthenticated(
        { HOME: "/nonexistent-dsh-home-test", MINIMAX_API_KEY: "minimax-secret" },
        { cli: "dsh", fullAuto: false },
      ),
    ).toBe(true);
  });

  it("authenticates when DEEPSEEK_API_KEY is present", () => {
    expect(
      dshSupport.isAuthenticated(
        { HOME: "/nonexistent-dsh-home-test", DEEPSEEK_API_KEY: "deepseek-secret" },
        { cli: "dsh", fullAuto: false },
      ),
    ).toBe(true);
  });

  it("fails authentication when no keys or credential files exist", () => {
    expect(
      dshSupport.isAuthenticated(
        { HOME: "/nonexistent-dsh-home-test" },
        { cli: "dsh", fullAuto: false },
      ),
    ).toBe(false);
  });
});
