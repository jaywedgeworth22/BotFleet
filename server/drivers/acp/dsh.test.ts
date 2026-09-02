import { describe, expect, it } from "vitest";

import { DshAgentDriver, STATIC_DSH_MODELS } from "./dsh.ts";

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
    ]);
  });
});
