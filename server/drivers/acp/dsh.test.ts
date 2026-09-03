import { describe, expect, it } from "vitest";

import { DshAgentDriver, STATIC_DSH_MODELS, dshSpawnArgs, quoteDshMcpToken } from "./dsh.ts";

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
    const command = "/Users/jay/Application Support/node";
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
