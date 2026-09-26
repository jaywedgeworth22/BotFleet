import { describe, expect, it } from "vitest";
import {
  SHARED_VPS_TARGET,
  VPS_CONTAINER_PREFIX,
  perBotVpsTarget,
  vpsTargetFor,
  vpsModeSwitchTargets,
  vpsContainerName,
} from "./vps-computer.ts";
import type { AppConfig } from "./config.ts";

function cfgWithVpsMode(mode: "shared" | "per-bot" | null): AppConfig {
  return { botDefaults: { vpsMode: mode } } as AppConfig;
}

describe("VPS targeting", () => {
  it("vpsTargetFor returns SHARED_VPS_TARGET when vpsMode is shared", () => {
    const target = vpsTargetFor(cfgWithVpsMode("shared"), "bot-1");
    expect(target).toBe(SHARED_VPS_TARGET);
    expect(target.key).toBe("shared");
    expect(target.containerName).toBe(`${VPS_CONTAINER_PREFIX}-shared`);
  });

  it("vpsTargetFor returns the same shared target for any botId in shared mode", () => {
    const cfg = cfgWithVpsMode("shared");
    const a = vpsTargetFor(cfg, "bot-a");
    const b = vpsTargetFor(cfg, "bot-b");
    expect(a).toBe(b);
    expect(a.containerName).toBe(b.containerName);
  });

  it("vpsTargetFor returns a per-bot target when vpsMode is per-bot", () => {
    const target = vpsTargetFor(cfgWithVpsMode("per-bot"), "bot-1");
    expect(target.key).toMatch(/^bot:/);
    expect(target.containerName).toBe(vpsContainerName("bot-1"));
  });

  it("vpsTargetFor returns a per-bot target when vpsMode is null (default)", () => {
    const target = vpsTargetFor(cfgWithVpsMode(null), "bot-1");
    expect(target.key).toMatch(/^bot:/);
  });

  it("two different bots in per-bot mode get distinct targets", () => {
    const cfg = cfgWithVpsMode("per-bot");
    const a = vpsTargetFor(cfg, "bot-a");
    const b = vpsTargetFor(cfg, "bot-b");
    expect(a.key).not.toBe(b.key);
    expect(a.containerName).not.toBe(b.containerName);
  });

  it("perBotVpsTarget produces a container name matching vpsContainerName", () => {
    const target = perBotVpsTarget("bot-42");
    expect(target.containerName).toBe(vpsContainerName("bot-42"));
    expect(target.key).toMatch(/^bot:[a-f0-9]{64}$/);
  });
});

describe("vpsModeSwitchTargets", () => {
  it("includes the shared target and all per-bot targets, deduped by key", () => {
    const targets = vpsModeSwitchTargets(["bot-a", "bot-b"]);
    const keys = targets.map((t) => t.key);
    expect(keys).toContain("shared");
    expect(keys.filter((k) => k.startsWith("bot:"))).toHaveLength(2);
    // No duplicates
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns only shared when there are no bots", () => {
    const targets = vpsModeSwitchTargets([]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.key).toBe("shared");
  });
});

describe("shared mode lifecycle targeting", () => {
  it("vpsComputerStatus inspects the shared container name, not the bot's", async () => {
    const { vpsComputerStatus, SHARED_VPS_TARGET } = await import("./vps-computer.ts");
    const inspected: string[] = [];
    const runner: import("./vps-computer.ts").VpsCommandRunner = async (args) => {
      // docker -H ssh://alias <command> ...
      const command = args[2];
      if (command === "image") {
        return { stdout: "[]", stderr: "" };
      }
      if (command === "inspect") {
        inspected.push(String(args[3] ?? ""));
        throw new Error(`Error: No such object: ${args[3]}`);
      }
      return { stdout: "", stderr: "" };
    };
    const cfg: AppConfig = {
      vps: { sshAlias: "test-vps" },
      botDefaults: { vpsMode: "shared" },
    };
    const status = await vpsComputerStatus(cfg, "bot-xyz", runner);
    expect(status.container_name).toBe(SHARED_VPS_TARGET.containerName);
    expect(inspected.some((name) => name === SHARED_VPS_TARGET.containerName)).toBe(true);
    expect(inspected.some((name) => name.includes("botxyz") || name.includes("bot-xyz"))).toBe(false);
  });

  it("vpsComputerStatus in per-bot mode still inspects the per-bot name", async () => {
    const { vpsComputerStatus, vpsContainerName } = await import("./vps-computer.ts");
    const inspected: string[] = [];
    const runner: import("./vps-computer.ts").VpsCommandRunner = async (args) => {
      const command = args[2];
      if (command === "image") return { stdout: "[]", stderr: "" };
      if (command === "inspect") {
        inspected.push(String(args[3] ?? ""));
        throw new Error(`Error: No such object: ${args[3]}`);
      }
      return { stdout: "", stderr: "" };
    };
    const cfg: AppConfig = {
      vps: { sshAlias: "test-vps" },
      botDefaults: { vpsMode: "per-bot" },
    };
    const status = await vpsComputerStatus(cfg, "bot-xyz", runner);
    expect(status.container_name).toBe(vpsContainerName("bot-xyz"));
    expect(inspected[0]).toBe(vpsContainerName("bot-xyz"));
  });
});
