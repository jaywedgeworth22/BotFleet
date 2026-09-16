// Twelve drivers mount the recall proxy and, until this module existed, not
// one word of the assembled system prompt mentioned it.  These pin the three
// things that make the sentences safe to ship:
//
//   1. they appear only when THIS turn mounted the proxy (never off the
//      config, which says the operator has a corpus, not that this engine
//      can reach it),
//   2. they are wired into both assembly sites, because a prompt nobody
//      concatenates is the same bug in a new file,
//   3. they name only tools the proxy actually exposes, and keep the
//      fleet's two-space sentence gaps.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { recallPromptFor } from "./recall-prompt.ts";

const QDRANT_MOUNT = { command: "node", args: ["qdrant-proxy.ts"], env: {} };

describe("recallPromptFor", () => {
  it("says nothing at all when this turn mounted no corpus", () => {
    expect(recallPromptFor(undefined)).toBe("");
    expect(recallPromptFor(null)).toBe("");
    expect(recallPromptFor({})).toBe("");
    // Another integration is not this one: a bot with connected apps and no
    // recall mount must still hear nothing about recall.
    expect(recallPromptFor({ composio: QDRANT_MOUNT } as { qdrant?: unknown })).toBe("");
  });

  it("names the search and contribute tools when the proxy is mounted", () => {
    const prompt = recallPromptFor({ qdrant: QDRANT_MOUNT });

    expect(prompt).toContain("recall_search");
    expect(prompt).toContain("recall_contribute");
    // The three reasons to search, the verify-don't-trust rule, and the
    // categories a contribution may carry.
    expect(prompt).toMatch(/re-derive a lesson/);
    expect(prompt).toMatch(/smells familiar/);
    expect(prompt).toMatch(/past ruling probably answers/);
    expect(prompt).toMatch(/lead to verify rather than a verdict/);
    expect(prompt).toMatch(/lesson, preference, infrastructure, decision, or runbook/);
    expect(prompt).toMatch(/never\s+secrets, and never a transcript/);
    // It concatenates into a running system string, so it opens with the
    // separator the neighbouring fragments use.
    expect(prompt.startsWith(" ")).toBe(true);
  });

  it("never names a tool the proxy does not expose", () => {
    const proxySource = readFileSync(join(__dirname, "drivers", "qdrant-proxy.ts"), "utf8");
    const exposed = new Set([...proxySource.matchAll(/name: "([a-z][a-z0-9_]*)"/g)].map((m) => m[1]));
    // Guard the guard: if the proxy's tool table ever stops matching, this
    // test would pass vacuously.
    expect(exposed.has("recall_search")).toBe(true);
    expect(exposed.has("recall_contribute")).toBe(true);

    const named = [...recallPromptFor({ qdrant: QDRANT_MOUNT }).matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(exposed).toContain(tool);
  });

  it("keeps two spaces between sentences", () => {
    const prompt = recallPromptFor({ qdrant: QDRANT_MOUNT });

    expect(prompt).toMatch(/\.\s{2}[A-Z]/);
    // A single space anywhere at a sentence boundary is the failure: this is
    // a plain string, so nothing downstream can restore the gap.
    expect(prompt).not.toMatch(/[a-z][.!?] [A-Z]/);
  });
});

describe("recall prompt wiring", () => {
  const INDEX_SRC = readFileSync(join(__dirname, "index.ts"), "utf8");

  it("is concatenated at both the 1:1 and the room assembly sites", () => {
    expect([...INDEX_SRC.matchAll(/recallPromptFor\(integrations\)/g)]).toHaveLength(2);
  });

  it("is gated on the mounted integration rather than the config", () => {
    expect(INDEX_SRC).not.toMatch(/recallPromptFor\(\s*cfg\./);
  });
});
