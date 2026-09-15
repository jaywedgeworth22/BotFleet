// Host computer tools for the HTTP driver lane.
//
// These tools give an HTTP-driven bot (MiniMax, OpenAI-compatible) direct
// file and shell capabilities on the host computer when granted "This Computer".
// Like `agents.ts`, this module is completely free of dependencies on `server/index.ts`.
// Destructive operations (bash, write_file, edit_file) require approval via the
// permission broker before execution, which is enforced by `host.ts`.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { TurnToolCall, TurnToolOutcome, TurnToolRuntime } from "../contracts.ts";
import type { AgentToolCallContext } from "./agents.ts";

export type ComputerToolExecutor = (
  call: TurnToolCall,
  ctx: AgentToolCallContext,
  runtime: TurnToolRuntime,
) => Promise<TurnToolOutcome>;

export interface ComputerToolsOptions {
  cwd?: string;
}

function resolvePath(target: string, cwd?: string): string {
  if (isAbsolute(target)) return target;
  return cwd ? resolve(cwd, target) : resolve(target);
}

export function createComputerTools(options: ComputerToolsOptions = {}): Record<string, ComputerToolExecutor> {
  const workingDir = options.cwd && existsSync(options.cwd) ? options.cwd : process.cwd();

  const bash: ComputerToolExecutor = async (call) => {
    const rawCmd = call.arguments.command;
    if (typeof rawCmd !== "string" || !rawCmd.trim()) {
      return { kind: "error", content: "command argument must be a non-empty string", detail: "invalid_argument" };
    }
    const command = rawCmd.trim();

    const shell = process.platform === "win32" ? "cmd.exe" : (process.env.SHELL || "/bin/zsh");
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

    return new Promise<TurnToolOutcome>((resolvePromise) => {
      execFile(
        shell,
        shellArgs,
        {
          cwd: workingDir,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
          env: process.env,
        },
        (error, stdout, stderr) => {
          if (error && (error as unknown as { killed?: boolean }).killed) {
            return resolvePromise({
              kind: "error",
              content: "Command timed out after 60 seconds",
              detail: "timeout",
            });
          }

          const outText = String(stdout || "").trim();
          const errText = String(stderr || "").trim();
          const parts: string[] = [];

          if (outText) parts.push(outText);
          if (errText) parts.push(`STDERR:\n${errText}`);

          if (error) {
            const exitCode = (error as unknown as { code?: number | string }).code ?? 1;
            parts.push(`Process exited with code ${exitCode}`);
            return resolvePromise({
              kind: "error",
              content: parts.join("\n\n") || `Command exited with code ${exitCode}`,
              detail: `exit ${exitCode}`,
            });
          }

          return resolvePromise({
            kind: "result",
            content: parts.join("\n\n") || "(command completed with no output)",
          });
        },
      );
    });
  };

  const readFile: ComputerToolExecutor = async (call) => {
    const rawPath = call.arguments.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { kind: "error", content: "path argument must be a non-empty string", detail: "invalid_argument" };
    }

    const fullPath = resolvePath(rawPath.trim(), workingDir);
    if (!existsSync(fullPath)) {
      return { kind: "error", content: `File not found: ${rawPath}`, detail: "not_found" };
    }

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        return { kind: "error", content: `Path is a directory, not a file: ${rawPath}`, detail: "is_directory" };
      }

      const raw = readFileSync(fullPath, "utf8");
      const lines = raw.split("\n");
      const total = lines.length;

      const offsetArg = call.arguments.offset;
      const limitArg = call.arguments.limit;

      const offset = typeof offsetArg === "number" && Number.isInteger(offsetArg) && offsetArg > 0 ? offsetArg : 1;
      const limit = typeof limitArg === "number" && Number.isInteger(limitArg) && limitArg > 0 ? limitArg : undefined;

      const startIdx = Math.max(0, offset - 1);
      const endIdx = limit ? Math.min(total, startIdx + limit) : total;
      const sliced = lines.slice(startIdx, endIdx);

      const numbered = sliced.map((line, idx) => `${startIdx + idx + 1}: ${line}`).join("\n");
      return {
        kind: "result",
        content: numbered,
        detail: `lines ${startIdx + 1}-${endIdx} of ${total}`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: "error", content: `Failed to read file ${rawPath}: ${message}`, detail: "read_error" };
    }
  };

  const writeFile: ComputerToolExecutor = async (call) => {
    const rawPath = call.arguments.path;
    const content = call.arguments.content;

    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { kind: "error", content: "path argument must be a non-empty string", detail: "invalid_argument" };
    }
    if (typeof content !== "string") {
      return { kind: "error", content: "content argument must be a string", detail: "invalid_argument" };
    }

    const fullPath = resolvePath(rawPath.trim(), workingDir);
    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        kind: "result",
        content: `Successfully wrote ${bytes} bytes to ${rawPath}`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: "error", content: `Failed to write file ${rawPath}: ${message}`, detail: "write_error" };
    }
  };

  const editFile: ComputerToolExecutor = async (call) => {
    const rawPath = call.arguments.path;
    const oldStr = call.arguments.old_string;
    const newStr = call.arguments.new_string;

    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { kind: "error", content: "path argument must be a non-empty string", detail: "invalid_argument" };
    }
    if (typeof oldStr !== "string" || !oldStr) {
      return { kind: "error", content: "old_string argument must be a non-empty string", detail: "invalid_argument" };
    }
    if (typeof newStr !== "string") {
      return { kind: "error", content: "new_string argument must be a string", detail: "invalid_argument" };
    }

    const fullPath = resolvePath(rawPath.trim(), workingDir);
    if (!existsSync(fullPath)) {
      return { kind: "error", content: `File not found: ${rawPath}`, detail: "not_found" };
    }

    try {
      const existing = readFileSync(fullPath, "utf8");
      if (!existing.includes(oldStr)) {
        return {
          kind: "error",
          content: `Target content old_string not found in ${rawPath}. Ensure exact character match.`,
          detail: "no_match",
        };
      }

      const occurrences = existing.split(oldStr).length - 1;
      if (occurrences > 1) {
        return {
          kind: "error",
          content: `Target content matched ${occurrences} times in ${rawPath}. Specify more unique context so only one match is replaced.`,
          detail: "multiple_matches",
        };
      }

      // Use a function replacement so `$` sequences in the model-supplied
      // new_string (e.g. `$&`, `$1`, `$$`) are written literally instead of
      // being interpreted as special replacement patterns.
      const replaced = existing.replace(oldStr, () => newStr);
      writeFileSync(fullPath, replaced, "utf8");
      return {
        kind: "result",
        content: `Successfully edited ${rawPath}`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: "error", content: `Failed to edit file ${rawPath}: ${message}`, detail: "edit_error" };
    }
  };

  return {
    bash,
    read_file: readFile,
    write_file: writeFile,
    edit_file: editFile,
  };
}
