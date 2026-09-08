// Config + data dirs. One file, ~/.botfleet/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";
import { infisicalSnapshot, resolveSecretFields, stripVaultManagedValues } from "./secret-map.ts";
import { describeDsn } from "./sentry.ts";
import {
  parseConversationMode,
  STORED_CONVERSATION_MODES,
  type ConversationMode,
} from "../shared/conversation-mode.ts";
import {
  ROOM_LABEL_MAX_LENGTH,
  type CustomRoomLabels,
  type RoomTerminology,
} from "../shared/terminology.ts";

const optionalText = z.string().optional();
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 4;

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

/** Custom webhook ingress must be a real origin, not a scheme-less host. */
export function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** A secret store is reached over TLS or not at all: the machine identity's
 * client secret rides in the request body on every login, so `http://` is not
 * a lesser configuration, it is a leak. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** Both of these land in the query string of every secret-store call. */
const INFISICAL_ENVIRONMENT_PATTERN = /^[a-z0-9-]{1,64}$/;
const INFISICAL_PROJECT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** A Sentry DSN, which is more than an https URL: the public key rides in
 * the username and the project id is the last path segment.
 * `isAbsoluteHttpUrl` accepts `http://` and rejects a username outright, so
 * it cannot stand in here.  A DSN missing either half is silently inert
 * inside the SDK, which is exactly the failure this rejects at the door.
 *
 * The rule itself lives in `describeDsn` rather than here, because the door
 * check and the runtime check drifting apart is what lets a DSN the SDK
 * refuses reach `Sentry.init`, where the SDK prints the whole thing —
 * public key included — through its own `console.error`.  One grammar, one
 * place, no drift. */
export function isSentryDsn(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  return describeDsn(raw) !== null;
}

/** Sentry truncates an environment past 80 characters, and so does the
 * usage-telemetry v2 schema.  Reject rather than silently store a name the
 * operator will never see again. */
export const MAX_OBSERVABILITY_ENVIRONMENT_LENGTH = 80;

/** Per-desktop budget on a VPS.  Unlike the Local VM — the only desktop on
 * the person's own workstation — a VPS runs one desktop per bot on a single
 * shared machine, so the default is a fraction of that host rather than a
 * whole workstation's worth.  3 GiB and 2 CPUs leaves an idle XFCE desktop
 * several times its observed footprint while letting a modest box carry four
 * to six bots at once.  Operators with a bigger or smaller VPS override it. */
export const VPS_DEFAULT_MEMORY_GIB = 3;
export const VPS_DEFAULT_CPUS = 2;

/** Bounds, not preferences: below these a desktop cannot boot, and above them
 * the value is far more likely a typo than an intent. */
const VPS_MEMORY_GIB_RANGE = { min: 2, max: 64 } as const;
const VPS_CPUS_RANGE = { min: 1, max: 32 } as const;

function normalizeVpsNumber(
  value: unknown,
  field: string,
  range: { min: number; max: number },
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`vps.${field} must be a whole number between ${range.min} and ${range.max}`);
  }
  return value;
}

/** Keep the persisted VPS shape deliberately smaller than an SSH connection. */
export function normalizeVpsConfig(raw: unknown): { sshAlias?: string; memoryGib?: number; cpus?: number } {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vps must be an object containing an SSH config alias");
  }
  const record = raw as Record<string, unknown>;
  const memoryGib = normalizeVpsNumber(record.memoryGib, "memoryGib", VPS_MEMORY_GIB_RANGE);
  const cpus = normalizeVpsNumber(record.cpus, "cpus", VPS_CPUS_RANGE);
  const sizing = { ...(memoryGib === undefined ? {} : { memoryGib }), ...(cpus === undefined ? {} : { cpus }) };
  const alias = record.sshAlias;
  // Sizing is meaningful on its own: an operator may set the budget before
  // naming the host, and dropping it here would silently lose the setting.
  if (alias === undefined || alias === "") return sizing;
  if (!isValidSshAlias(alias)) {
    throw new Error("vps.sshAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore)");
  }
  return { sshAlias: alias, ...sizing };
}

const vpsConfigSchema = z.object({
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), {
    message: "must be a simple SSH config alias",
  }).optional(),
  memoryGib: z.number().int().min(VPS_MEMORY_GIB_RANGE.min).max(VPS_MEMORY_GIB_RANGE.max).optional(),
  cpus: z.number().int().min(VPS_CPUS_RANGE.min).max(VPS_CPUS_RANGE.max).optional(),
});
/** What a bot that has never been configured is given.
 *
 * This fills in for `computers: undefined` only.  A bot whose computers were
 * explicitly emptied stays off, and a bot with its own destinations keeps
 * them — the workspace default is the answer to "nobody has said", not an
 * override of anyone who has.
 *
 * Unset ships as unset, so a fresh install still behaves exactly as before:
 * reuse whatever already exists, provision nothing, and on macOS fall back to
 * host control.  Nobody gets a server they did not ask for.
 *
 * `allowedComputers` is the operator-level allowlist: every granted set is
 * filtered through it before it is mounted, so disabling "This Computer" at the
 * top of the settings page is enough to keep any bot from running on the
 * host.  Absent means "every destination is allowed", preserving the shipped
 * behavior for every existing install. */
const botDefaultsSchema = z.object({
  computers: z.array(z.enum(["cloud", "vm", "local"])).max(3).optional(),
  cloudBackend: z.enum(["box", "vps"]).optional(),
  allowedComputers: z.array(z.enum(["cloud", "vm", "local"])).max(3).optional(),
});
const roomConfigSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES),
});
const localVmConfigSchema = z.object({
  mode: z.enum(["shared", "per-bot"]).optional(),
  maxInstances: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_MAX_INSTANCES)
    .max(MAX_LOCAL_VM_MAX_INSTANCES)
    .optional(),
});
const featureConfigSchema = z.object({
  /** Experimental desktop workflow recorder. Hidden unless explicitly enabled. */
  skillRecorder: z.boolean().optional(),
  /** Show each tool run in the transcript. Off unless explicitly enabled. */
  showToolCalls: z.boolean().optional(),
  /** Summarize consecutive tool actions into an expandable live summary card. On by default. */
  summarizeToolCalls: z.boolean().optional(),
});
const instanceConfigSchema = z.object({
  driver: z.string().min(1),
  displayName: optionalText,
  accentColor: optionalText,
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  config: z.json().optional(),
});
const instanceConfigMapSchema = z.record(z.string(), instanceConfigSchema);
const appConfigSchema = z.object({
  xai: z.object({ key: optionalText, url: optionalText }).optional(),
  openaiCompat: z.object({ key: optionalText, url: optionalText }).optional(),
  /** Project key used for Sessions, catalog and agent tools. userId/sessionId
   * are non-secret local identifiers used to reuse one Composio Session. */
  // brokerUrl is read by the desktop shell only: the HTTPS origin of a
  // connected-apps broker the operator runs. There is no built-in default.
  composio: z.object({ apiKey: optionalText, userId: optionalText, sessionId: optionalText, brokerUrl: optionalText }).optional(),
  box: z.object({ token: optionalText }).optional(),
  vps: vpsConfigSchema.optional(),
  /** Optional OpenCode key; persisted write-only and passed only to its child. */
  opencodeGo: z.object({ apiKey: optionalText }).optional(),
  /** Optional DeepSeek API key — used only to display the user's account
   * balance under the engine row, never injected into the engine's process
   * environment. The user can run a deepseek CLI without this set; the
   * engine does not need the key to function. "for my user" — workspace
   * scope, not per-bot. */
  deepseek: z.object({ key: optionalText, url: optionalText }).optional(),
  /** Voice credentials and the selected voice id. `provider` picks the
   * engine: "elevenlabs" (default; needs a key) or "system" (the Mac's
   * built-in voices, no key). */
  tts: z.object({ key: optionalText, voice: optionalText, provider: z.enum(["elevenlabs", "system"]).optional() }).optional(),
  /** OpenAI key used only by the in-process avatar image generator. */
  imageGen: z.object({ key: optionalText }).optional(),
  autoUpdate: z
    .object({
      enabled: z.boolean().optional(),
      /** Wall-clock ms of the last successful automatic check.  Used by the
       * desktop shell to enforce the 6-hour throttle without consulting the
       * harness on every tick. */
      lastCheckMs: z.number().int().nonnegative().optional(),
      /** Fingerprint of the BotFleet.app bundle at the last check, so a
       * reinstall that landed an out-of-band build between checks still
       * shows up as "different from last known" on the next cycle. */
      lastAppFingerprint: z.string().optional(),
    })
    .optional(),
  /** Non-secret profile details shown in the sidebar. */
  profile: z.object({ name: optionalText, email: optionalText }).optional(),
  rooms: roomConfigSchema.optional(),
  botDefaults: botDefaultsSchema.optional(),
  ingress: z.object({
    publicUrl: z
      .string()
      .optional()
      .refine((value) => value === undefined || value === "" || isAbsoluteHttpUrl(value), {
        message: "must be an absolute http(s) URL",
      }),
    /** Whether the public URL is applied at all. Off keeps the stored URL
     * for the next time the toggle is flipped on, but the webhook receiver
     * does not advertise it. */
    enabled: z.boolean().optional(),
  }).optional(),
  localVm: localVmConfigSchema.optional(),
  qdrant: z.object({
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
    collection: z.string().optional(),
    // Cloudflare Access service token, for a recall service published
    // behind Access.  Access ignores a bearer credential and wants this
    // header pair instead, so it is a separate field, not another API key.
    accessClientId: z.string().optional(),
    accessClientSecret: z.string().optional(),
  }).optional(),
  // Usage telemetry has no built-in endpoint: whoever runs BotFleet points
  // it at their own usage monitor. Unconfigured means the stream is off.
  usage: z.object({
    ingestUrl: optionalText,
    ingestToken: optionalText,
    readToken: optionalText,
    projects: z
      .array(z.object({ slug: z.string(), match: z.array(z.string()).optional() }))
      .optional(),
  }).optional(),
  // Error and performance reporting.  The kill switch is explicit: a DSN
  // with no `enabled` flag reports.  Only a stored `false` stops it, so an
  // upgraded install never goes quiet without saying why.
  observability: z.object({
    sentryDsn: optionalText,
    enabled: z.boolean().optional(),
    environment: optionalText,
    tracesSampleRate: z.number().min(0).max(1).optional(),
    logsEnabled: z.boolean().optional(),
  }).optional(),
  // An optional external secret store.  Unconfigured is inert: with no
  // project id and machine identity, BotFleet resolves exactly as it always
  // has.  The kill switch is explicit the same way `ingress` and
  // `observability` are — absent means on once it is configured.
  infisical: z.object({
    enabled: z.boolean().optional(),
    writeThrough: z.boolean().optional(),
    siteUrl: optionalText,
    projectId: optionalText,
    environment: optionalText,
    secretPath: optionalText,
    clientId: optionalText,
    clientSecret: optionalText,
    refreshMinutes: z.number().int().min(5).max(1440).optional(),
  }).optional(),
  features: featureConfigSchema.optional(),
  conversationMode: z.enum(STORED_CONVERSATION_MODES).optional(),
  terminology: z
    .enum(["channels", "groups", "projects", "apps", "topics", "repos", "custom"])
    .optional(),
  // Only read when terminology is "custom".  Both forms are stored because
  // English plurals are not reliably "add an s" — Category/Categories.
  terminologyCustom: z
    .object({
      singular: z.string().max(ROOM_LABEL_MAX_LENGTH).optional(),
      plural: z.string().max(ROOM_LABEL_MAX_LENGTH).optional(),
    })
    .optional(),
  instances: instanceConfigMapSchema.optional(),
});
const appConfigPatchSchema = appConfigSchema.omit({ instances: true });
const jsonObjectSchema = z.record(z.string(), z.json());

export interface AppConfig {
  xai?: { key?: string; url?: string };
  openaiCompat?: { key?: string; url?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string; brokerUrl?: string };
  box?: { token?: string };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string; memoryGib?: number; cpus?: number };
  opencodeGo?: { apiKey?: string };
  deepseek?: { key?: string; url?: string };
  tts?: { key?: string; voice?: string; provider?: "elevenlabs" | "system" };
  imageGen?: { key?: string };
  autoUpdate?: {
    enabled?: boolean;
    lastCheckMs?: number;
    lastAppFingerprint?: string;
  };
  profile?: { name?: string; email?: string };
  rooms?: { turnTimeoutMinutes: number };
  botDefaults?: {
    computers?: Array<"cloud" | "vm" | "local">;
    cloudBackend?: "box" | "vps";
    /** Operator-level allowlist; an absent entry means the destination is allowed. */
    allowedComputers?: Array<"cloud" | "vm" | "local">;
  };
  ingress?: { publicUrl?: string; enabled?: boolean };
  /** Shared preserves the historical singleton. Per-bot gives every bot a
   * separate container, durable workspace, viewer and lease. */
  localVm?: { mode?: "shared" | "per-bot"; maxInstances?: number };
  /** Shared Qdrant Agent RAG vector database settings.  `accessClientId` /
   * `accessClientSecret` are a Cloudflare Access service token: a pair of
   * headers, needed when the recall service sits behind Access, where a
   * bearer credential is ignored. */
  qdrant?: {
    enabled?: boolean;
    url?: string;
    apiKey?: string;
    collection?: string;
    accessClientId?: string;
    accessClientSecret?: string;
  };
  /** Usage-monitor telemetry. `ingestUrl` is the operator's own endpoint —
   * BotFleet ships none — and `projects` classifies a turn's working
   * directory, bot name, or task title into a project slug. */
  usage?: {
    ingestUrl?: string;
    ingestToken?: string;
    readToken?: string;
    projects?: Array<{ slug: string; match?: string[] }>;
  };
  /** Error and performance reporting.  `sentryDsn` is the operator's own
   * Sentry project — BotFleet ships none.  `enabled` is the explicit kill
   * switch: absent means on, so a stored DSN reports until somebody turns
   * it off on purpose. */
  observability?: {
    sentryDsn?: string;
    enabled?: boolean;
    environment?: string;
    tracesSampleRate?: number;
    logsEnabled?: boolean;
  };
  /** The optional external secret store.  When it holds one of the names in
   * `server/secret-map.ts`, that value wins over both the environment and
   * this file; every other field keeps the ordering it always had.
   *
   * `clientId` and `clientSecret` are the machine identity that unlocks the
   * store, so they are the one pair of credentials in this file that never
   * resolves through the vault — a lock cannot hold its own key.  They are
   * read from this section or from `INFISICAL_CLIENT_ID` /
   * `INFISICAL_CLIENT_SECRET`, and nowhere else. */
  infisical?: {
    enabled?: boolean;
    writeThrough?: boolean;
    siteUrl?: string;
    projectId?: string;
    environment?: string;
    secretPath?: string;
    clientId?: string;
    clientSecret?: string;
    refreshMinutes?: number;
  };
  /** Opt-in product experiments. Every flag defaults to disabled. */
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; summarizeToolCalls?: boolean };
  /** How the roster and threads are laid out.  Absent means simple. */
  conversationMode?: ConversationMode;
  /** What this person calls a room: one of the presets, or "custom" with a
   * word of their own in `terminologyCustom`.  Absent means channels. */
  terminology?: RoomTerminology;
  /** The custom room word, singular and plural.  Read only when
   * `terminology` is "custom"; resolved for clients by `resolveRoomLabels`. */
  terminologyCustom?: CustomRoomLabels;
  instances?: InstanceConfigMap;
}
export type ConfigPatch = Omit<z.output<typeof appConfigPatchSchema>, "conversationMode"> & {
  conversationMode?: ConversationMode;
};

export function parseStoredConfig(value: JsonValue): AppConfig {
  const parsed = appConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Invalid stored configuration"));
  return {
    ...parsed.data,
    conversationMode: parsed.data.conversationMode === undefined
      ? undefined
      : parseConversationMode(parsed.data.conversationMode),
  };
}

export function parseConfigPatch(value: JsonValue): ConfigPatch {
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(schemaIssue(parsed.error, "Invalid configuration")), { status: 400 });
  }
  const { conversationMode: rawMode, ...rest } = parsed.data;
  const ingestUrl = rest.usage?.ingestUrl;
  if (ingestUrl !== undefined && ingestUrl.trim() && !isAbsoluteHttpUrl(ingestUrl)) {
    throw Object.assign(new Error("usage.ingestUrl must be an absolute http(s) URL"), { status: 400 });
  }
  // An empty or whitespace DSN is the documented "clear the stored key"
  // path, so it passes; anything else has to be a real DSN.
  const sentryDsn = rest.observability?.sentryDsn;
  if (sentryDsn !== undefined && sentryDsn.trim() && !isSentryDsn(sentryDsn)) {
    throw Object.assign(new Error("observability.sentryDsn must be a Sentry https:// DSN"), { status: 400 });
  }
  const sentryEnvironment = rest.observability?.environment;
  if (
    sentryEnvironment !== undefined &&
    sentryEnvironment.trim().length > MAX_OBSERVABILITY_ENVIRONMENT_LENGTH
  ) {
    throw Object.assign(
      new Error(
        `observability.environment must be ${MAX_OBSERVABILITY_ENVIRONMENT_LENGTH} characters or fewer`,
      ),
      { status: 400 },
    );
  }
  // The site URL, the project id, the environment and the secret path all end
  // up in the URL of every call to the secret store, so they are validated at
  // the door rather than escaped at each use.  An empty string is the
  // documented "clear this field" path for all four.
  const siteUrl = rest.infisical?.siteUrl;
  if (siteUrl !== undefined && siteUrl.trim() && !isHttpsUrl(siteUrl)) {
    throw Object.assign(new Error("infisical.siteUrl must be an absolute https:// URL"), { status: 400 });
  }
  const secretPath = rest.infisical?.secretPath;
  if (secretPath !== undefined && secretPath.trim() && !secretPath.trim().startsWith("/")) {
    throw Object.assign(new Error("infisical.secretPath must start with /"), { status: 400 });
  }
  const infisicalEnvironment = rest.infisical?.environment;
  if (
    infisicalEnvironment !== undefined &&
    infisicalEnvironment.trim() &&
    !INFISICAL_ENVIRONMENT_PATTERN.test(infisicalEnvironment.trim())
  ) {
    throw Object.assign(
      new Error("infisical.environment must be 1 to 64 lowercase letters, numbers, or dashes"),
      { status: 400 },
    );
  }
  const projectId = rest.infisical?.projectId;
  if (projectId !== undefined && projectId.trim() && !INFISICAL_PROJECT_ID_PATTERN.test(projectId.trim())) {
    throw Object.assign(
      new Error("infisical.projectId must be 1 to 64 letters, numbers, or dashes"),
      { status: 400 },
    );
  }
  return rawMode === undefined
    ? rest
    : { ...rest, conversationMode: parseConversationMode(rawMode) };
}

export function vpsSshAlias(cfg: AppConfig): string | null {
  return isValidSshAlias(cfg.vps?.sshAlias) ? cfg.vps.sshAlias : null;
}

/** The per-desktop budget on this operator's VPS.  Both accessors fall back
 * to the shared-host default, so an unconfigured VPS still gets a size that
 * lets several bots coexist on one machine. */
export function vpsMemoryGib(cfg: AppConfig): number {
  return cfg.vps?.memoryGib ?? VPS_DEFAULT_MEMORY_GIB;
}

export function vpsCpus(cfg: AppConfig): number {
  return cfg.vps?.cpus ?? VPS_DEFAULT_CPUS;
}

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

export const AUTO_UPDATE_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** True when an automatic check is allowed to run right now.  The toggle
 * gates the throttle: an off setting means no auto check ever, regardless
 * of how long it has been since the last one.  Manual "Check for Updates"
 * always bypasses this helper. */
export function autoUpdateDue(cfg: AppConfig, nowMs: number = Date.now()): boolean {
  if (cfg.autoUpdate?.enabled !== true) return false;
  const last = cfg.autoUpdate?.lastCheckMs;
  if (typeof last !== "number" || !Number.isFinite(last) || last < 0) return true;
  return nowMs - last >= AUTO_UPDATE_THROTTLE_MS;
}

export function publicIngressUrl(cfg: AppConfig): string | null {
  const raw = cfg.ingress?.publicUrl?.trim();
  return raw && isAbsoluteHttpUrl(raw) ? raw.replace(/\/+$/, "") : null;
}

/** The public URL that should actually be advertised.  Disabled
 * (`ingress.enabled === false`) keeps the stored value on disk for the next
 * time the user flips the switch, but the harness behaves as if the URL
 * were empty.  An absent flag defaults to on, so a config without the field
 * keeps working as it did before the toggle existed. */
export function publicIngressUrlEffective(cfg: AppConfig): string | null {
  if (cfg.ingress?.enabled === false) return null;
  return publicIngressUrl(cfg);
}


/** The operator's usage-monitor origin, or null when they have not set one.
 * There is deliberately no fallback endpoint — an unconfigured install sends
 * telemetry nowhere. */
export function usageIngestUrl(cfg: AppConfig): string | null {
  const raw = cfg.usage?.ingestUrl?.trim();
  return raw && isAbsoluteHttpUrl(raw) ? raw.replace(/\/+$/, "") : null;
}

/** Project classification rules, in the order they should be consulted.
 * Rules with no usable slug or no match terms are dropped. */
export function usageProjectRules(cfg: AppConfig): Array<{ slug: string; match: string[] }> {
  const rules = cfg.usage?.projects ?? [];
  return rules
    .map((rule) => ({
      slug: (rule.slug || "").trim(),
      match: (rule.match ?? []).map((term) => term.trim()).filter(Boolean),
    }))
    .filter((rule) => rule.slug.length > 0 && rule.match.length > 0);
}

/** Sentry's own default is 1.0, which is far too much traffic for a
 * long-running harness.  A fifth of turns is enough to see a latency
 * regression without paying for every span. */
export const DEFAULT_SENTRY_TRACES_SAMPLE_RATE = 0.2;

/** Everything the Sentry runtime reads out of app config, already
 * defaulted.  `dsn` is null when nothing usable is stored — the operator's
 * own project or nothing, because BotFleet ships no DSN. */
export interface ObservabilitySettings {
  dsn: string | null;
  enabled: boolean;
  environment: string;
  tracesSampleRate: number;
  logsEnabled: boolean;
}

/** The stored DSN, or null when it is absent or not a real DSN.  A stored
 * value that fails the check is treated as absent rather than handed to the
 * SDK, which would accept it and then quietly drop every event. */
export function sentryDsnConfigured(cfg: AppConfig): string | null {
  const raw = cfg.observability?.sentryDsn?.trim();
  return raw && isSentryDsn(raw) ? raw : null;
}

/** The explicit kill switch.  Absent means on, matching `ingress.enabled`:
 * an install that has never seen this setting keeps reporting, and only a
 * stored `false` stops it. */
export function observabilityEnabled(cfg: AppConfig): boolean {
  return cfg.observability?.enabled !== false;
}

/** Resolve the stored settings against their defaults.  `environment` and
 * `tracesSampleRate` fall back to the long-standing `SENTRY_ENV` and
 * `SENTRY_TRACES_SAMPLE_RATE` env names so an operator who pinned those
 * before this section existed keeps what they had; a value saved in
 * Settings wins over both.  The DSN resolves the other way round — env
 * beats config — and that ordering lives in the observability manager. */
export function observabilitySettings(cfg: AppConfig): ObservabilitySettings {
  const envRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  const rate =
    cfg.observability?.tracesSampleRate ??
    (Number.isFinite(envRate) ? envRate : DEFAULT_SENTRY_TRACES_SAMPLE_RATE);
  const environment =
    cfg.observability?.environment?.trim() ||
    (process.env.SENTRY_ENV || process.env.NODE_ENV || "production").trim() ||
    "production";
  return {
    dsn: sentryDsnConfigured(cfg),
    enabled: observabilityEnabled(cfg),
    environment: environment.slice(0, MAX_OBSERVABILITY_ENVIRONMENT_LENGTH),
    tracesSampleRate: Math.min(Math.max(rate, 0), 1),
    logsEnabled: cfg.observability?.logsEnabled !== false,
  };
}

/** Infisical's own hosted site, the environment BotFleet's fleet uses, and a
 * cadence low enough that a rotated key is picked up within a coffee break
 * without the store seeing meaningful traffic. */
export const DEFAULT_INFISICAL_SITE_URL = "https://app.infisical.com";
export const DEFAULT_INFISICAL_ENVIRONMENT = "prod";
export const DEFAULT_INFISICAL_SECRET_PATH = "/";
export const DEFAULT_INFISICAL_REFRESH_MINUTES = 15;

/** Everything the secret-store runtime reads out of app config, already
 * defaulted.  Values are used, never rendered: the only fields here a status
 * view may repeat are the site URL, the project id, the environment and the
 * path. */
export interface InfisicalSettings {
  enabled: boolean;
  writeThrough: boolean;
  siteUrl: string;
  projectId: string;
  environment: string;
  secretPath: string;
  clientId: string;
  clientSecret: string;
  refreshMinutes: number;
}

/** True when this install has actually been pointed at a secret store.  All
 * three parts are required: a project with no identity cannot be read, and an
 * identity with no project has nothing to read.  Unconfigured is inert — no
 * request is ever made, and nothing about resolution changes. */
export function infisicalConfigured(cfg: AppConfig): boolean {
  return Boolean(
    cfg.infisical?.projectId?.trim() && cfg.infisical?.clientId?.trim() && cfg.infisical?.clientSecret?.trim(),
  );
}

/** The explicit kill switch.  Absent means on once configured, matching
 * `ingress.enabled` and `observability.enabled`: connecting a store is the
 * deliberate act, and only a stored `false` undoes it. */
export function infisicalEnabled(cfg: AppConfig): boolean {
  return cfg.infisical?.enabled !== false;
}

/** Resolve the stored settings against their defaults.  Write-through
 * defaults to off: with it off a Settings save of a name the store manages is
 * refused outright, which is honest, rather than accepted and then reverted by
 * the next refresh, which is not. */
export function infisicalSettings(cfg: AppConfig): InfisicalSettings {
  const stored = cfg.infisical ?? {};
  const refresh = stored.refreshMinutes;
  return {
    enabled: infisicalEnabled(cfg),
    writeThrough: stored.writeThrough === true,
    siteUrl: (stored.siteUrl?.trim() || DEFAULT_INFISICAL_SITE_URL).replace(/\/+$/, ""),
    projectId: stored.projectId?.trim() ?? "",
    environment: stored.environment?.trim() || DEFAULT_INFISICAL_ENVIRONMENT,
    secretPath: stored.secretPath?.trim() || DEFAULT_INFISICAL_SECRET_PATH,
    clientId: stored.clientId?.trim() ?? "",
    clientSecret: stored.clientSecret ?? "",
    refreshMinutes:
      refresh !== undefined && Number.isFinite(refresh)
        ? Math.min(Math.max(Math.trunc(refresh), 5), 1440)
        : DEFAULT_INFISICAL_REFRESH_MINUTES,
  };
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

/** The destinations any bot is allowed to run on.  An absent allowlist means
 * "every destination is allowed", which is the shipped default and the
 * behavior an upgraded install sees until the operator narrows it.  An empty
 * allowlist is a deliberate, persisted "no bot may run on any desktop here". */
export function allowedBotComputers(cfg: AppConfig): Array<"cloud" | "vm" | "local"> | null {
  const list = cfg.botDefaults?.allowedComputers;
  if (list === undefined) return null;
  // De-duplicate while keeping the order the operator chose.
  return [...new Set(list)];
}

/** Filter a granted set against the operator allowlist.  An absent allowlist
 * passes everything through.  An entry blocked by the allowlist is dropped;
 * the result keeps the order of the input. */
export function filterAllowedComputers<T extends "cloud" | "vm" | "local">(
  granted: readonly T[],
  allowed: Array<"cloud" | "vm" | "local"> | null,
): T[] {
  if (allowed === null) return [...granted];
  const set = new Set(allowed);
  return granted.filter((entry) => set.has(entry));
}

export function skillRecorderEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillRecorder === true;
}

/** Tool steps in the transcript.  On by default.
 *
 * They used to be off, and the reason was sound at the time: a chip carried
 * a bare tool name, so a hundred of them said only "work happened".  A step
 * now says what it read, what it ran and how long it took (see
 * `shared/tool-activity.ts`), which is the difference between noise and the
 * record of a turn.  Settings still turns them off.
 *
 * Kept in step with `src/lib/feature-flags.ts`: this is the value the
 * clients are handed, so a default that disagreed with theirs would decide
 * the question here and make the other one dead code. */
export function showToolCallsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.showToolCalls !== false;
}

export function summarizeToolCallsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.summarizeToolCalls !== false;
}

// OMB_DATA_DIR isolates test/soak rigs from the user's real fleet.
export const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".botfleet");
const LEGACY_HOME_DATA_DIRS = [".openmausbot", ".opengrokbot"] as const;
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

function migrateLegacyHomeDir(current: string, legacyNames: readonly string[]): void {
  if (existsSync(current)) return;
  for (const name of legacyNames) {
    const legacy = join(homedir(), name);
    if (!existsSync(legacy)) continue;
    try {
      renameSync(legacy, current);
      return;
    } catch {
      /* cross-device or busy — try the next predecessor */
    }
  }
}

export function ensureDirs() {
  // one-time migration from the pre-rename data dirs — bots, transcripts,
  // config and keys all carry over. Skip when tests isolate via OMB_DATA_DIR.
  if (!process.env.OMB_DATA_DIR) migrateLegacyHomeDir(DATA_DIR, LEGACY_HOME_DATA_DIRS);
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = parseStoredConfig(parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")));
  } catch {
    /* first run — env fallbacks below */
  }
  // these secrets OS-encrypted and hands them to this process as env at
  // spawn, leaving config.json without the plaintext field — so the file
  // value is the dev-mode (no desktop shell) fallback, not the primary.
  // Anything that saves a credential mid-session must keep process.env in
  // step (syncCredentialEnv below), or the value injected at boot would
  // shadow the save until the next launch.
  //
  // This overlay is unchanged, and deliberately so.  `server/secret-map.ts`
  // sits ABOVE it rather than replacing it: for the names an external secret
  // store holds, the store wins; for every other name the ordering below —
  // env over file here, file over env in the per-call readers — is exactly
  // what it has always been.
  cfg.xai = { ...cfg.xai };
  if (process.env.XAI_API_KEY !== undefined) cfg.xai.key = process.env.XAI_API_KEY;
  cfg.openaiCompat = { ...cfg.openaiCompat };
  if (process.env.OPENAI_COMPAT_API_KEY !== undefined) cfg.openaiCompat.key = process.env.OPENAI_COMPAT_API_KEY;
  if (process.env.OPENAI_COMPAT_URL !== undefined) cfg.openaiCompat.url = process.env.OPENAI_COMPAT_URL;
  cfg.composio = { ...cfg.composio };
  if (process.env.COMPOSIO_API_KEY !== undefined) cfg.composio.apiKey = process.env.COMPOSIO_API_KEY;
  cfg.box = { ...cfg.box };
  if (process.env.BOX_TOKEN !== undefined) cfg.box.token = process.env.BOX_TOKEN;
  cfg.opencodeGo = { ...cfg.opencodeGo };
  if (process.env.OPENCODE_API_KEY !== undefined) cfg.opencodeGo.apiKey = process.env.OPENCODE_API_KEY;
  cfg.tts = { ...cfg.tts };
  if (process.env.OMB_TTS_KEY !== undefined) cfg.tts.key = process.env.OMB_TTS_KEY;
  cfg.imageGen = { ...cfg.imageGen };
  if (process.env.OMB_OPENAI_IMAGE_KEY !== undefined) cfg.imageGen.key = process.env.OMB_OPENAI_IMAGE_KEY;
  // The secret store's own machine identity, which is the one credential pair
  // that cannot come out of the store.  The alias names mirror the pair the
  // iOS ship workflow already uses, so a single identity works in CI, on a
  // headless machine, and in Settings without being renamed on the way.
  // First defined wins, and env beats the file here for the same reason it
  // does above: the desktop shell injects it at spawn.
  cfg.infisical = { ...cfg.infisical };
  const identity: Array<[field: "clientId" | "clientSecret" | "projectId" | "siteUrl" | "environment" | "secretPath", names: string[]]> = [
    ["clientId", ["INFISICAL_CLIENT_ID", "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"]],
    ["clientSecret", ["INFISICAL_CLIENT_SECRET", "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"]],
    ["projectId", ["INFISICAL_PROJECT_ID"]],
    ["siteUrl", ["INFISICAL_SITE_URL", "INFISICAL_DOMAIN"]],
    ["environment", ["INFISICAL_ENVIRONMENT"]],
    ["secretPath", ["INFISICAL_SECRET_PATH"]],
  ];
  for (const [field, names] of identity) {
    const name = names.find((candidate) => process.env[candidate] !== undefined);
    if (name !== undefined) cfg.infisical[field] = process.env[name];
  }
  // One resolution point, last: whatever the store holds for a mapped name
  // overwrites what env and file just agreed on, and the provenance of every
  // mapped field is recorded for the Secrets card.  With no store configured
  // the snapshot is null and this is a no-op.
  resolveSecretFields(cfg, process.env, infisicalSnapshot());
  return cfg;
}

/** After saveConfig() writes a credential, the running process's env must
 * follow the newest value — loadConfig() prefers env, so the secret injected
 * at boot would otherwise shadow the save until relaunch: the UI would show
 * "saved" while every turn still used the old key. An empty string means the
 * user cleared the credential, so the var is dropped and the (now empty)
 * file value is authoritative again. Fields absent from the patch are
 * untouched. */
export function syncCredentialEnv(patch: Partial<AppConfig>): void {
  const secrets: Array<[value: string | undefined, name: string]> = [
    [patch.xai?.key, "XAI_API_KEY"],
    [patch.openaiCompat?.key, "OPENAI_COMPAT_API_KEY"],
    [patch.composio?.apiKey, "COMPOSIO_API_KEY"],
    [patch.box?.token, "BOX_TOKEN"],
    [patch.opencodeGo?.apiKey, "OPENCODE_API_KEY"],
    [patch.tts?.key, "OMB_TTS_KEY"],
    [patch.imageGen?.key, "OMB_OPENAI_IMAGE_KEY"],
    // Without this, an identity injected by a plist or a shell export would
    // keep shadowing the one just saved in Settings, and the card would report
    // a store the operator has already replaced.
    [patch.infisical?.clientSecret, "INFISICAL_CLIENT_SECRET"],
  ];
  for (const [value, name] of secrets) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  if (patch.openaiCompat?.url !== undefined) {
    if (patch.openaiCompat.url) process.env["OPENAI_COMPAT_URL"] = patch.openaiCompat.url;
    else delete process.env["OPENAI_COMPAT_URL"];
  }
  if (patch.infisical?.clientId !== undefined) {
    if (patch.infisical.clientId) process.env["INFISICAL_CLIENT_ID"] = patch.infisical.clientId;
    else delete process.env["INFISICAL_CLIENT_ID"];
  }
}

/** Env names of every workspace credential this process may be holding —
 * injected at boot by the desktop shell or exported by a developer. Spawned
 * engine CLIs must never inherit them: the one driver that consumes a given
 * secret receives it through instanceConfigs() narrowing, and to every other
 * child these are someone else's keys riding along in `...process.env`. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_URL",
  // The secret store's machine identity.  It reads every name in the project,
  // so of everything on this list it is the one that must never ride into a
  // spawned engine CLI.  `electron/diagnostics.mjs` mirrors these two in this
  // exact order.
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
] as const;

/** Drop every workspace credential from a child-process env (in place). */
export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
}

/** Env names a provider CLI might read as its own billing identity. A spawned
 * engine keeps only what its driver explicitly allows: a foreign key riding
 * along in `...process.env` must not flip a subscription CLI onto
 * pay-as-you-go billing the user never granted. */
export const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Merge a partial config into ~/.botfleet/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: JsonObject = {};
  try {
    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (parsed.success) disk = parsed.data;
  } catch {
    /* first write */
  }
  const checkedPatch = appConfigSchema.partial().parse(patch);
  // Last line of defence, on the parsed COPY so a caller's own object is
  // never mutated: whatever the store is currently canonical for does not go
  // to disk in cleartext.  A route that hands us the live config object --
  // instead of the section it owns -- is handing us every value
  // `resolveSecretFields` just wrote into it, and persisting those would put
  // the vault's contents in `~/.botfleet/config.json` for anything running as
  // this user, Time Machine, and every backup to read.  An empty string is
  // left alone: that is the write-through path's deliberate tombstone.
  // SAFETY: `checkedPatch` is `appConfigSchema.partial()`'s output — the same
  // sections `AppConfig` declares, differing only in zod's wider literal
  // unions, which the section-and-path walk below never reads.
  const strippedFromDisk = stripVaultManagedValues(checkedPatch as Partial<AppConfig>);
  if (strippedFromDisk.length > 0) {
    // Field ids only, never values -- and worth saying out loud, because it
    // means a caller tried to persist something the store owns.
    console.warn(`[secrets] not persisting vault-managed values: ${strippedFromDisk.join(", ")}`);
  }
  // usage, qdrant and observability are operator-supplied endpoints (Usage
  // Monitor telemetry, Bot RAG, Sentry).  They must merge like the other
  // sections: a URL-only patch must not wipe a stored token, and a
  // toggle-only patch must not wipe a stored DSN.  Omitting them from this
  // list meant PATCH /api/config { usage } never wrote
  // ~/.botfleet/config.json, so Settings reloaded empty fields.
  //
  // `deepseek` was missing for the same reason and had the same bug: the key
  // is in the schema, in the API Keys panel and in the tombstone list, but a
  // save of it never reached disk.  `infisical` is here from the start so the
  // machine identity does not repeat it a third time.
  for (const key of ["xai", "openaiCompat", "composio", "box", "opencodeGo", "deepseek", "tts", "imageGen", "profile", "rooms", "localVm", "features", "autoUpdate", "ingress", "usage", "qdrant", "observability", "infisical", "botDefaults"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    Object.assign(merged, section);
    disk[key] = merged;
  }
  if (checkedPatch.vps !== undefined) disk.vps = normalizeVpsConfig(checkedPatch.vps);
  if (checkedPatch.conversationMode !== undefined) disk.conversationMode = checkedPatch.conversationMode;
  if (checkedPatch.terminology !== undefined) disk.terminology = checkedPatch.terminology;
  if (checkedPatch.terminologyCustom !== undefined) disk.terminologyCustom = checkedPatch.terminologyCustom;
  if (checkedPatch.instances) {
    const currentInstances = jsonObjectSchema.safeParse(disk.instances);
    const diskInstances: JsonObject = currentInstances.success ? currentInstances.data : {};
    for (const [instanceId, entry] of Object.entries(checkedPatch.instances)) {
      const current = jsonObjectSchema.safeParse(diskInstances[instanceId]);
      const merged: JsonObject = current.success ? { ...current.data } : {};
      Object.assign(merged, entry);
      diskInstances[instanceId] = merged;
    }
    disk.instances = diskInstances;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
}

/** Set one instance's `config.cli` ("" clears the override back to the
 * driver default). Creating the instance entry is fine — a config-less
 * entry rides driver.defaultConfig(). Returns false for unknown instances
 * when the fleet is explicitly configured. The returned map must stay
 * PERSISTABLE: instanceConfigs() injects credential env into consuming
 * drivers' entries for the live fleet, so those injected keys are stripped
 * back out before the map is returned — otherwise saving an override would
 * copy xai/box/opencodeGo secrets into the instances section of
 * config.json. */
export function patchInstanceConfig(
  cfg: AppConfig,
  instanceId: string,
  patch: { cli?: string; fullAuto?: boolean; enabled?: boolean },
): InstanceCliUpdate {
  const next: AppConfig = structuredClone(cfg);
  const map = instanceConfigs(next);
  // hasOwn, not truthiness: map is a plain object literal, so
  // map["__proto__"] resolves to Object.prototype — truthy — and the
  // assignment below would poison EVERY object in the process (instanceId
  // comes off the URL, where `__proto__` passes the route's [\w.-]+ regex)
  if (!Object.hasOwn(map, instanceId)) return { ok: false, config: cfg };
  const entry = map[instanceId];

  const currentConfig = jsonObjectSchema.safeParse(entry.config);
  const nextConfig: JsonObject = currentConfig.success ? { ...currentConfig.data } : {};

  if (patch.cli !== undefined) {
    const cliKey = patch.cli.trim();
    if (cliKey) {
      nextConfig.cli = cliKey;
    } else {
      delete nextConfig.cli;
    }
  }

  if (patch.fullAuto !== undefined) {
    if (patch.fullAuto) {
      nextConfig.fullAuto = true;
    } else {
      delete nextConfig.fullAuto;
    }
  }

  // `enabled` lives on the entry envelope, not in `entry.config` — same shape
  // the registry reads in ProviderRegistry.load. Re-enabling clears the flag
  // entirely so a true re-enable and a fresh install both round-trip as the
  // same on-disk form.
  if (patch.enabled !== undefined) {
    if (patch.enabled) {
      delete entry.enabled;
    } else {
      entry.enabled = false;
    }
  }

  entry.config = Object.keys(nextConfig).length ? nextConfig : undefined;
  for (const e of Object.values(map)) {
    if (!e.environment) continue;
    const injected = injectedEnvironment(next, e.driver);
    for (const [k, v] of Object.entries(e.environment)) {
      if (injected.get(k) === v) delete e.environment[k];
    }
    if (!Object.keys(e.environment).length) delete e.environment;
  }
  next.instances = map;
  return { ok: true, config: next };
}

interface InstanceCliUpdate {
  ok: boolean;
  config: AppConfig;
}

/** The credential env instanceConfigs() injects for one driver — shared with
 * patchInstanceConfig() so the inject rule and the strip rule cannot drift apart.
 * Each secret goes only to the driver that actually reads it: the API-key
 * Grok driver reads XAI_API_KEY, the Computer driver reads BOX_TOKEN, and
 * OpenCode reads OPENCODE_API_KEY. Every other engine brings its own
 * login, so handing it a key it never uses would only put that key in the
 * environment of an unrelated child process. */
function injectedEnvironment(cfg: AppConfig, driver: string): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  if (driver === "openai-compat" && cfg.openaiCompat?.key)
    environment.set("OPENAI_COMPAT_API_KEY", cfg.openaiCompat.key);
  if (driver === "openai-compat" && cfg.openaiCompat?.url)
    environment.set("OPENAI_COMPAT_URL", cfg.openaiCompat.url);
  if (driver === "boxAgent" && cfg.box?.token) environment.set("BOX_TOKEN", cfg.box.token);
  if (driver === "opencodeGo" && cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  return environment;
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars — but only into the
// driver that consumes each key (injectedEnvironment above).
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  //
  // Google models exclusively ride `antigravityAgent` (the `agy` CLI).
  // Gemini direct CLI and API drivers have been retired in favor of the
  // mature, fully integrated Antigravity driver.
  const DEFAULT_FLEET: InstanceConfigMap = {
    grok: { driver: "grokAgent" },
    dsh: { driver: "dshAgent" },
    droid: { driver: "droidAgent" },
    cursor: { driver: "cursorAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    antigravity: { driver: "antigravityAgent" },
    minimax: { driver: "minimax" },
    opencodeGo: { driver: "opencodeGo" },
    computer: { driver: "boxAgent" },
    openaiCompat: { driver: "openai-compat" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  };
  const CUSTOM_ONLY = {
    kimi: { driver: "kimiAgent" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  } as const;
  // New default-fleet engines that existing product configs would otherwise
  // never see. Custom-only engines stay in CUSTOM_ONLY so a one-off test map
  // is not expanded, matching the claude/grok/codex product-fleet probe.
  const PRODUCT_FLEET_ADDITIONS = {
    cursor: { driver: "cursorAgent" },
    openaiCompat: { driver: "openai-compat" },
    dsh: { driver: "dshAgent" },
    minimax: { driver: "minimax" },
    ...CUSTOM_ONLY,
  } as const;
  const configured = cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : null;
  const map: InstanceConfigMap = configured ? { ...configured } : { ...DEFAULT_FLEET };
  // Product fleets pick up newly shipped engines. A one-off test/shadow map
  // (no claude/grok/codex) is left exactly as written.
  if (
    configured &&
    (Object.hasOwn(configured, "claude") || Object.hasOwn(configured, "grok") || Object.hasOwn(configured, "codex"))
  ) {
    for (const [id, entry] of Object.entries(PRODUCT_FLEET_ADDITIONS)) {
      if (!Object.hasOwn(map, id)) map[id] = { ...entry };
    }
  }
  for (const [id, sourceEntry] of Object.entries(map)) {
    // instanceConfigs() builds a transient runtime map. Never mutate the
    // caller's persisted entries while injecting workspace defaults: doing so
    // would turn the first workspace URL into a stale per-instance override.
    const entry = { ...sourceEntry };
    map[id] = entry;
    const environment = { ...entry.environment };
    for (const [key, value] of injectedEnvironment(cfg, entry.driver)) environment[key] = value;
    entry.environment = environment;
    // The driver URL is configuration, not a credential. Environment is
    // intentionally not consulted by ProviderRegistry when it decodes a
    // driver's config, so carry the workspace default into the transient
    // instance map while preserving a per-instance override.
    if (entry.driver === "openai-compat" && cfg.openaiCompat?.url) {
      const raw = entry.config;
      if (raw === undefined) {
        entry.config = { url: cfg.openaiCompat.url };
      } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const current = raw as Record<string, unknown>;
        if (typeof current.url !== "string" || !current.url.trim()) {
          entry.config = { ...current, url: cfg.openaiCompat.url };
        }
      }
    }
  }
  return map;
}
