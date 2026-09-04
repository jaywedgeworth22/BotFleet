import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, ProviderErrorCode, SendTurnInput } from "../../contracts.ts";
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

/** Candidate credential files, honoring the same DSH_HOME / HOME precedence the
 * `dsh` harness itself uses.  The `.deepseek` paths cover the platform API and
 * Code CLI logins so one authenticated DeepSeek seat still lights up this rail. */
export function dshCredentialCandidates(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dshHome = env.DSH_HOME || join(home, ".dsh");
  return [
    join(dshHome, ".credentials.yaml"),
    join(home, ".deepseek", "credentials.json"),
    join(home, ".deepseek-code", "credentials", "deepseek-code.json"),
  ];
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
  // No effortLevels.  Four were advertised and nothing read `turn.effort`:
  // dshSpawnArgs emits only `--mcp` pairs and configureSession sets the
  // model, so the picker offered a control that changed nothing.
  //
  // No MCP either.  The core builds agents/composio/computer/local-computer
  // servers and hands them to session/new; the ACP server DSH actually
  // reaches ignores mcpServers, so every one of those flags promised a tool
  // that could never fire.  Flip this back the moment the backend mounts
  // them — the plumbing above it already works.
  mcpServers: false,
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
    } catch (error) {
      // A set_model that silently no-ops runs the profile's default model, not
      // the picker's selection — the exact "silently wrong model" failure
      // acp/core.ts guards against.  Fail the turn instead of pretending.
      throw new Error(
        `DeepSeek Harness did not switch to ${turn.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
