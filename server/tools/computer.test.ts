import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
