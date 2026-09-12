import { describe, expect, it } from "vitest";
import { buildTurnTools } from "./turn-tools.ts";
import { httpToolDefinitions } from "./tools/registry.ts";

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

  it("renders the registry rather than a second set of definitions", () => {
    // The catalog used to be written out longhand here, which is how the
    // HTTP lane's `list_bots` came to describe itself differently from the
    // MCP lane's.  This file is a shim now; the records live in the registry.
    expect(buildTurnTools({ agents: {} })).toEqual(
      httpToolDefinitions({
        agents: true,
        commsDepth: 0,
        maxCommsDepth: Number.POSITIVE_INFINITY,
        chiefOfStaff: false,
      }),
    );
  });

  it("offers the read-only list_routines alongside the peer-comms tools", () => {
    expect(buildTurnTools({ agents: {} }).map((t) => t.name)).toContain("list_routines");
  });

  it("applies the recursion ceiling when the caller passes real numbers", () => {
    const capped = buildTurnTools({ agents: {} }, { commsDepth: 1, maxCommsDepth: 1 });
    expect(capped.map((t) => t.name)).toEqual(["list_routines"]);
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
