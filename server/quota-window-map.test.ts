import { describe, expect, it } from "vitest";

import { driverKindsForWindow, engineMeterNote, type QuotaWindowMatch } from "./quota-window-map.ts";

function window(overrides: Partial<QuotaWindowMatch> = {}): QuotaWindowMatch {
  return {
    provider: "",
    sourceApp: null,
    label: "",
    skip: false,
    ...overrides,
  };
}

describe("driverKindsForWindow — droid/Factory", () => {
  it("maps a Factory-provider window onto droidAgent", () => {
    expect(driverKindsForWindow(window({ provider: "factory", label: "Factory weekly" }))).toEqual(["droidAgent"]);
  });

  it("maps a window merely labeled 'droid' onto droidAgent", () => {
    expect(driverKindsForWindow(window({ label: "Droid session cap" }))).toEqual(["droidAgent"]);
  });

  it("does not map an unrelated window onto droidAgent", () => {
    expect(driverKindsForWindow(window({ provider: "openai", label: "ChatGPT weekly" }))).not.toContain("droidAgent");
  });
});

describe("engineMeterNote", () => {
  it("returns an explicit metered note for pi, qwen, hermes, opencodeGo and boxAgent", () => {
    for (const kind of ["piAgent", "qwenAgent", "hermesAgent", "opencodeGo", "boxAgent"]) {
      const note = engineMeterNote(kind);
      expect(note).not.toBeNull();
      expect(note?.kind).toBe("metered");
      expect(note?.copy.length).toBeGreaterThan(0);
      // Sentence-case status-line convention: no leading capital, no
      // trailing period — matches the rest of the Fleet Quotas row copy.
      expect(note?.copy[0]).toBe(note?.copy[0]?.toLowerCase());
      expect(note?.copy.endsWith(".")).toBe(false);
    }
  });

  it("returns null for an engine with a real Usage Monitor window family", () => {
    expect(engineMeterNote("droidAgent")).toBeNull();
    expect(engineMeterNote("cursorAgent")).toBeNull();
  });

  it("returns null for an unknown driver kind", () => {
    expect(engineMeterNote("someFutureEngine")).toBeNull();
  });
});
