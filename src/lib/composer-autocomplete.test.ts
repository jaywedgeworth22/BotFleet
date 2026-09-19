import { describe, expect, it } from "vitest";
import {
  autocompleteQueryAt,
  getAutocompleteCandidates,
  applyAutocomplete,
  type AutocompleteContext,
} from "./composer-autocomplete";

describe("autocompleteQueryAt", () => {
  it("detects @ at start of input", () => {
    expect(autocompleteQueryAt("@", 1)).toEqual({ trigger: "@", start: 0, query: "" });
    expect(autocompleteQueryAt("@scout", 6)).toEqual({ trigger: "@", start: 0, query: "scout" });
  });

  it("detects # at start of input", () => {
    expect(autocompleteQueryAt("#", 1)).toEqual({ trigger: "#", start: 0, query: "" });
    expect(autocompleteQueryAt("#general", 8)).toEqual({ trigger: "#", start: 0, query: "general" });
  });

  it("detects triggers preceded by whitespace", () => {
    expect(autocompleteQueryAt("hello @", 7)).toEqual({ trigger: "@", start: 6, query: "" });
    expect(autocompleteQueryAt("check out #linear please", 17)).toEqual({ trigger: "#", start: 10, query: "linear" });
  });

  it("detects triggers preceded by opening punctuation", () => {
    expect(autocompleteQueryAt("(@bot", 5)).toEqual({ trigger: "@", start: 1, query: "bot" });
    expect(autocompleteQueryAt("[#general", 9)).toEqual({ trigger: "#", start: 1, query: "general" });
  });

  it("ignores triggers inside words, emails, or hex codes", () => {
    expect(autocompleteQueryAt("user@domain.com", 15)).toBeNull();
    expect(autocompleteQueryAt("color:#fff", 10)).toBeNull();
  });

  it("ignores trigger across newlines", () => {
    expect(autocompleteQueryAt("@hello\nworld", 12)).toBeNull();
  });
});

describe("getAutocompleteCandidates", () => {
  const baseCtx: AutocompleteContext = {
    bots: [
      { id: "b1", name: "Jarvis", role: "Assistant", hidden: false } as any,
      { id: "b2", name: "Scout", role: "Searcher", hidden: false } as any,
    ],
    groups: [
      { id: "g1", name: "general", bulletin: "All fleet topics", dm: false } as any,
      { id: "g2", name: "dm-bot", dm: true } as any,
    ],
    routines: [
      { id: "r1", name: "Morning Brief", description: "Daily updates" } as any,
    ],
    connectedApps: {
      github: { connected: true },
    },
  };

  it("returns bots for @ trigger", () => {
    const candidates = getAutocompleteCandidates({ trigger: "@", start: 0, query: "" }, baseCtx);
    expect(candidates.map((c) => c.name)).toContain("Jarvis");
    expect(candidates.map((c) => c.name)).toContain("Scout");
  });

  it("filters bots by query", () => {
    const candidates = getAutocompleteCandidates({ trigger: "@", start: 0, query: "sco" }, baseCtx);
    expect(candidates.map((c) => c.name)).toEqual(["Scout"]);
  });

  it("returns channels, connected apps, and popular apps for # trigger", () => {
    const candidates = getAutocompleteCandidates({ trigger: "#", start: 0, query: "" }, baseCtx);
    const names = candidates.map((c) => c.name);
    expect(names).toContain("general");
    expect(names).toContain("GitHub");
    expect(names).toContain("Slack");
    expect(names).not.toContain("dm-bot");
  });

  it("filters channels and apps by query", () => {
    const candidates = getAutocompleteCandidates({ trigger: "#", start: 0, query: "gen" }, baseCtx);
    expect(candidates.map((c) => c.name)).toEqual(["general"]);

    const appCandidates = getAutocompleteCandidates({ trigger: "#", start: 0, query: "lin" }, baseCtx);
    expect(appCandidates.map((c) => c.name)).toEqual(["Linear"]);
  });
});

describe("applyAutocomplete", () => {
  it("inserts @bot with trailing space", () => {
    const result = applyAutocomplete("Ask @ja to help", 7, { trigger: "@", start: 4, query: "ja" }, {
      id: "b1",
      name: "Jarvis",
      kind: "bot",
      badge: "Bot",
    });
    expect(result).toEqual({
      text: "Ask @Jarvis to help",
      caret: 12,
    });
  });

  it("inserts #channel with trailing space", () => {
    const result = applyAutocomplete("Check #gen", 10, { trigger: "#", start: 6, query: "gen" }, {
      id: "g1",
      name: "general",
      kind: "channel",
      badge: "Channel",
    });
    expect(result).toEqual({
      text: "Check #general ",
      caret: 15,
    });
  });
});
