import { describe, expect, it } from "vitest";
import {
  driverKindsForWindow,
  familiesForWindow,
  modelsToSkip,
  quotaWindowsUrl,
  type RemoteQuotaWindow,
} from "./usage-quota.ts";

const opus: RemoteQuotaWindow = {
  id: "claude-opus-4-6-thinking",
  provider: "google-antigravity",
  sourceApp: "antigravity-cli",
  label: "Claude Opus 4.6 (Thinking)",
  modelId: "claude-opus-4-6-thinking",
  modelType: "claude-opus",
  window: "weekly",
  remainingPercent: 0,
  resetAt: "2026-09-09T07:04:37Z",
  status: "exhausted",
  skip: true,
  skipReason: "0% remaining",
};

describe("usage quota mapping", () => {
  it("derives quota-windows URL from the ingest endpoint", () => {
    expect(quotaWindowsUrl("https://usage.jays.services/api/ingest/usage")).toBe(
      "https://usage.jays.services/api/quota-windows",
    );
    expect(quotaWindowsUrl("https://usage.jays.services")).toBe(
      "https://usage.jays.services/api/quota-windows",
    );
  });

  it("maps Antigravity windows onto the Antigravity driver", () => {
    expect(driverKindsForWindow(opus)).toEqual(["antigravityAgent"]);
  });

  it("skips the exact exhausted model id", () => {
    expect(
      modelsToSkip(opus, {
        instanceId: "antigravity",
        driverKind: "antigravityAgent",
        models: { options: [{ id: "claude-opus-4-6-thinking" }, { id: "gemini-3.6-flash-high" }] },
      }),
    ).toEqual(["claude-opus-4-6-thinking"]);
  });

  it("expands a Claude+GPT group skip across matching catalog ids", () => {
    const group: RemoteQuotaWindow = {
      ...opus,
      id: "3p-weekly",
      label: "Claude and GPT models (weekly)",
      modelId: null,
      modelType: "claude",
    };
    expect(familiesForWindow(group)).toContain("gpt");
    expect(
      modelsToSkip(group, {
        instanceId: "antigravity",
        driverKind: "antigravityAgent",
        models: {
          options: [
            { id: "claude-sonnet-4-6" },
            { id: "gpt-oss-120b-medium" },
            { id: "gemini-3.6-flash-high" },
          ],
        },
      }),
    ).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
  });

  it("maps a Cursor monthly skip onto the whole cursor engine", () => {
    const monthly: RemoteQuotaWindow = {
      id: "cursor-monthly",
      provider: "cursor",
      sourceApp: "cursor-cli",
      label: "Cursor Pro monthly",
      modelId: null,
      modelType: "cursor",
      window: "monthly",
      remainingPercent: 0,
      resetAt: "2026-09-15T00:00:00.000Z",
      status: "exhausted",
      skip: true,
      skipReason: "0% remaining",
    };
    expect(driverKindsForWindow(monthly)).toEqual(["cursorAgent"]);
    expect(
      modelsToSkip(monthly, {
        instanceId: "cursor",
        driverKind: "cursorAgent",
        models: { options: [{ id: "auto" }, { id: "composer-2.5" }] },
      }),
    ).toEqual(["*"]);
  });
});
