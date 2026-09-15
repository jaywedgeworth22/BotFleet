import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import {
  classifyDshError,
  dshCredentialCandidates,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshSpawnArgs,
  dshVersionCompatibilityReason,
  DshAgentDriver,
  DSH_MINIMUM_ACP_VERSION,
  STATIC_DSH_MODELS,
} from "./dsh.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

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
    expect(STATIC_DSH_MODELS.options.map((option) => option.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("encodes the ACP model option with its provider while preserving the picker id", () => {
    expect(dshModelOptionValue("deepseek-v4-pro")).toBe('["deepseek-official","deepseek-v4-pro"]');
    expect(dshModelIdFromOptionValue('["deepseek-official","deepseek-v4-pro"]')).toBe("deepseek-v4-pro");
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
