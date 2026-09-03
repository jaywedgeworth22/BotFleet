// Usage telemetry ships no endpoint and no project names.
//
// Two things are being defended here. First, an install that has configured
// nothing must report that it has configured nothing — the status route used
// to name a fallback host whether or not anyone had opted in, which reads to
// a user as "my tokens are already going there". Second, project
// classification is the operator's list, not a list of somebody's repos
// baked into the binary.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseStoredConfig, usageIngestUrl, usageProjectRules, type AppConfig } from "./config.ts";
import { inferProject, telemetry, type UsageSettings } from "./telemetry.ts";

const ENV_KEYS = ["USAGE_MONITOR_INGEST_URL", "USAGE_MONITOR_INGEST_TOKEN", "USAGE_INGEST_TOKEN"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  telemetry.configure(null);
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

function withSettings(settings: UsageSettings) {
  telemetry.configure(() => settings);
}

describe("telemetry status when nothing is configured", () => {
  it("reports no URL at all — not a fallback endpoint", () => {
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.ingestUrl).toBeNull();
  });

  it("stays disabled and nameless with a URL but no token", () => {
    withSettings({ ingestUrl: "https://usage.example.com" });
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.ingestUrl).toBeNull();
  });

  it("stays disabled and nameless with a token but no URL", () => {
    withSettings({ ingestToken: "tok_abc" });
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.ingestUrl).toBeNull();
  });

  it("names the operator's own endpoint once both halves are set", () => {
    withSettings({ ingestUrl: "https://usage.example.com/", ingestToken: "tok_abc" });
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.ingestUrl).toBe("https://usage.example.com/api/ingest/usage");
  });

  it("still honours the env fallback so existing installs keep working", () => {
    process.env.USAGE_MONITOR_INGEST_URL = "https://env.example.com";
    process.env.USAGE_MONITOR_INGEST_TOKEN = "tok_env";
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.ingestUrl).toBe("https://env.example.com/api/ingest/usage");
  });

  it("prefers configured settings over the env fallback", () => {
    process.env.USAGE_MONITOR_INGEST_URL = "https://env.example.com";
    process.env.USAGE_MONITOR_INGEST_TOKEN = "tok_env";
    withSettings({ ingestUrl: "https://configured.example.com", ingestToken: "tok_cfg" });

    expect(telemetry.getStatus().ingestUrl).toBe("https://configured.example.com/api/ingest/usage");
  });
});

describe("project classification", () => {
  const rules = [
    { slug: "storefront", match: ["shop-web", "storefront"] },
    { slug: "billing", match: ["invoices"] },
  ];

  it("uses the configured rules, in order", () => {
    expect(inferProject("/work/shop-web", "Bot", undefined, rules)).toBe("storefront");
    expect(inferProject("/work/invoices-api", "Bot", undefined, rules)).toBe("billing");
  });

  it("matches on bot name and task title, not just the working directory", () => {
    expect(inferProject(null, "invoices bot", undefined, rules)).toBe("billing");
    expect(inferProject(null, "Bot", "rebuild the storefront", rules)).toBe("storefront");
  });

  it("takes the first matching rule when several could match", () => {
    const ordered = [
      { slug: "first", match: ["shared"] },
      { slug: "second", match: ["shared"] },
    ];
    expect(inferProject("/work/shared-thing", "Bot", undefined, ordered)).toBe("first");
  });

  it("falls back to the working directory basename with no rules configured", () => {
    expect(inferProject("/work/some-repo", "Bot")).toBe("some-repo");
    expect(inferProject("/work/some-repo", "Bot", undefined, [])).toBe("some-repo");
  });

  it("falls back to the basename when no rule matches", () => {
    expect(inferProject("/work/unrelated", "Bot", undefined, rules)).toBe("unrelated");
  });

  it("returns general when there is no working directory to derive from", () => {
    expect(inferProject(null, "Bot", "some task", rules)).toBe("general");
    expect(inferProject("/", "Bot", undefined, rules)).toBe("general");
  });

  it("ships no built-in project names", () => {
    // The classifier used to hardcode a specific set of repositories. Those
    // names must now resolve only through configuration.
    for (const name of ["congress-trade", "socratic-trade", "dealdex", "fleet-ops", "ai-fleet-coordinator"]) {
      expect(inferProject(`/work/${name}`, "Bot")).toBe(name);
      expect(inferProject("/work/plain", `${name} bot`, undefined, [])).toBe("plain");
    }
  });

  it("ignores rules with an empty slug or no match terms", () => {
    const sloppy = [
      { slug: "", match: ["work"] },
      { slug: "nomatch", match: [] },
      { slug: "real", match: ["work"] },
    ];
    expect(inferProject("/work/thing", "Bot", undefined, sloppy)).toBe("real");
  });
});

describe("usage config", () => {
  it("round-trips ingest URL, token, and project rules through the schema", () => {
    const cfg = parseStoredConfig({
      usage: {
        ingestUrl: "https://usage.example.com/",
        ingestToken: "tok_abc",
        projects: [{ slug: "storefront", match: ["shop-web"] }],
      },
    });

    expect(usageIngestUrl(cfg)).toBe("https://usage.example.com");
    expect(cfg.usage?.ingestToken).toBe("tok_abc");
    expect(usageProjectRules(cfg)).toEqual([{ slug: "storefront", match: ["shop-web"] }]);
  });

  it("reports no ingest URL for an empty or non-absolute value", () => {
    expect(usageIngestUrl({})).toBeNull();
    expect(usageIngestUrl({ usage: {} })).toBeNull();
    expect(usageIngestUrl({ usage: { ingestUrl: "   " } })).toBeNull();
    expect(usageIngestUrl({ usage: { ingestUrl: "usage.example.com" } })).toBeNull();
  });

  it("drops project rules that could never match", () => {
    const cfg: AppConfig = {
      usage: {
        projects: [
          { slug: " ", match: ["x"] },
          { slug: "keep", match: [" x ", ""] },
          { slug: "drop", match: [] },
        ],
      },
    };
    expect(usageProjectRules(cfg)).toEqual([{ slug: "keep", match: ["x"] }]);
  });
});
