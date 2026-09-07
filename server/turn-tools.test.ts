import { describe, expect, it } from "vitest";
import { buildTurnTools } from "./turn-tools.ts";

describe("buildTurnTools", () => {
  it("returns an empty list when no integrations are mounted", () => {
    expect(buildTurnTools(undefined)).toEqual([]);
    expect(buildTurnTools({})).toEqual([]);
  });

  it("includes the agent delegation tools when agents is mounted", () => {
    const tools = buildTurnTools({ agents: { command: "node", args: [], env: {} } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_bots");
    expect(names).toContain("ask_bot");
  });

  it("includes the composio tools when composio is mounted", () => {
    const tools = buildTurnTools({ composio: { command: "node", args: [], env: {} } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("COMPOSIO_SEARCH_TOOLS");
    expect(names).toContain("COMPOSIO_GET_TOOL_SCHEMAS");
    expect(names).toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
  });

  it("includes the computer tools when computer or localComputer is mounted", () => {
    const boxTools = buildTurnTools({
      computer: { kind: "box", boxId: "b", token: "t" },
    });
    expect(boxTools.map((t) => t.name)).toContain("computer_screenshot");
    expect(boxTools.map((t) => t.name)).toContain("computer_click");

    const localTools = buildTurnTools({
      localComputer: { command: "node", args: [], env: {} },
    });
    expect(localTools.map((t) => t.name)).toContain("computer_screenshot");
  });

  it("includes the computer tools when the computers array is non-empty", () => {
    const tools = buildTurnTools({
      computers: [
        { kind: "box", boxId: "b", token: "t" } as any,
      ],
    });
    expect(tools.map((t) => t.name)).toContain("computer_screenshot");
  });

  it("combines multiple integrations into a single list", () => {
    const tools = buildTurnTools({
      agents: { command: "node", args: [], env: {} },
      composio: { command: "node", args: [], env: {} },
      computer: { kind: "box", boxId: "b", token: "t" },
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_bots");
    expect(names).toContain("ask_bot");
    expect(names).toContain("COMPOSIO_SEARCH_TOOLS");
    expect(names).toContain("COMPOSIO_SEARCH_TOOLS");
    expect(names).toContain("computer_screenshot");
  });
});
