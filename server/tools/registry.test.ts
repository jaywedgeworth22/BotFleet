// The registry exists to make one kind of bug impossible: a tool described
// differently on the MCP lane than on the HTTP lane.  That drift is not
// hypothetical — `list_bots` shipped offering a bot its own row on one lane
// and not the other, and hiding `busy` on one lane and not the other, within
// a single PR.  These tests are the guard rail that would have caught it.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HARNESS_TOOLS,
  descriptionFor,
  harnessTool,
  httpToolDefinitions,
  mcpToolDefinitions,
  schemaFor,
  toolsFor,
  type ToolGateContext,
} from "./registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const gate = (over: Partial<ToolGateContext> = {}): ToolGateContext => ({
  agents: true,
  commsDepth: 0,
  maxCommsDepth: 1,
  chiefOfStaff: true,
  ...over,
});

describe("every record is complete", () => {
  it("has a name, a description, a schema, a surface set and a side-effect class", () => {
    expect(HARNESS_TOOLS.length).toBeGreaterThan(0);
    for (const tool of HARNESS_TOOLS) {
      expect(tool.name, "name").toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(20);
      expect(tool.schema.type, `${tool.name} schema`).toBe("object");
      expect(typeof tool.surfaces.mcp, `${tool.name} surfaces.mcp`).toBe("boolean");
      expect(typeof tool.surfaces.http, `${tool.name} surfaces.http`).toBe("boolean");
      expect(tool.surfaces.mcp || tool.surfaces.http, `${tool.name} is on no lane`).toBe(true);
      expect(["read", "write"], `${tool.name} sideEffect`).toContain(tool.sideEffect);
      expect(["immediate", "suspend"], `${tool.name} settles`).toContain(tool.settles);
      expect(typeof tool.gate, `${tool.name} gate`).toBe("function");
    }
  });

  it("names are unique and resolvable", () => {
    const names = HARNESS_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(harnessTool(name)?.name).toBe(name);
    expect(harnessTool("delete_everything")).toBeUndefined();
  });

  it("publishes no JSON-Schema composition keywords, which agent CLIs drop", () => {
    // A model that never saw the branches guesses shapes forever.
    for (const tool of HARNESS_TOOLS) {
      for (const surface of ["mcp", "http"] as const) {
        expect(JSON.stringify(schemaFor(tool, surface))).not.toMatch(
          /"oneOf"|"anyOf"|"allOf"|"const"/,
        );
      }
    }
  });

  it("keeps read tools free of an approval ask — only a write tool needs a card", () => {
    for (const tool of HARNESS_TOOLS) {
      if (tool.sideEffect === "read") {
        expect(tool.approval?.policy ?? "never", `${tool.name}`).toBe("never");
        expect(tool.settles, `${tool.name}`).toBe("immediate");
      }
    }
  });

  it("marks list_routines read-only", () => {
    const tool = harnessTool("list_routines");
    expect(tool).toBeDefined();
    expect(tool!.sideEffect).toBe("read");
    expect(tool!.settles).toBe("immediate");
    expect(tool!.approval).toBeUndefined();
  });
});

describe("both lanes derive from the same records", () => {
  it("cover the same name set for the same gate", () => {
    // THE drift test.  A tool added to one renderer and not the other fails
    // here rather than in a user's transcript six weeks later.
    for (const ctx of [gate(), gate({ chiefOfStaff: false }), gate({ commsDepth: 1 })]) {
      const mcp = mcpToolDefinitions(ctx).map((t) => t.name);
      const http = httpToolDefinitions(ctx).map((t) => t.name);
      expect(http).toEqual(mcp);
    }
  });

  it("render the SAME record, so the two lanes cannot describe a tool differently", () => {
    const mcp = new Map(mcpToolDefinitions(gate()).map((t) => [t.name, t]));
    const http = new Map(httpToolDefinitions(gate()).map((t) => [t.name, t]));
    for (const [name, def] of mcp) {
      const peer = http.get(name)!;
      const tool = harnessTool(name)!;
      // Any difference has to be a DECLARED deviation carrying a reason.
      // Undeclared drift is what this assertion makes impossible.
      if (!tool.wire?.mcp?.description && !tool.wire?.http?.description) {
        expect(peer.description, `${name} description`).toBe(def.description);
      }
      if (!tool.wire?.mcp?.schema && !tool.wire?.http?.schema) {
        expect(peer.parameters, `${name} schema`).toEqual(def.inputSchema);
      }
    }
  });

  it("requires a reason on every declared wire deviation", () => {
    for (const tool of HARNESS_TOOLS) {
      for (const surface of ["mcp", "http"] as const) {
        const deviation = tool.wire?.[surface];
        if (!deviation) continue;
        expect(deviation.reason.length, `${tool.name}/${surface} reason`).toBeGreaterThan(40);
        expect(deviation.description ?? deviation.schema, `${tool.name}/${surface}`).toBeDefined();
      }
    }
  });

  it("keeps ask_bot's two argument spellings in step — same required arity, one alias", () => {
    const tool = harnessTool("ask_bot")!;
    expect(schemaFor(tool, "mcp").required).toEqual(["bot_id", "message"]);
    expect(schemaFor(tool, "http").required).toEqual(["bot_id", "task"]);
    expect(schemaFor(tool, "http").required!.length).toBe(schemaFor(tool, "mcp").required!.length);
    expect(descriptionFor(tool, "mcp")).not.toBe(descriptionFor(tool, "http"));
  });
});

describe("gating", () => {
  it("offers nothing when the agents integration is absent", () => {
    const ctx = gate({ agents: false });
    expect(mcpToolDefinitions(ctx)).toEqual([]);
    expect(httpToolDefinitions(ctx)).toEqual([]);
  });

  it("drops the peer-comms tools at the recursion cap but keeps the read-only one", () => {
    const ctx = gate({ commsDepth: 1, maxCommsDepth: 1 });
    const names = mcpToolDefinitions(ctx).map((t) => t.name);
    expect(names).not.toContain("list_bots");
    expect(names).not.toContain("ask_bot");
    // list_routines is not a hop, so the ceiling does not apply to it.
    expect(names).toContain("list_routines");
  });

  it("does not gate any of today's tools on chiefOfStaff", () => {
    // create_bot will; until it lands the flag must change nothing, and this
    // records that so the first gate on it is a deliberate edit.
    const withChief = toolsFor("mcp", gate({ chiefOfStaff: true })).map((t) => t.name);
    const without = toolsFor("mcp", gate({ chiefOfStaff: false })).map((t) => t.name);
    expect(without).toEqual(withChief);
  });

  it("offers the full set to a depth-0 bot with comms on", () => {
    expect(mcpToolDefinitions(gate()).map((t) => t.name)).toEqual([
      "list_bots",
      "ask_bot",
      "list_routines",
    ]);
  });
});

describe("the import cycle stays broken", () => {
  // `tool-executor.ts` imported `bus`, `store` and `executeAskBotRequest`
  // from `index.ts`, and `index.ts` imported the executor.  That cycle is
  // how the second copy of the `list_bots` filter came to exist.  Nothing
  // under `server/tools/` may reach `index.ts` again.
  const files = readdirSync(HERE).filter((f) => f.endsWith(".ts"));

  it("finds files to check", () => {
    expect(files).toContain("registry.ts");
    expect(files).toContain("agents.ts");
    expect(files).toContain("host.ts");
  });

  it("has no file under server/tools/ importing server/index.ts", () => {
    for (const file of files) {
      const source = readFileSync(join(HERE, file), "utf8");
      for (const line of source.split("\n")) {
        // Only real import/export specifiers; a prose mention of index.ts in
        // a comment is documentation, not a cycle.
        const specifier = line.match(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/)?.[1];
        if (!specifier) continue;
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/(^|\/)\.\.?\/index(\.ts)?$/);
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/(^|\/)index\.ts$/);
      }
    }
  });

  it("keeps registry.ts importable with no dependencies at all", () => {
    // agents-proxy.ts is spawned as a bare node child inside a bot's agent
    // process; it renders its MCP catalog from the registry, so the registry
    // must not drag the harness in behind it.
    const source = readFileSync(join(HERE, "registry.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
