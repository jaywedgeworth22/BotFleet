/**
 * DSH ACP driver — BotFleet runtime composed with the Harness engine shape.
 *
 * Engine catalog, version gate, error classifier, and model-id round-trip
 * live in `jaywedgeworth22/Harness` (`harness/dsh/acp`).  This file keeps
 * `wrapSpawn` and `createAcpDriver` here because they need BotFleet's ACP
 * core and the Node stdio bridge.  Edit engine shape in Harness, not here.
 */
import {
  STATIC_DSH_MODELS as harnessDshModels,
  DSH_MINIMUM_ACP_VERSION,
  DSH_PROVIDER_ID,
  DSH_MINIMAX_PROVIDER_ID,
  classifyDshError,
  dshCredentialCandidates,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshProviderForModel,
  dshSpawnArgs as harnessDshSpawnArgs,
  dshSupport as harnessDshSupport,
  dshVersionCompatibilityReason,
} from "harness/dsh/acp";

import type { ProviderErrorCode, SendTurnInput } from "../../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { dshWrapSpawn } from "./dsh-mcp.ts";

export { dshWrapSpawn, isStockDshCli } from "./dsh-mcp.ts";
/** BotFleet DSH model catalog.  The Harness package still publishes
 * MiniMax-M2.7, but it is dropped here per the product decision (M3 dominates
 * on context and is the canonical DSH-hosted MiniMax row). */
export const STATIC_DSH_MODELS = {
  ...harnessDshModels,
  options: harnessDshModels.options.filter((option) => option.id !== "MiniMax-M2.7"),
};

export {
  DSH_MINIMUM_ACP_VERSION,
  DSH_PROVIDER_ID,
  DSH_MINIMAX_PROVIDER_ID,
  classifyDshError,
  dshCredentialCandidates,
  dshModelIdFromOptionValue,
  dshModelOptionValue,
  dshProviderForModel,
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

/** DSH's `initialize` base deadline.  `dsh --profile acp` answers only after
 * its Cordis host has loaded ~200 plugin packages: about 3.5 s of CPU, which
 * the shared 60 s default was cutting off once host load stretched it (p99
 * of answered DSH initializes on this Mac was 120 s, and most late answers
 * arrived within 2 minutes of the spawn).  Host load still scales this. */
export const DSH_INIT_TIMEOUT_MS = 120_000;

export const dshSupport = {
  ...harnessDshSupport,
  initTimeoutMs: DSH_INIT_TIMEOUT_MS,
  models: STATIC_DSH_MODELS,
  resolveModels: () => STATIC_DSH_MODELS,
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
