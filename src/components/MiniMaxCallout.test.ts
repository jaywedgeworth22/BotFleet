import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Product chrome, not the registry.  The MiniMax callout that the
 * engines-settings row and the model-picker rail both render must describe
 * MiniMax in owner-facing language: no snake_case tool ids, no Native HTTP
 * API, no OpenAI function-calling prose.
 *
 * Facts that still have to stay true:
 * - a chat this bot starts can talk to the team
 * - a turn another bot asked does not
 * - a section lead can add a specialist only in a direct chat
 * - MiniMax direct has Files, Terminal, and this computer
 * - MiniMax direct does not have web access or connected apps
 * - DeepSeek Harness with MiniMax M3 adds connected apps and more tools,
 *   but cannot accept image attachments
 *
 * The compact default state must stay short enough that the model list
 * underneath it remains visible at narrow widths.
 */
const SRC = readFileSync(join(__dirname, "MiniMaxCallout.tsx"), "utf8");

const TOOL_IDS = [
  "list_bots",
  "ask_bot",
  "list_routines",
  "delegate_bot",
  "request_credential",
  "propose_routine",
  "propose_routine_action",
  "create_bot",
];

function readFileBox() {
  // The whole component is the callout — assert against the full source.
  return SRC;
}

describe("MiniMaxCallout — always-visible compact line", () => {
  const box = readFileBox();

  it("opens with the 'Talks to the Team' header so owners recognize the engine", () => {
    expect(box).toMatch(/<strong[^>]*>\s*Talks to the Team\.\s*<\/strong>/);
  });

  it("names the surfaces MiniMax direct includes, in one short sentence", () => {
    expect(box).toMatch(/Includes Files, Terminal, and this computer\./);
  });

  it("keeps the compact line short so model names stay visible underneath", () => {
    // The visible-by-default block runs from <strong>Talks…</strong> through
    // the immediate next text.  Cap it at ~140 characters so the model list
    // under the picker lands on one screen even at 320px widths.
    const compactMatch = box.match(
      /<strong[^>]*>Talks to the Team\.[\s\S]*?Includes Files, Terminal, and this computer\./,
    );
    expect(compactMatch).not.toBeNull();
    const compactText = compactMatch?.[0] ?? "";
    expect(compactText.length).toBeGreaterThan(0);
    expect(compactText.length).toBeLessThan(140);
  });
});

describe("MiniMaxCallout — disclosure", () => {
  const box = readFileBox();

  it("puts the longer explanation behind a 'Why This Engine?' disclosure", () => {
    expect(box).toMatch(/Why This Engine\?/);
    expect(box).toMatch(/aria-expanded/);
    expect(box).toMatch(/aria-controls=\{detailId\}/);
    expect(box).toMatch(/const detailId = `minimax-callout-detail-\${instanceId}`/);
  });

  it("explains team-chat vs peer-asked semantics", () => {
    expect(box).toMatch(/In a chat this bot starts/);
    expect(box).toMatch(/None of that runs when another bot asked it/);
  });

  it("qualifies adding a specialist as section-lead and direct-chat only", () => {
    expect(box).toMatch(/section lead can add a specialist/);
    expect(box).toMatch(/only in a direct chat/);
    expect(box).toMatch(/not in a room/);
  });

  it("states MiniMax direct's tool limits accurately", () => {
    expect(box).toMatch(/does not include web access or connected apps/);
  });

  it("describes the DeepSeek Harness option without claiming image support", () => {
    expect(box).toMatch(/DeepSeek Harness with MiniMax M3 adds connected apps and more tools/);
    expect(box).toMatch(/cannot accept image attachments/);
  });

  it("hides the decorative disclosure chevron from assistive technology", () => {
    expect(box).toMatch(/<ChevronDown[\s\S]*?aria-hidden="true"/);
  });
});

describe("MiniMaxCallout — forbidden coordinator-speak", () => {
  const box = readFileBox();

  it("does not name the internal tool ids owners should never see", () => {
    for (const tool of TOOL_IDS) {
      expect(box).not.toContain(`<code>${tool}</code>`);
      expect(box).not.toContain(`_${tool}_`);
    }
  });

  it("does not leak registry or transport jargon", () => {
    expect(box).not.toMatch(/Native HTTP API/);
    expect(box).not.toMatch(/OpenAI function-calling/);
    expect(box).not.toMatch(/bot-to-bot recursion/);
  });

  it("never lets a sentence gap collapse to one space under HTML whitespace rules", () => {
    // Same NBSP marker discipline as the rest of the product chrome.
    // File-level `//` prose comments are exempt — only sentence boundaries in
    // JSX text matter.  Strip line comments before scanning so a sentence in
    // the file header can't false-positive this guard.
    const NBSP_MARKER = '{"  "}';
    const prose = box
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const match of prose.matchAll(/[.;]\s+([A-Z])/g)) {
      const boundary = match.index!;
      const before = prose.slice(0, boundary + 1);
      if (before.trimEnd().endsWith(NBSP_MARKER)) continue;
      throw new Error(
        `Sentence boundary not preceded by the NBSP-space marker (will collapse to one space): ` +
          JSON.stringify(prose.slice(Math.max(0, boundary - 40), boundary + 20)),
      );
    }
  });
});
