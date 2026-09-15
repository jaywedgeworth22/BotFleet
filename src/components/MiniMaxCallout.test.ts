import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Product chrome, not the registry.  The EnginesSettings row and ModelPicker
 * rail must describe MiniMax in owner-facing language: no snake_case tool
 * ids, no harness, no DSH, no Native HTTP API.
 *
 * Facts that still have to stay true (without naming the tools):
 * - a chat this bot starts can talk to the team
 * - a turn another bot asked does not
 * - a section lead can add a specialist only in a direct chat
 * - files / Terminal / the web need Claude, Codex, Antigravity, or Cursor
 */
const ENGINES_SETTINGS_SRC = readFileSync(join(__dirname, "EnginesSettings.tsx"), "utf8");
const MODEL_PICKER_SRC = readFileSync(join(__dirname, "ModelPicker.tsx"), "utf8");

function engineBox(src: string, needle: string): string {
  const boxStart = src.indexOf(needle);
  expect(boxStart).toBeGreaterThan(-1);
  const boxEnd = src.indexOf("</div>", boxStart);
  return src.slice(boxStart, boxEnd);
}

function expectNoCollapsingSentenceGaps(box: string): void {
  const NBSP_MARKER = '{"  "}';
  for (const m of box.matchAll(/[.;]\s+([A-Z])/g)) {
    const boundary = m.index!;
    const before = box.slice(0, boundary + 1);
    if (before.trimEnd().endsWith(NBSP_MARKER)) continue;
    throw new Error(
      `Sentence boundary not preceded by the {"\\u00a0 "} marker (will collapse to one space): ` +
        JSON.stringify(box.slice(Math.max(0, boundary - 40), boundary + 20)),
    );
  }
}

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

describe("MiniMax callout copy — EnginesSettings row", () => {
  const box = engineBox(ENGINES_SETTINGS_SRC, '["minimax"].includes(instance.driverKind)');

  it("uses product chrome, not coordinator-speak", () => {
    expect(box).toMatch(/Talks to the Team/);
    expect(box).not.toMatch(/Native HTTP API/);
    expect(box).not.toMatch(/harness/);
    expect(box).not.toMatch(/DSH/);
    expect(box).not.toMatch(/OpenAI function-calling/);
    expect(box).not.toMatch(/bot-to-bot recursion/);
    for (const tool of TOOL_IDS) {
      expect(box).not.toContain(`<code>${tool}</code>`);
    }
  });

  it("says a started chat can talk to the team, and a peer-asked turn cannot", () => {
    expect(box).toMatch(/In a chat this bot starts/);
    expect(box).toMatch(/None of that runs when another bot asked it/);
  });

  it("qualifies adding a specialist as section-lead and direct-chat only", () => {
    expect(box).toMatch(/section lead can add a specialist/);
    expect(box).toMatch(/only in a direct chat/);
    expect(box).toMatch(/not in a room/);
  });

  it("points file, Terminal, web, and this computer at real CLI engines", () => {
    expect(box).toMatch(/Claude, Codex, Antigravity, or Cursor/);
    expect(box).toMatch(/this computer/);
  });

  it("never lets a sentence gap collapse to one space under HTML whitespace rules", () => {
    expect(() => expectNoCollapsingSentenceGaps(box)).not.toThrow();
  });
});

describe("MiniMax callout copy — ModelPicker rail", () => {
  const box = engineBox(MODEL_PICKER_SRC, '["minimax"].includes(railInstance.driverKind)');

  it("uses product chrome, not coordinator-speak", () => {
    expect(box).toMatch(/Limited Tool Support/);
    expect(box).not.toMatch(/harness tools/);
    expect(box).not.toMatch(/DSH/);
    for (const tool of TOOL_IDS) {
      expect(box).not.toContain(`<code>${tool}</code>`);
    }
  });

  it("says a started chat can talk to the team, and a peer-asked turn cannot", () => {
    expect(box).toMatch(/In a chat this bot starts/);
    expect(box).toMatch(/None of that runs when another bot asked it/);
  });

  it("qualifies adding a specialist as section-lead and direct-chat only", () => {
    expect(box).toMatch(/section lead can add a specialist/);
    expect(box).toMatch(/only in a direct chat/);
  });

  it("points files, Terminal, and the web at real CLI engines", () => {
    expect(box).toMatch(/Claude, Codex, Antigravity, or Cursor/);
  });

  it("never lets a sentence gap collapse to one space under HTML whitespace rules", () => {
    expect(() => expectNoCollapsingSentenceGaps(box)).not.toThrow();
  });
});
