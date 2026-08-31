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

  spawnArgs: (_config, _turn) => [
    // Official DSH ACP is a PATH binary. Instance config can override `cli`
    // for a custom script; session/set_model carries the model id.
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
  isAuthenticated: () => existsSync(join(homedir(), ".dsh", ".credentials.yaml")),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DshAgentDriver = createAcpDriver(support);
