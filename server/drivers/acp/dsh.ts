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
  pickAuthMethod: () => null,
  classifyError: classifyDshError,
} satisfies AcpSupport;

export const DshAgentDriver = createAcpDriver(dshSupport);
