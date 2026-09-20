/**
 * DSH ACP driver — BotFleet runtime composed with the Harness engine shape.
 *
 * Engine catalog, version gate, error classifier, and model-id round-trip
 * live in `jaywedgeworth22/Harness` (`harness/dsh/acp`).  This file keeps
 * `wrapSpawn` and `createAcpDriver` here because they need BotFleet's ACP
 * core and the Node stdio bridge.  Edit engine shape in Harness, not here.
 */
import {
  STATIC_DSH_MODELS,
  DSH_MINIMUM_ACP_VERSION,
  DSH_PROVIDER_ID,
  classifyDshError,
  dshCredentialCandidates,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshSpawnArgs as harnessDshSpawnArgs,
  dshSupport as harnessDshSupport,
  dshVersionCompatibilityReason,
} from "harness/dsh/acp";

import type { SendTurnInput } from "../../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { dshWrapSpawn } from "./dsh-mcp.ts";

export { dshWrapSpawn, isStockDshCli } from "./dsh-mcp.ts";
export {
  STATIC_DSH_MODELS,
  DSH_MINIMUM_ACP_VERSION,
  DSH_PROVIDER_ID,
  classifyDshError,
  dshCredentialCandidates,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshVersionCompatibilityReason,
};

export function dshSpawnArgs(config: AcpConfig, turn: Pick<SendTurnInput, "integrations">): string[] {
  return harnessDshSpawnArgs(config, turn);
}

export const dshSupport: AcpSupport = {
  ...harnessDshSupport,
  loginNote: harnessDshSupport.loginNote ?? "DSH CLI auth missing — add ~/.dsh/.credentials.yaml",
  resumeMethod: "session/resume" as const,
  spawnArgs: dshSpawnArgs,
  wrapSpawn: dshWrapSpawn,
  grok/harness-package
=======
  resumeMethod: "session/resume",
  selectModel: {
    configId: "model",
    valueForModel: dshModelOptionValue,
    modelForValue: dshModelIdFromOptionValue,
  },
  versionCompatibilityReason: (version, config) => dshVersionCompatibilityReason(version, config.cli),

  async configureSession({ request, sessionId, turn }) {
    if (!turn.effort) return;
    const requested = turn.effort === "none" ? "off" : turn.effort;
    const result = await request("session/set_config_option", {
      sessionId,
      configId: "reasoning_effort",
      value: requested,
    });
    const confirmed = currentConfigValue(result, "reasoning_effort");
    // Only a *reported* mismatch means the setting did not take.  A reply that
    // carries no option state (stock `dsh` answered `{}`) reports nothing to
    // compare, and failing on that refused every effort-pinned turn.
    if (confirmed !== undefined && confirmed !== requested) {
      throw new Error(
        `DeepSeek Harness did not switch reasoning effort to ${requested} (still ${String(confirmed ?? "unknown")})`,
      );
    }
  },

  transformEnv: (_env) => {},

  classifyError: classifyDshError,

  credentialEnv: [
    "DEEPSEEK_API_KEY",
    "MINIMAX_API_KEY",
    "DSH_HOME",
    "DSH_RUNTIME_ROOT",
    "DSH_PERMISSION_MODE",
  ],

  main
  pickAuthMethod: () => null,
  classifyError: classifyDshError,
} satisfies AcpSupport;

export const DshAgentDriver = createAcpDriver(dshSupport);
