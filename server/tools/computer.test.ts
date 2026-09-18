import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TurnToolCall, TurnToolRuntime } from "../contracts.ts";
import type { AgentToolCallContext } from "./agents.ts";
import { createComputerTools } from "./computer.ts";

const dummyIdentity: AgentToolCallContext = {
  botId: "bot-1",
  threadId: "thread-1",
  commsDepth: 0,
};

const dummyRuntime: TurnToolRuntime = {
  signal: new AbortController().signal,
  requestApproval: async () => "allowed-once",
};

describe("computer tools", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "bf-comp-test-"));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  describe("bash", () => {
    it("executes a basic shell command successfully", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-1",
        name: "bash",
        arguments: { command: 'echo "hello from bash"' },
      };
      const result = await tools.bash(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");
      expect(result.content).toContain("hello from bash");
    });

    it("reports an error on non-zero exit code", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-2",
        name: "bash",
        arguments: { command: "exit 42" },
      };
      const result = await tools.bash(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("42");
    });

    it("rejects empty or missing command", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-3",
        name: "bash",
        arguments: { command: "  " },
      };
      const result = await tools.bash(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("command argument must be a non-empty string");
    });
  });

  describe("read_file", () => {
    it("reads full file contents with line numbers", async () => {
      const filePath = join(scratchDir, "test.txt");
      writeFileSync(filePath, "line one\nline two\nline three\n", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-4",
        name: "read_file",
        arguments: { path: "test.txt" },
      };
      const result = await tools.read_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");
      expect(result.content).toBe("1: line one\n2: line two\n3: line three\n4: ");
    });

    it("supports offset and limit", async () => {
      const filePath = join(scratchDir, "test2.txt");
      writeFileSync(filePath, "A\nB\nC\nD\nE\n", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-5",
        name: "read_file",
        arguments: { path: "test2.txt", offset: 2, limit: 2 },
      };
      const result = await tools.read_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");
      expect(result.content).toBe("2: B\n3: C");
    });

    it("returns error for missing file", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-6",
        name: "read_file",
        arguments: { path: "nonexistent.txt" },
      };
      const result = await tools.read_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("File not found");
    });
  });

  describe("write_file", () => {
    it("writes file and creates parent directories if needed", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-7",
        name: "write_file",
        arguments: { path: "sub/dir/output.txt", content: "hello world" },
      };
      const result = await tools.write_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");
      expect(result.content).toContain("Successfully wrote 11 bytes");

      const content = readFileSync(join(scratchDir, "sub/dir/output.txt"), "utf8");
      expect(content).toBe("hello world");
    });
  });

  describe("edit_file", () => {
    it("replaces target string when unique", async () => {
      const filePath = join(scratchDir, "target.txt");
      writeFileSync(filePath, "const greeting = 'hello';\nconst name = 'world';", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-8",
        name: "edit_file",
        arguments: {
          path: "target.txt",
          old_string: "const greeting = 'hello';",
          new_string: "const greeting = 'hi';",
        },
      };
      const result = await tools.edit_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");

      const updated = readFileSync(filePath, "utf8");
      expect(updated).toBe("const greeting = 'hi';\nconst name = 'world';");
    });

    it("fails when target string is not found", async () => {
      const filePath = join(scratchDir, "target.txt");
      writeFileSync(filePath, "some text", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-9",
        name: "edit_file",
        arguments: {
          path: "target.txt",
          old_string: "not here",
          new_string: "replacement",
        },
      };
      const result = await tools.edit_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("Target content old_string not found");
    });

    it("fails when target string matches multiple times", async () => {
      const filePath = join(scratchDir, "target.txt");
      writeFileSync(filePath, "apple banana apple", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-10",
        name: "edit_file",
        arguments: {
          path: "target.txt",
          old_string: "apple",
          new_string: "orange",
        },
      };
      const result = await tools.edit_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("matched 2 times");
    });

    it("writes replacement-pattern characters literally", async () => {
      const filePath = join(scratchDir, "target.txt");
      writeFileSync(filePath, "PLACEHOLDER", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-11",
        name: "edit_file",
        arguments: {
          path: "target.txt",
          old_string: "PLACEHOLDER",
          new_string: "$& costs $$5",
        },
      };
      const result = await tools.edit_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");

      const updated = readFileSync(filePath, "utf8");
      expect(updated).toBe("$& costs $$5");
    });
  });
});

// CONFINEMENT — a workspace-only bot (no This Computer grant) gets the file
// tools with `confinement` set, and every path is realpath-checked against
// the bot's workspace root.  The exact same class of escape bot-cwd.test.ts
// exercises for the phone-originated cwd path (symlinks out of the root,
// `..` traversal, absolute path elsewhere) — so the same set of failure
// scenarios lives here.
describe("createComputerTools with confinement (workspace-only bots)", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "bf-comp-confinement-"));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function confinedTools() {
    return createComputerTools({ cwd: scratchDir, confinement: { workspaceRealpath: scratchDir } });
  }

  function unconfinedTools() {
    // A This Computer bot: explicitly without `confinement` so the existing
    // whole-host view is unchanged.
    return createComputerTools({ cwd: scratchDir });
  }

  it("reads a file inside the workspace (positive case)", async () => {
    writeFileSync(join(scratchDir, "in.txt"), "hello\n");
    const result = await confinedTools().read_file(
      { id: "c-r1", name: "read_file", arguments: { path: join(scratchDir, "in.txt") } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("result");
    expect(result.content).toContain("hello");
  });

  it("refuses to read an absolute path that escapes the workspace (e.g. /etc/passwd)", async () => {
    const result = await confinedTools().read_file(
      { id: "c-r2", name: "read_file", arguments: { path: "/etc/passwd" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
    expect(result.content).toMatch(/outside this bot's workspace/i);
  });

  it("refuses to read a `..`-traversed path under the workspace that escapes it", async () => {
    const result = await confinedTools().read_file(
      { id: "c-r3", name: "read_file", arguments: { path: join(scratchDir, "..", "sibling.txt") } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
  });

  it("refuses a symlink inside the workspace that points outside (e.g. ~/.ssh)", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "bf-comp-outside-"));
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "ssh-private-key-bytes");
    const link = join(scratchDir, "escape");
    try {
      symlinkSync(outsideFile, link, "file");
    } catch {
      rmSync(outsideDir, { recursive: true, force: true });
      return; // no symlink permission on this runner
    }
    const result = await confinedTools().read_file(
      { id: "c-r4", name: "read_file", arguments: { path: link } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("refuses to write an absolute path outside the workspace", async () => {
    const result = await confinedTools().write_file(
      { id: "c-w1", name: "write_file", arguments: { path: "/tmp/should-not-exist.txt", content: "nope" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
  });

  it("refuses to edit an absolute path outside the workspace", async () => {
    const result = await confinedTools().edit_file(
      { id: "c-e1", name: "edit_file", arguments: { path: "/etc/hostname", old_string: "x", new_string: "y" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
  });

  it("writes a new file inside the workspace (positive case)", async () => {
    const target = join(scratchDir, "nested", "new.txt");
    const result = await confinedTools().write_file(
      { id: "c-w2", name: "write_file", arguments: { path: target, content: "ok" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("result");
  });

  it("allows bash even when confinement is set — bash is gated on hostComputer only, so a workspace-only bot never sees it in production", async () => {
    // Regression guard: the P0 fix confines FILE tools, not bash.  bash
    // remains gated on hostComputer at the registry level, so a
    // workspace-only bot never sees it; this test pins the executor's
    // unchanged behavior (it still shells out unconfined) so a future
    // refactor that tries to also gate bash inside this file cannot
    // silently start adding a confinement check that changes the
    // production guarantee.
    const tools = confinedTools();
    expect(tools.bash).toBeDefined();
    const result = await tools.bash(
      { id: "c-b1", name: "bash", arguments: { command: "true" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.detail).not.toBe("outside_workspace");
  });

  it("a This Computer bot (no confinement set) keeps its whole-host view — this is the only path that legitimately touches /etc/hosts", async () => {
    // The confining change is opt-in via the `confinement` option, so a
    // caller (currently: the 1:1 and room dispatch paths when the bot has
    // hasHostComputer) that omits it gets exactly the pre-fix behavior.
    // macOS-only because /etc/hosts is a macOS path; skip elsewhere.
    if (process.platform !== "darwin") return;
    const result = await unconfinedTools().read_file(
      { id: "c-r5", name: "read_file", arguments: { path: "/etc/hosts" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("result");
  });
});
