import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EffortLevel, ModelCatalog, ProviderErrorCode, SendTurnInput } from "../../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

/** Current DSH exposes its standard ACP v1 server as a profile.  Integrations
 * belong in session/new.mcpServers; duplicating them as private CLI flags
 * changes quoting and bypasses ACP's typed transport validation. */
export function dshSpawnArgs(_config: AcpConfig, _turn: Pick<SendTurnInput, "integrations">): string[] {
  return ["--profile", "acp"];
}

export const DSH_MINIMUM_ACP_VERSION = "0.1.5-rc.1";

type ParsedVersion = { core: [number, number, number]; prerelease: Array<number | string> };

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".").map((part) => /^\d+$/u.test(part) ? Number(part) : part) ?? [],
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a.localeCompare(b);
  }
  return 0;
}

/** The native ACP profile first shipped in 0.1.5-rc.1.  Custom wrappers are
 * deliberately outside this stock-binary gate. */
export function dshVersionCompatibilityReason(version: string, cli = "dsh"): string | null {
  if (cli !== "dsh") return null;
  const current = parseVersion(version);
  const minimum = parseVersion(DSH_MINIMUM_ACP_VERSION)!;
  if (current && compareVersions(current, minimum) >= 0) return null;
  return `DeepSeek Harness ${DSH_MINIMUM_ACP_VERSION} or newer is required for native ACP; update with npm install -g @deepseek-ai/dsh@latest`;
}

const DSH_EFFORT_LEVELS = ["none", "high", "max"] as const satisfies readonly EffortLevel[];

export const DSH_PROVIDER_ID = "deepseek-official";

/** DSH deliberately makes model values opaque because one catalog may expose
 * the same model id through several providers. */
export function dshModelOptionValue(model: string): string {
  return JSON.stringify([DSH_PROVIDER_ID, model]);
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

/** The harness's own current models.  The vision variant is deliberately
 * absent: `images: false` disables image attachment for the whole engine, so
 * shipping a vision model here offered a capability the composer refused. */
export const STATIC_DSH_MODELS: ModelCatalog = {
  default: "deepseek-v4-flash",
  options: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  ],
};

/** Candidate credential file, honoring the same DSH_HOME / HOME precedence the
 * published `dsh` harness uses.  Other DeepSeek clients have separate stores
 * that do not authenticate this CLI. */
export function dshCredentialCandidates(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dshHome = env.DSH_HOME || join(home, ".dsh");
  return [join(dshHome, ".credentials.yaml")];
}

/** Map DSH/DeepSeek failure text onto the canonical provider-error codes so the
 * fallback chain (`server/model-fallback.ts`) treats DSH quota and auth failures
 * like every other engine instead of as a generic rpc_error. */
export function classifyDshError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (/unauthoriz|unauthenticated|not signed in|not logged in|invalid api key|invalid_credentials|authentication required|auth.*(fail|missing|required)/.test(blob)) {
    return "invalid_credentials";
  }
  if (/inactive subscription|subscription.*(expired|inactive)|upgrade your (plan|subscription)/.test(blob)) {
    return "inactive_subscription";
  }
  if (/quota|rate.?limit|too many requests|insufficient.?balance|out of credits|credits? exhausted|\b429\b|\b402\b/.test(blob)) {
    return "quota_or_region_restriction";
  }
  if (/overloaded|capacity|service unavailable|bad gateway|upstream|\b502\b|\b503\b|\b504\b/.test(blob)) {
    return "upstream_outage";
  }
  if (/unknown model|model not found|no such model|invalid model/.test(blob)) {
    return "model_catalog_outage";
  }
  return undefined;
}

const support: AcpSupport = {
  driverKind: "dshAgent",
  displayName: "DeepSeek Harness",
  // the vision model below is the one option that CAN take an image, and the
  // flag gates the composer for the whole engine — so it stays off until the
  // catalog can answer per model rather than per engine
  images: false,
  models: STATIC_DSH_MODELS,
  resolveModels: () => STATIC_DSH_MODELS,
  effortLevels: DSH_EFFORT_LEVELS,
  mcpServers: true,
  defaultCli: "dsh",
  nativeSource: "dsh.acp",
  loginNote: "DSH CLI auth missing — add ~/.dsh/.credentials.yaml",

  install: {
    command: {
      darwin: "npm install -g @deepseek-ai/dsh@latest",
      linux: "npm install -g @deepseek-ai/dsh@latest",
      win32: "npm install -g @deepseek-ai/dsh@latest",
    },
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/acp-app",
    needsNode: true,
  },

  spawnArgs: dshSpawnArgs,
  resumeMethod: "session/resume",
  selectModel: { configId: "model", valueForModel: dshModelOptionValue },
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
    if (confirmed !== requested) {
      throw new Error(
        `DeepSeek Harness did not switch reasoning effort to ${requested} (still ${String(confirmed ?? "unknown")})`,
      );
    }
  },

  transformEnv: (_env) => {},

  classifyError: classifyDshError,

  credentialEnv: ["DEEPSEEK_API_KEY", "DSH_HOME", "DSH_RUNTIME_ROOT", "DSH_PERMISSION_MODE"],

  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) =>
    dshCredentialCandidates(env).some(existsSync) || Boolean(env.DEEPSEEK_API_KEY),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const DshAgentDriver = createAcpDriver(support);
