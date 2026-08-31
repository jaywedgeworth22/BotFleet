import { join } from "node:path";
import { homedir } from "node:os";

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
  effortLevels: ["low", "medium", "high"], // Whatever is supported
  defaultCli: join(homedir(), "apps", "dsh-runtime", "dsh-acp.sh"),
  nativeSource: "dsh.acp",
  loginNote: "DSH CLI auth missing — add ~/.dsh/.credentials.yaml",

  install: {
    docsUrl: "https://github.com/deepseek-ai/dsh",
  },

  resolveTurnModel: (model) => model,

  spawnArgs: (_config, _turn) => [
    // dsh-acp.sh takes no arguments or we can pass model if needed. 
    // Usually ACP handles it via session/set_model or init payload.
  ],

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
  authFailure: "fail",
  isAuthenticated: () => true,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DshAgentDriver = createAcpDriver(support);
