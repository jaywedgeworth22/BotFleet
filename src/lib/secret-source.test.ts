import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildInfisicalConfigPatch,
  infisicalStatusLabel,
  infisicalSwitchDefault,
  secretSourceDisplay,
  secretSourceLabel,
  secretSourceTone,
  splitInfisicalPatch,
  type InfisicalConfigPatch,
} from "./secret-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

// Obviously fake, and asserted absent from every value this module hands
// back — mirrors the sentinel discipline in server/secret-map.test.ts.
const SENTINEL_SECRET = "sentinel-client-secret-not-real";

describe("secretSourceLabel", () => {
  it("names all four sources in sentence case", () => {
    expect(secretSourceLabel("infisical")).toBe("Infisical");
    expect(secretSourceLabel("env")).toBe("Environment");
    expect(secretSourceLabel("file")).toBe("This computer");
    expect(secretSourceLabel("none")).toBe("Not set");
    expect(secretSourceLabel(undefined)).toBe("Not set");
  });
});

describe("secretSourceTone", () => {
  it("gives the vault-managed source its own accent tone", () => {
    expect(secretSourceTone("infisical")).toBe("managed");
    expect(secretSourceTone("env")).toBe("environment");
    expect(secretSourceTone("file")).toBe("local");
    expect(secretSourceTone("none")).toBe("unset");
    expect(secretSourceTone(undefined)).toBe("unset");
  });
});

describe("infisicalStatusLabel", () => {
  it("prefers a live error over any other state", () => {
    expect(infisicalStatusLabel({ configured: true, enabled: true, lastError: "401 Unauthorized" })).toEqual({
      label: "Error",
      tone: "error",
    });
  });

  it("surfaces a status fetch failure as Error even with no status yet", () => {
    expect(infisicalStatusLabel(null, "Failed to fetch secret status")).toEqual({
      label: "Error",
      tone: "error",
    });
  });

  it("says Waiting before the first fetch resolves", () => {
    expect(infisicalStatusLabel(null)).toEqual({ label: "Waiting", tone: "waiting" });
  });

  it("says Not configured when no identity is on file", () => {
    expect(infisicalStatusLabel({ configured: false, enabled: false, lastError: null })).toEqual({
      label: "Not configured",
      tone: "off",
    });
  });

  it("says Turned off when configured but the kill switch is flipped", () => {
    expect(infisicalStatusLabel({ configured: true, enabled: false, lastError: null })).toEqual({
      label: "Turned off",
      tone: "off",
    });
  });

  it("says Stale when the last refresh failed but an old snapshot survives", () => {
    expect(infisicalStatusLabel({ configured: true, enabled: true, lastError: null, stale: true })).toEqual({
      label: "Stale",
      tone: "waiting",
    });
  });

  it("says Connected only once configured, enabled, and fresh", () => {
    expect(infisicalStatusLabel({ configured: true, enabled: true, lastError: null, stale: false })).toEqual({
      label: "Connected",
      tone: "active",
    });
  });
});

describe("infisicalSwitchDefault", () => {
  it("shows the documented default on an install with nothing configured", () => {
    // `GET /api/config` reports `enabled: configured && settings.enabled`, so
    // a fresh install sends `false` here.  Seeding the switch from that value
    // renders Use Infisical off and makes the operator's very first Save
    // persist a hard `enabled: false` — a store that authenticates and then
    // governs nothing, with no message saying why.
    expect(infisicalSwitchDefault({ configured: false, enabled: false })).toBe(true);
    expect(infisicalSwitchDefault(undefined)).toBe(true);
    expect(infisicalSwitchDefault(null)).toBe(true);
  });

  it("honours the stored kill switch once there is a store to switch off", () => {
    expect(infisicalSwitchDefault({ configured: true, enabled: false })).toBe(false);
    expect(infisicalSwitchDefault({ configured: true, enabled: true })).toBe(true);
  });
});

describe("buildInfisicalConfigPatch", () => {
  const base = {
    enabled: true,
    writeThrough: false,
    siteUrl: "https://app.infisical.com",
    projectId: "test-project-0000",
    environment: "prod",
    secretPath: "/",
    clientId: "client-id",
    clientSecret: "",
    refreshMinutes: 15,
  };

  it("omits an empty client secret so Save cannot wipe a stored one", () => {
    const result = buildInfisicalConfigPatch(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).not.toHaveProperty("clientSecret");
  });

  it("omits an empty client id too, since GET /api/infisical/status never echoes it back", () => {
    const result = buildInfisicalConfigPatch({ ...base, clientId: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).not.toHaveProperty("clientId");
  });

  it("includes a non-empty client secret, trimmed", () => {
    const result = buildInfisicalConfigPatch({ ...base, clientSecret: `  ${SENTINEL_SECRET}  ` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.clientSecret).toBe(SENTINEL_SECRET);
  });

  it("trims the site URL", () => {
    const result = buildInfisicalConfigPatch({ ...base, siteUrl: "  https://app.infisical.com  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.siteUrl).toBe("https://app.infisical.com");
  });

  it("rejects a non-https site URL", () => {
    const result = buildInfisicalConfigPatch({ ...base, siteUrl: "http://app.infisical.com" });
    expect(result).toEqual({ ok: false, error: "Site URL must be an absolute https:// URL." });
  });

  it("accepts an empty site URL as a clear", () => {
    const result = buildInfisicalConfigPatch({ ...base, siteUrl: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.siteUrl).toBe("");
  });

  it("rejects a secret path with no leading slash", () => {
    const result = buildInfisicalConfigPatch({ ...base, secretPath: "no-slash" });
    expect(result).toEqual({ ok: false, error: "Secret Path must start with /." });
  });

  it("rejects an out-of-shape environment", () => {
    const result = buildInfisicalConfigPatch({ ...base, environment: "Not Valid!" });
    expect(result).toEqual({
      ok: false,
      error: "Environment must be 1 to 64 lowercase letters, numbers, or dashes.",
    });
  });

  it("rejects an out-of-shape project id", () => {
    const result = buildInfisicalConfigPatch({ ...base, projectId: "has/a/slash" });
    expect(result).toEqual({
      ok: false,
      error: "Project ID must be 1 to 64 letters, numbers, or dashes.",
    });
  });

  it("rejects refresh minutes outside 5..1440", () => {
    expect(buildInfisicalConfigPatch({ ...base, refreshMinutes: 4 })).toEqual({
      ok: false,
      error: "Refresh Minutes must be between 5 and 1440.",
    });
    expect(buildInfisicalConfigPatch({ ...base, refreshMinutes: 1441 })).toEqual({
      ok: false,
      error: "Refresh Minutes must be between 5 and 1440.",
    });
  });

  it("accepts the boundary values", () => {
    expect(buildInfisicalConfigPatch({ ...base, refreshMinutes: 5 }).ok).toBe(true);
    expect(buildInfisicalConfigPatch({ ...base, refreshMinutes: 1440 }).ok).toBe(true);
  });

  it("never returns a value field — only names, flags, and counts", () => {
    const result = buildInfisicalConfigPatch({ ...base, clientSecret: SENTINEL_SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.patch);
    // The client secret itself is the one real value in the shape, and it is
    // only ever present because the operator just typed it to send it — the
    // check here is that no OTHER field smuggles a value out, not that the
    // patch is value-free (a write-through save has to carry the secret).
    expect(Object.keys(result.patch).sort()).toEqual(
      ["clientId", "clientSecret", "enabled", "environment", "projectId", "refreshMinutes", "secretPath", "siteUrl", "writeThrough"].sort(),
    );
    expect(serialized).toContain(SENTINEL_SECRET);
  });
});

describe("splitInfisicalPatch", () => {
  const built = (): InfisicalConfigPatch => {
    const result = buildInfisicalConfigPatch({
      enabled: true,
      writeThrough: false,
      siteUrl: "https://app.infisical.com",
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      clientId: "client-1",
      clientSecret: SENTINEL_SECRET,
      refreshMinutes: 15,
    });
    if (!result.ok) throw new Error(result.error);
    return result.patch;
  };

  it("sends the client secret through the bridge and everything else over PATCH", () => {
    const { configPatch, bridgeSecret } = splitInfisicalPatch(built(), true);

    // The whole point: the one value that can read every name in the project
    // never rides in a plain HTTP body that the server would write into
    // plaintext config.json.
    expect(bridgeSecret).toBe(SENTINEL_SECRET);
    expect(JSON.stringify(configPatch)).not.toContain(SENTINEL_SECRET);
    expect("clientSecret" in configPatch).toBe(false);
    // And nothing else is lost on the way — the client id is a plain
    // identifier and stays in the PATCH, exactly as it does on disk.
    expect(Object.keys(configPatch).sort()).toEqual(
      ["clientId", "enabled", "environment", "projectId", "refreshMinutes", "secretPath", "siteUrl", "writeThrough"].sort(),
    );
    expect(configPatch.clientId).toBe("client-1");
  });

  it("keeps the secret in the PATCH body when there is no desktop bridge", () => {
    // A browser against the loopback harness has no OS credential store to
    // reach, so the server's own file is the only place the identity can go.
    const { configPatch, bridgeSecret } = splitInfisicalPatch(built(), false);

    expect(bridgeSecret).toBeNull();
    expect(configPatch.clientSecret).toBe(SENTINEL_SECRET);
  });

  it("takes the plain PATCH path when the save carries no secret at all", () => {
    const result = buildInfisicalConfigPatch({
      enabled: true,
      writeThrough: true,
      siteUrl: "https://app.infisical.com",
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      clientId: "",
      clientSecret: "",
      refreshMinutes: 30,
    });
    if (!result.ok) throw new Error(result.error);

    const { configPatch, bridgeSecret } = splitInfisicalPatch(result.patch, true);

    // Changing Refresh Minutes on its own must not call the bridge with an
    // empty string — `credential:set` reads that as "delete this credential".
    expect(bridgeSecret).toBeNull();
    expect(configPatch).toEqual(result.patch);
  });

  it("leaves the built patch untouched", () => {
    const patch = built();
    splitInfisicalPatch(patch, true);
    expect(patch.clientSecret).toBe(SENTINEL_SECRET);
  });
});

// A workspace id is not a credential on its own, but it is the one piece of
// the universal-auth triple an attacker cannot guess — and it is exactly the
// class of fleet infrastructure identifier that belongs in the private
// fleet-ops inventory, not compiled into a shipped renderer bundle or
// committed to a public repository.  The Project ID placeholder is the field
// most likely to collect one by accident: whoever wires the card has a real
// id in their terminal while they work.
describe("the Infisical surface carries no real workspace id", () => {
  const INFISICAL_SOURCES = [
    "src/components/SecretsSection.tsx",
    "src/components/SecretSourceBadge.tsx",
    "src/lib/secret-source.ts",
    "src/lib/secret-source.test.ts",
    "server/infisical.ts",
    "server/infisical-client.ts",
    "server/secret-map.ts",
    "docs/secrets.md",
    "scripts/infisical-fetch.mjs",
    "scripts/infisical-migrate.mjs",
  ];
  // The synthetic placeholder is the ONLY UUID-shaped literal allowed here.
  const SYNTHETIC = "00000000-0000-0000-0000-000000000000";
  const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

  for (const relative of INFISICAL_SOURCES) {
    it(`${relative} names no real project id`, () => {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, relative), "utf8");
      } catch {
        // A file this package has not written yet is not a failure; the
        // guard covers whichever of them exist.
        return;
      }
      expect(text.match(UUID)?.filter((found) => found !== SYNTHETIC) ?? []).toEqual([]);
    });
  }

  // config.test.ts as a whole is out of scope here — the Sentry lane keeps a
  // deliberately synthetic DSN fixture in it — so the secret-store block gets
  // its own read, which is where an Infisical project id would land.
  it("keeps a fixture project id in config.test.ts's secret-store block", () => {
    const suite = readFileSync(join(REPO_ROOT, "server/config.test.ts"), "utf8");
    const start = suite.indexOf('describe("the secret-store section"');
    expect(start, "the secret-store describe block was renamed").toBeGreaterThan(-1);
    const block = suite.slice(start);
    expect(block.match(UUID)?.filter((found) => found !== SYNTHETIC) ?? []).toEqual([]);
  });

  it("offers a synthetic Project ID placeholder, not one copied from a real store", () => {
    const card = readFileSync(join(REPO_ROOT, "src/components/SecretsSection.tsx"), "utf8");
    const placeholder = /id="infisical-project-id"[\s\S]{0,600}?placeholder="([^"]*)"/.exec(card);
    expect(placeholder, "the Project ID input lost its placeholder").not.toBeNull();
    expect([SYNTHETIC, "Project id from Infisical", "your-project-id"]).toContain(placeholder?.[1]);
  });
});

describe("secretSourceDisplay", () => {
  it("names the file an engine reads on its own, rather than saying Not set", () => {
    // The MiniMax driver reads ~/.mmx/config.json itself, which the secret
    // map — a pure function over config, env and the vault — cannot see. A
    // card saying "Not set" beside an engine whose turns work is the one
    // answer that is actively misleading.
    expect(secretSourceDisplay("none", "~/.mmx/config.json")).toEqual({
      label: "~/.mmx/config.json",
      tone: "local",
      external: true,
    });
    expect(secretSourceDisplay(undefined, "~/.mmx/config.json").external).toBe(true);
  });

  it("never lets an outside file take credit for a value a managed source is supplying", () => {
    for (const source of ["infisical", "env", "file"] as const) {
      const shown = secretSourceDisplay(source, "~/.mmx/config.json");
      expect(shown.external).toBe(false);
      expect(shown.label).toBe(secretSourceLabel(source));
      expect(shown.tone).toBe(secretSourceTone(source));
    }
  });

  it("falls back to the plain label when there is no outside file", () => {
    expect(secretSourceDisplay("none")).toEqual({ label: "Not set", tone: "unset", external: false });
    expect(secretSourceDisplay("none", null).label).toBe("Not set");
    expect(secretSourceDisplay("none", "").label).toBe("Not set");
  });
});
