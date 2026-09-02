import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, SendTurnInput } from "../../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

/** Quote one argv token inside a `--mcp name=command args` spec.  JSON
 * string quoting survives spaces, quotes, and backslashes without a shell,
 * and stays one spawn() argument because the spec is not split. */
export function quoteDshMcpToken(value: string): string {
  return JSON.stringify(value);
}

/** CLI argv after `dsh` for ACP.  MCP command and args stay distinct even
 * when a path contains spaces — join(" ") without quoting is the failure. */
export function dshSpawnArgs(_config: AcpConfig, turn: Pick<SendTurnInput, "integrations">): string[] {
  const args: string[] = [];
  if (!turn.integrations) return args;
  for (const [name, def] of Object.entries(turn.integrations)) {
    if (!def || typeof def !== "object" || !("command" in def)) continue;
    const command = String(def.command);
    const extra = "args" in def && Array.isArray(def.args) ? def.args.map(String) : [];
    args.push("--mcp", `${name}=${[command, ...extra].map(quoteDshMcpToken).join(" ")}`);
  }
  return args;
}

export const STATIC_DSH_MODELS: ModelCatalog = {
  default: "deepseek-v4-flash",
  options: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek-V4-Flash-Vision-Exp" },
  ],
};

const support: AcpSupport = {
  driverKind: "dshAgent",
  displayName: "DeepSeek Harness",
  images: false,
  models: STATIC_DSH_MODELS,
  resolveModels: () => STATIC_DSH_MODELS,
  effortLevels: ["low", "medium", "high", "max"] as const,
  defaultCli: "dsh",
  nativeSource: "dsh.acp",
  loginNote: "DSH CLI auth missing — add ~/.dsh/.credentials.yaml",

  install: {
    docsUrl: "https://github.com/deepseek-ai/dsh",
  },

  resolveTurnModel: (model) => model,

  spawnArgs: dshSpawnArgs,

  async configureSession({ request, sessionId, turn }) {
    if (!turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch {
      // ignore
    }
  },

  transformEnv: (_env) => {},

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) =>
    existsSync(join(homedir(), ".dsh", ".credentials.yaml")) ||
    existsSync(join(homedir(), ".deepseek", "credentials.json")) ||
    existsSync(join(homedir(), ".deepseek-code", "credentials", "deepseek-code.json")) ||
    Boolean(env.DEEPSEEK_API_KEY),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DshAgentDriver = createAcpDriver(support);
