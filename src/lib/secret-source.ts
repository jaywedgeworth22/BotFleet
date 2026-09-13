/** Client-side helpers for the Secrets card and the per-field provenance
 * badges: where a mapped credential came from, what the Secret Store pill
 * says, and the settings patch the card saves.
 *
 * `SecretSource` mirrors `server/secret-map.ts`'s own union — duplicated
 * rather than imported, the same way `observability-status.ts` duplicates
 * `ObservabilityStatusView` instead of importing the server module: the
 * renderer cannot pull in a server file (it would drag `node:crypto` into
 * the browser bundle), so the shared shape is a few lines of copy the tests
 * below keep honest, not a shared import. */
export type SecretSource = "infisical" | "env" | "file" | "none";

/** Sentence case, for the "Value" column of the provenance table.  A field
 * this install has never resolved from anywhere reports "Not set", which is
 * a fourth, distinct state from "This computer" — the latter means a value
 * exists and it is the file's own copy. */
export function secretSourceLabel(source: SecretSource | undefined): "Infisical" | "Environment" | "This computer" | "Not set" {
  if (source === "infisical") return "Infisical";
  if (source === "env") return "Environment";
  if (source === "file") return "This computer";
  return "Not set";
}

export type SecretSourceTone = "managed" | "environment" | "local" | "unset";

/** The visual weight for each source — `managed` is the one state that
 * changes what the operator can do with the field (the input disables and
 * the save path can refuse), so it is the only tone that reads as an accent
 * rather than a neutral fact. */
export function secretSourceTone(source: SecretSource | undefined): SecretSourceTone {
  if (source === "infisical") return "managed";
  if (source === "env") return "environment";
  if (source === "file") return "local";
  return "unset";
}

/** What the provenance chip actually says.
 *
 * `elsewhere` is a path the SERVER found holding this value outside
 * everything the secret map can see — today only `~/.mmx/config.json`, which
 * the MiniMax driver reads on its own. It is reported only when no source
 * the map does see has a value, so it can never claim credit for a key that
 * is really coming from the environment or the vault. Naming the file beats
 * "Not set" next to an engine whose turns visibly work. */
export interface SecretSourceDisplay {
  label: string;
  tone: SecretSourceTone;
  /** True when `label` is a path outside BotFleet rather than a managed
   * source — the chip renders it verbatim instead of upper-casing it. */
  external: boolean;
}

export function secretSourceDisplay(
  source: SecretSource | undefined,
  elsewhere?: string | null,
): SecretSourceDisplay {
  if (elsewhere && (source === undefined || source === "none")) {
    return { label: elsewhere, tone: "local", external: true };
  }
  return { label: secretSourceLabel(source), tone: secretSourceTone(source), external: false };
}

export type InfisicalPillTone = "active" | "off" | "error" | "waiting";

export interface InfisicalPillLabel {
  label: "Connected" | "Turned off" | "Not configured" | "Error" | "Stale" | "Waiting";
  tone: InfisicalPillTone;
}

/** The Secret Store card's status pill.  Modelled on `observabilityBadge`
 * (`observability-status.ts`) and `telemetryBadge`: a live error always wins,
 * then "no status yet", then the configured/enabled/stale ladder. `stale`
 * is the state a timer refresh failure leaves behind — the previous
 * snapshot is still in effect, but it may be behind the vault by now, which
 * is worth a distinct label from a clean "Connected". */
export function infisicalStatusLabel(
  status: { configured: boolean; enabled: boolean; lastError?: string | null; stale?: boolean } | null,
  fetchError?: string | null,
): InfisicalPillLabel {
  const lastError = fetchError || status?.lastError || null;
  if (lastError) return { label: "Error", tone: "error" };
  if (!status) return { label: "Waiting", tone: "waiting" };
  if (!status.configured) return { label: "Not configured", tone: "off" };
  if (!status.enabled) return { label: "Turned off", tone: "off" };
  if (status.stale) return { label: "Stale", tone: "waiting" };
  return { label: "Connected", tone: "active" };
}

/** Where the Use Infisical switch starts, given `GET /api/config`'s block.
 *
 * The wire's `infisical.enabled` is the server's `configured && enabled`, so
 * an install with no identity saved yet reports `false` — the absence of a
 * store, not an operator's decision.  Seeding the switch straight from it
 * renders the kill switch OFF on a fresh install, and because the patch
 * builder always sends `enabled`, the operator's very first Save persists a
 * hard `enabled: false`: the store authenticates, Test Connection passes, and
 * nothing is ever applied.  The documented default is on once configured
 * (`infisicalEnabled` in server/config.ts), so that is what an install with
 * nothing configured shows. */
export function infisicalSwitchDefault(
  config: { configured?: boolean; enabled?: boolean } | null | undefined,
): boolean {
  if (!config?.configured) return true;
  return config.enabled !== false;
}

const INFISICAL_ENVIRONMENT_PATTERN = /^[a-z0-9-]{1,64}$/;
const INFISICAL_PROJECT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** What the Secret Store card sends on Save.  `siteUrl`, `projectId`,
 * `environment` and `secretPath` are always present — an empty string is the
 * documented "clear this" path `server/config.ts`'s `parseConfigPatch` reads
 * for all four, and the form always starts them populated from the last
 * fetched status, so resending them is just an echo unless the operator
 * deliberately blanked one.
 *
 * `clientId` and `clientSecret` are different: `GET /api/infisical/status`
 * never echoes either value back (only `hasClientId` / `hasClientSecret`),
 * so an untouched, blank field carries no signal that it should be cleared —
 * sending `""` would silently wipe a saved identity the moment the operator
 * changed an unrelated field like Refresh Minutes.  Both are therefore
 * omitted rather than sent empty, the same rule `usage-config.ts` applies to
 * its tokens: a blank field means "leave it alone", and there is
 * deliberately no way to clear either one from this card short of turning
 * Use Infisical off. */
export type InfisicalConfigPatch = {
  enabled: boolean;
  writeThrough: boolean;
  siteUrl: string;
  projectId: string;
  environment: string;
  secretPath: string;
  clientId?: string;
  clientSecret?: string;
  refreshMinutes: number;
};

export function buildInfisicalConfigPatch(input: {
  enabled: boolean;
  writeThrough: boolean;
  siteUrl: string;
  projectId: string;
  environment: string;
  secretPath: string;
  clientId: string;
  clientSecret: string;
  refreshMinutes: number;
}): { ok: true; patch: InfisicalConfigPatch } | { ok: false; error: string } {
  const siteUrl = input.siteUrl.trim();
  if (siteUrl && !isAbsoluteHttpsUrl(siteUrl)) {
    return { ok: false, error: "Site URL must be an absolute https:// URL." };
  }
  const secretPath = input.secretPath.trim();
  if (secretPath && !secretPath.startsWith("/")) {
    return { ok: false, error: "Secret Path must start with /." };
  }
  const environment = input.environment.trim();
  if (environment && !INFISICAL_ENVIRONMENT_PATTERN.test(environment)) {
    return { ok: false, error: "Environment must be 1 to 64 lowercase letters, numbers, or dashes." };
  }
  const projectId = input.projectId.trim();
  if (projectId && !INFISICAL_PROJECT_ID_PATTERN.test(projectId)) {
    return { ok: false, error: "Project ID must be 1 to 64 letters, numbers, or dashes." };
  }
  if (!Number.isFinite(input.refreshMinutes) || input.refreshMinutes < 5 || input.refreshMinutes > 1440) {
    return { ok: false, error: "Refresh Minutes must be between 5 and 1440." };
  }

  const patch: InfisicalConfigPatch = {
    enabled: input.enabled,
    writeThrough: input.writeThrough,
    siteUrl,
    projectId,
    environment,
    secretPath,
    refreshMinutes: Math.trunc(input.refreshMinutes),
  };
  const clientId = input.clientId.trim();
  if (clientId) patch.clientId = clientId;
  const clientSecret = input.clientSecret.trim();
  if (clientSecret) patch.clientSecret = clientSecret;
  return { ok: true, patch };
}

export interface InfisicalPatchSplit {
  /** Everything that travels in the `PATCH /api/config` body.  Carries the
   * client secret only when there is no desktop bridge to carry it instead. */
  configPatch: InfisicalConfigPatch;
  /** The client secret to hand to `window.ogb.setCredential`, or `null` when
   * this save has no secret in it or there is no bridge. */
  bridgeSecret: string | null;
}

/** Split a built patch into the part that goes over plain HTTP and the part
 * that goes through Electron's OS-encrypted credential store.
 *
 * Every other credential card in this app already does this — `ApiKeys.tsx`
 * and `BotProfileAvatarCard.tsx` call `window.ogb.setCredential` when the
 * bridge exists and fall back to `/api/config` only outside the desktop
 * shell.  The Secret Store card sending its client secret straight to
 * `/api/config` was the odd one out, and the request carries no
 * `?secretStorage=external`, so the server's normal branch writes
 * `infisical.clientSecret` into plaintext `~/.botfleet/config.json` and only
 * migrates it into `credentials.bin` on some later launch.  The machine
 * identity is the one credential that can read every name in the project, so
 * it is the last one that should be sitting in a plaintext file.
 *
 * The non-secret half still goes over PATCH: site URL, project id,
 * environment, secret path, client id, the two switches and the cadence are
 * plain settings, and `credential:set` only knows how to carry one field.
 * Order matters at the call site — the PATCH lands first so the bridge's own
 * save, which is what triggers the server's re-login, runs with the new
 * project and environment already in place. */
export function splitInfisicalPatch(patch: InfisicalConfigPatch, hasBridge: boolean): InfisicalPatchSplit {
  if (!hasBridge || !patch.clientSecret) {
    return { configPatch: patch, bridgeSecret: null };
  }
  const { clientSecret, ...rest } = patch;
  return { configPatch: rest, bridgeSecret: clientSecret };
}
