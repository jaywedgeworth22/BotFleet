import { describe, expect, it } from "vitest";

import {
  classifyTool,
  clip,
  describeResult,
  describeTarget,
  shortenPath,
  toolActivity,
  toolVerb,
  TARGET_LIMIT,
} from "./tool-activity.ts";

describe("classifyTool", () => {
  it("lands every engine's spelling of the same job on one kind", () => {
    for (const name of ["Read", "read_file", "readFile", "view", "read-many-files"]) {
      expect(classifyTool(name)).toBe("read");
    }
    for (const name of ["Bash", "shell", "run_command", "runTerminalCommand", "local_shell"]) {
      expect(classifyTool(name)).toBe("execute");
    }
    for (const name of ["Edit", "write_file", "apply_patch", "str_replace_editor", "MultiEdit"]) {
      expect(classifyTool(name)).toBe("edit");
    }
  });

  it("prefers the engine's own kind over a guess from the name", () => {
    // ACP reports kind directly; an MCP tool named "acme_do" is unguessable
    expect(classifyTool("acme_do", "execute")).toBe("execute");
    expect(classifyTool("acme_do")).toBe("other");
  });

  it("does not guess when nothing matches, because a wrong icon is worse than none", () => {
    expect(classifyTool("mcp__sentry__find_organizations")).toBe("search");
    expect(classifyTool("zzz")).toBe("other");
    expect(classifyTool(undefined)).toBe("other");
  });
});

describe("toolVerb", () => {
  it("uses the shared verb for a recognised kind", () => {
    expect(toolVerb("read", "read_file")).toBe("Read");
    expect(toolVerb("execute", "run_command")).toBe("Run");
  });

  it("keeps the engine's own name when the kind is unknown, so the row still identifies the tool", () => {
    expect(toolVerb("other", "mcp__slack__send_message")).toBe("mcp__slack__send_message");
    expect(toolVerb("other", undefined)).toBe("Tool");
  });
});

describe("shortenPath", () => {
  it("replaces the home prefix, which is the part carrying no information", () => {
    expect(shortenPath("/Users/jay/apps/x/y.ts", "/Users/jay")).toBe("~/apps/x/y.ts");
    expect(shortenPath("/Users/jay", "/Users/jay")).toBe("~");
    expect(shortenPath("C:\\Users\\jay\\x", "C:\\Users\\jay")).toBe("~\\x");
  });

  it("leaves a path outside home alone, and survives no home at all", () => {
    expect(shortenPath("/etc/hosts", "/Users/jay")).toBe("/etc/hosts");
    expect(shortenPath("/etc/hosts")).toBe("/etc/hosts");
    // a sibling directory must not be mistaken for a child of home
    expect(shortenPath("/Users/jaywalker/x", "/Users/jay")).toBe("/Users/jaywalker/x");
  });
});

describe("clip", () => {
  it("flattens whitespace so a multi-line command stays one row", () => {
    expect(clip("git status\n  && git diff", 80)).toBe("git status && git diff");
  });

  it("marks the clip, so a reader knows the row is a headline", () => {
    const clipped = clip("x".repeat(200), 10);
    expect(clipped).toHaveLength(10);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("describeTarget", () => {
  it("prefers ACP's own locations, which is the spec's answer to this question", () => {
    expect(
      describeTarget({ file_path: "/tmp/ignored" }, { locations: [{ path: "/Users/jay/a.ts" }], home: "/Users/jay" }),
    ).toBe("~/a.ts");
  });

  it("counts the rest when a step touched more than one file", () => {
    expect(
      describeTarget({}, { locations: [{ path: "/a.ts" }, { path: "/b.ts" }, { path: "/c.ts" }] }),
    ).toBe("/a.ts +2");
  });

  it("reads the command before anything else a shell payload carries", () => {
    expect(describeTarget({ cwd: "/repo", command: "pnpm test" })).toBe("pnpm test");
  });

  it("finds the file, pattern, query or url each engine names differently", () => {
    expect(describeTarget({ file_path: "/Users/jay/a.ts" }, { home: "/Users/jay" })).toBe("~/a.ts");
    expect(describeTarget({ target_file: "src/x.ts" })).toBe("src/x.ts");
    expect(describeTarget({ pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(describeTarget({ url: "https://example.com" })).toBe("https://example.com");
  });

  it("falls back to any scalar rather than saying nothing", () => {
    expect(describeTarget({ weird_field: "something" })).toBe("something");
  });

  it("clips, so one megabyte of payload can never reach a transcript row", () => {
    const target = describeTarget({ command: "x".repeat(5_000) });
    expect(target).toBeDefined();
    expect(target!.length).toBeLessThanOrEqual(TARGET_LIMIT);
  });

  it("returns nothing when the payload names nothing", () => {
    expect(describeTarget(undefined)).toBeUndefined();
    expect(describeTarget({})).toBeUndefined();
    expect(describeTarget({ enabled: true })).toBeUndefined();
  });
});

describe("describeResult", () => {
  it("reads the text out of an ACP content block", () => {
    expect(describeResult([{ type: "content", content: { type: "text", text: "3 files changed" } }])).toBe(
      "3 files changed",
    );
  });

  it("reads a plain string and a Claude tool_result alike", () => {
    expect(describeResult("exit 0")).toBe("exit 0");
    expect(describeResult([{ type: "text", text: "not found" }])).toBe("not found");
  });

  it("returns nothing for an empty result, so a clean step stays a bare row", () => {
    expect(describeResult(undefined)).toBeUndefined();
    expect(describeResult([])).toBeUndefined();
    expect(describeResult({})).toBeUndefined();
  });
});

describe("toolActivity", () => {
  it("derives the whole row in one call", () => {
    expect(
      toolActivity("read_file", { rawInput: { file_path: "/Users/jay/apps/a.ts" }, home: "/Users/jay" }),
    ).toEqual({ kind: "read", verb: "Read", target: "~/apps/a.ts" });
  });

  it("still produces a usable row when the engine sent nothing but a name", () => {
    expect(toolActivity("Bash")).toEqual({ kind: "execute", verb: "Run", target: undefined });
  });
});
