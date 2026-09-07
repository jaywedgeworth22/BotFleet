import { describe, expect, it } from "vitest";
import { buildTurnTools } from "./turn-tools.ts";

describe("buildTurnTools", () => {
  it("returns an empty array when no integrations are enabled", () => {
    expect(buildTurnTools({})).toEqual([]);
  });

  it("returns the agents tools when integrations.agents is set", () => {
    const tools = buildTurnTools({ agents: { section: "ops" } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_bots");
    expect(names).toContain("ask_bot");
  });

  it("marks ask_bot as requiring both bot_id and task", () => {
    const tools = buildTurnTools({ agents: {} });
    const askBot = tools.find((t) => t.name === "ask_bot");
    expect(askBot).toBeDefined();
    expect(askBot?.parameters?.required).toEqual(["bot_id", "task"]);
  });

  it("does not expose Composio or computer-use tools on the HTTP lane", () => {
    const tools = buildTurnTools({ agents: {} });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("COMPOSIO_SEARCH_TOOLS");
    expect(names).not.toContain("COMPOSIO_GET_TOOL_SCHEMAS");
    expect(names).not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(names).not.toContain("computer_screenshot");
    expect(names).not.toContain("computer_click");
    expect(names).not.toContain("computer_type");
  });
});
