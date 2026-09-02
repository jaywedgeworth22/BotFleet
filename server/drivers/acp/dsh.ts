import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const STATIC_DSH_MODELS: ModelCatalog = {
  default: "deepseek-chat",
  options: [
    { id: "deepseek-chat", label: "DeepSeek Chat" },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  ],
};

const support: AcpSupport = {
  driverKind: "dshAgent",
  displayName: "DeepSeek Harness",
  images: false,
  models: STATIC_DSH_MODELS,
  resolveModels: () => STATIC_DSH_MODELS,
  defaultCli: "dsh",
  nativeSource: "dsh.acp",
  loginNote: "DSH CLI auth missing — add ~/.dsh/.credentials.yaml",

  install: {
    docsUrl: "https://github.com/deepseek-ai/dsh",
  },

  resolveTurnModel: (model) => model,

  spawnArgs: (_config, turn) => {
    const args = [];
    if (turn.integrations) {
      for (const [name, def] of Object.entries(turn.integrations)) {
        if (def && typeof def === "object" && "command" in def) {
          args.push("--mcp", `${name}=${def.command} ${(def.args || []).join(" ")}`);
        }
      }
    }
    return args;
  },

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
