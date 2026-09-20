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

import type { ProviderErrorCode, SendTurnInput } from "../../contracts.ts";
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

/**
 * The Harness package's error codes include "unknown"; BotFleet's
 * ProviderErrorCode does not — an unrecognized harness code is the same as
 * no classification here.
 */
function dshClassifyError(error: unknown): ProviderErrorCode | undefined {
  const code = classifyDshError(error);
  return code === "unknown" ? undefined : code;
}

function currentConfigValue(result: unknown, configId: string): unknown {
  if (!result || typeof result !== "object") return undefined;
  const options = (result as { configOptions?: unknown }).configOptions;
  if (!Array.isArray(options)) return undefined;
  const option = options.find(
    (candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === configId,
  );
  return option && typeof option === "object" ? (option as { currentValue?: unknown }).currentValue : undefined;
}

export const dshSupport = {
  ...harnessDshSupport,
  loginNote: harnessDshSupport.loginNote ?? "DSH CLI auth missing — add ~/.dsh/.credentials.yaml",
  resumeMethod: "session/resume" as const,
  spawnArgs: dshSpawnArgs,
  wrapSpawn: dshWrapSpawn,
  pickAuthMethod: () => null,
  classifyError: dshClassifyError,
  isAuthenticated: (env: Record<string, string | undefined>, _config: AcpConfig) =>
    harnessDshSupport.isAuthenticated?.(env) ?? false,
  authFailure: "continue" as const,
  buildPromptText: (turn: SendTurnInput) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
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
} satisfies AcpSupport;

export const DshAgentDriver = createAcpDriver(dshSupport);
