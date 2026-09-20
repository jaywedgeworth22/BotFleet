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
 * - files / Terminal / the web / connected apps / this computer need
 *   Claude, Codex, Antigravity, or Cursor
 * - the path to MiniMax with full tool support is the DeepSeek Harness
 *   engine with MiniMax M3
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

  it("names the surfaces MiniMax-direct does not have, in one short sentence", () => {
    expect(box).toMatch(/Lacks Files, Terminal, the web, and connected apps\./);
  });

  it("keeps the compact line short so model names stay visible underneath", () => {
    // The visible-by-default block runs from <strong>Talks…</strong> through
    // the immediate next text.  Cap it at ~140 characters so the model list
    // under the picker lands on one screen even at 320px widths.
    const compactMatch = box.match(
      /<strong[^>]*>Talks to the Team\.[\s\S]*?Lacks Files, Terminal, the web, and connected apps\./,
    );
    expect(compactMatch).not.toBeNull();
    const compactText = compactMatch?.[0] ?? "";
    expect(compactText.length).toBeGreaterThan(0);
    expect(compactText.length).toBeLessThan(140);
  });
});

describe("MiniMaxCallout — disclosure", () => {
  const box = readFileBox();

  it("puts the longer explanation behind a 'Why this engine?' disclosure", () => {
    expect(box).toMatch(/Why this engine\?/);
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

  it("points files, Terminal, the web, connected apps, and this computer at the CLI engines", () => {
    expect(box).toMatch(/Claude, Codex, Antigravity, or Cursor/);
    expect(box).toMatch(/this computer/);
  });

  it("points owners at DeepSeek Harness with MiniMax M3 for full tool support", () => {
    // The disclosure explicitly mentions the engine the user already sees in
    // the rail ("DeepSeek Harness") and the model inside that engine that
    // gets the full capability surface ("MiniMax M3").
    expect(box).toMatch(/DeepSeek Harness engine with MiniMax M3/);
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
