import { describe, expect, it } from "vitest";

import { DshAgentDriver } from "./dsh.ts";

describe("DshAgentDriver config", () => {
  it("looks up dsh on PATH instead of a developer worktree", () => {
    const cli = DshAgentDriver.defaultConfig().cli;
    expect(cli).toBe("dsh");
    expect(cli).not.toMatch(/dsh-runtime|dsh-acp\.sh/);
  });
});
