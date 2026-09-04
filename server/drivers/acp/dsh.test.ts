import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyDshError,
  dshCredentialCandidates,
  DshAgentDriver,
  STATIC_DSH_MODELS,
  dshSpawnArgs,
  quoteDshMcpToken,
} from "./dsh.ts";

describe("DshAgentDriver config", () => {
  it("looks up dsh on PATH instead of a developer worktree", () => {
    const cli = DshAgentDriver.defaultConfig().cli;
    expect(cli).toBe("dsh");
    expect(cli).not.toMatch(/dsh-runtime|dsh-acp\.sh/);
  });

  it("defaults to current DeepSeek V4 ids, not retired chat/reasoner", () => {
    expect(STATIC_DSH_MODELS.default).toBe("deepseek-v4-flash");
    expect(STATIC_DSH_MODELS.options.map((option) => option.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]);
  });
});

describe("dshSpawnArgs MCP quoting", () => {
  it("keeps command and args intact when paths contain spaces", () => {
    const command = "/Users/example/Application Support/node";
    const script = "/tmp/My Tools/proxy.ts";
    const socket = "/tmp/a b.sock";
    const args = dshSpawnArgs(
      { cli: "dsh", fullAuto: false },
      {
        integrations: {
          agents: { command, args: [script, "--socket", socket], env: {} },
        },
      },
    );

    expect(args).toHaveLength(2);
    expect(args[0]).toBe("--mcp");
    expect(args[1]).toBe(
      `agents=${quoteDshMcpToken(command)} ${quoteDshMcpToken(script)} ${quoteDshMcpToken("--socket")} ${quoteDshMcpToken(socket)}`,
    );
    expect(args[1]).toContain(quoteDshMcpToken(command));
    expect(args[1]).toContain(quoteDshMcpToken(script));
    expect(args[1]).not.toContain(`${command} ${script}`);
  });

  it("skips integrations that are not a stdio command", () => {
    expect(
      dshSpawnArgs(
        { cli: "dsh", fullAuto: false },
        { integrations: { dweb: { url: "http://127.0.0.1:8080" } } },
      ),
    ).toEqual([]);
  });
});

describe("classifyDshError", () => {
  it("maps auth failures to invalid_credentials", () => {
    expect(classifyDshError(new Error("authentication required"))).toBe("invalid_credentials");
    expect(classifyDshError(new Error("invalid api key"))).toBe("invalid_credentials");
    const coded = new Error("unauthorized");
    Object.assign(coded, { code: 401 });
    expect(classifyDshError(coded)).toBe("invalid_credentials");
  });

  it("maps subscription failures to inactive_subscription", () => {
    expect(classifyDshError(new Error("inactive subscription"))).toBe("inactive_subscription");
  });

  it("maps quota/rate failures to quota_or_region_restriction", () => {
    expect(classifyDshError(new Error("rate limit exceeded"))).toBe("quota_or_region_restriction");
    expect(classifyDshError(new Error("insufficient balance"))).toBe("quota_or_region_restriction");
  });

  it("maps upstream outages", () => {
    expect(classifyDshError(new Error("service unavailable"))).toBe("upstream_outage");
    expect(classifyDshError(new Error("overloaded"))).toBe("upstream_outage");
  });

  it("maps unknown-model failures to model_catalog_outage", () => {
    expect(classifyDshError(new Error("model not found"))).toBe("model_catalog_outage");
  });

  it("returns undefined for unrecognized errors", () => {
    expect(classifyDshError(new Error("empty prompt"))).toBeUndefined();
    expect(classifyDshError("something else")).toBeUndefined();
  });
});

describe("dshCredentialCandidates", () => {
  it("honors DSH_HOME over the default ~/.dsh path", () => {
    const home = join("/home", "jay");
    expect(dshCredentialCandidates({ HOME: home })[0]).toBe(join(home, ".dsh", ".credentials.yaml"));
    expect(dshCredentialCandidates({ HOME: home, DSH_HOME: join("/opt", "dsh") })[0]).toBe(
      join("/opt", "dsh", ".credentials.yaml"),
    );
  });

  it("falls back to the platform home when HOME is unset", () => {
    const candidates = dshCredentialCandidates({});
    expect(candidates[0]).toContain(".dsh");
    expect(candidates[0]).toContain(".credentials.yaml");
  });
});
