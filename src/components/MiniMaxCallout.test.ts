import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level assertions rather than a render test: neither component test suite in this
 * repo mounts React (the vitest config here runs in the "node" environment, no jsdom/RTL),
 * and the thing worth pinning is the copy string itself, not component behavior.
 *
 * Both the EnginesSettings row and the ModelPicker rail carry a MiniMax-only callout.  After
 * MM PRs 4-8 landed the tool loop, the old copy calling out "two tools" and recommending DSH
 * for tool support went stale.  DSH mounts no MCP servers today (server/drivers/acp/dsh.ts),
 * so it must never appear as a tool-support recommendation.
 *
 * This copy went through four review-caught overclaims before landing (all from
 * chatgpt-codex-connector on this PR) — each is pinned below with the source it was checked
 * against:
 *
 * 1. `create_bot` is gated on `chiefOfStaff` (server/tools/registry.ts,
 *    `CREATE_BOT.gate = chiefOnly`), so an ordinary bot gets seven tools, not eight.
 * 2. `create_bot` carries no `approval` record at all (server/tools/registry.ts: CREATE_BOT
 *    has `sideEffect: "write"` and no `approval` field; server/tools/host.ts only asks when
 *    `harnessTool(call.name)?.approval?.policy === "ask"`), so it runs with no card of any
 *    kind — unlike ask_bot/delegate_bot (approval-gated) or
 *    request_credential/propose_routine/propose_routine_action (settle as a suspend + their
 *    own confirmation card).
 * 3. Even the seven-tool baseline is conditional on the turn's comms depth: server/index.ts
 *    only sets `integrations.agents` (and so grants any of these seven tools) when
 *    `commsDepth < MAX_COMMS_DEPTH` (== 1) — "A comms-invoked turn (depth >= cap) gets none —
 *    hard recursion stop."  A turn this bot runs because a peer invoked it via ask_bot or
 *    delegate_bot is exactly such a turn, so it gets none of the seven, not "up to seven."
 * 4. `create_bot` is unavailable in ANY room turn, Chief of Staff or not: `runGroupMemberTurn`
 *    calls `buildTurnTools(integrations)` and `createTurnToolHost({...})` (server/index.ts,
 *    the room-turn path) without passing `chiefOfStaff` at all, and `buildTurnTools`'s default
 *    is `chiefOfStaff: false` (server/turn-tools.ts) when no `gate` argument is given — so the
 *    room catalog and room host both silently drop it regardless of the bot's real role.
 * 5. Not a factual overclaim but a real bug: the sentence boundaries added while fixing #3 and
 *    #4 used literal ".  " (two ASCII spaces typed directly in JSX text) instead of the file's
 *    own `{"  "}` (NBSP + space) convention.  HTML collapses runs of plain whitespace, so
 *    those two sentences would have rendered with a single-space gap, violating the two-space
 *    sentence-gap rule (AGENTS.md).  `expectNoCollapsingSentenceGaps` below guards against this
 *    class of regression happening again silently.
 */
const ENGINES_SETTINGS_SRC = readFileSync(join(__dirname, "EnginesSettings.tsx"), "utf8");
const MODEL_PICKER_SRC = readFileSync(join(__dirname, "ModelPicker.tsx"), "utf8");

/** The seven tools a top-level (non-peer-invoked) MiniMax turn can get — never claim these
 *  are unconditional; both boxes must qualify them by comms depth and, for create_bot, role. */
const SEVEN_TOP_LEVEL_TOOLS = [
  "list_bots",
  "ask_bot",
  "list_routines",
  "delegate_bot",
  "request_credential",
  "propose_routine",
  "propose_routine_action",
];

function engineBox(src: string, needle: string): string {
  const boxStart = src.indexOf(needle);
  expect(boxStart).toBeGreaterThan(-1);
  const boxEnd = src.indexOf("</div>", boxStart);
  return src.slice(boxStart, boxEnd);
}

/** A JSX text node's whitespace runs (spaces, newlines, indentation) collapse to a single
 *  space in the rendered HTML, exactly like any other HTML text.  So a sentence boundary
 *  written as literal ". " + two spaces + a capital letter renders with only one space —
 *  the two-space sentence-gap rule needs the file's `{"  "}` marker (a real NBSP + space;
 *  NBSP survives whitespace collapse) at every such boundary instead.  This walks the box's
 *  raw source and fails if any period-or-semicolon-into-capital-letter transition is plain
 *  JSX text rather than sitting right after that marker. */
function expectNoCollapsingSentenceGaps(box: string): void {
  const NBSP_MARKER = '{"  "}';
  for (const m of box.matchAll(/[.;]\s+([A-Z])/g)) {
    const boundary = m.index!;
    const before = box.slice(0, boundary + 1); // include the . or ;
    if (before.trimEnd().endsWith(NBSP_MARKER)) continue;
    // Also fine when the boundary is followed immediately (same line, no JSX gap) by the
    // marker rather than preceded by it, e.g. "...support:</strong>{" "}Text" patterns —
    // but for a genuine new sentence the marker always comes first in this file's style.
    throw new Error(
      `Sentence boundary not preceded by the {"\\u00a0 "} marker (will collapse to one space): ` +
        JSON.stringify(box.slice(Math.max(0, boundary - 40), boundary + 20)),
    );
  }
}

describe("MiniMax callout copy — EnginesSettings row", () => {
  const box = engineBox(ENGINES_SETTINGS_SRC, '["minimax"].includes(instance.driverKind)');

  it("names the seven top-level harness tools", () => {
    for (const tool of SEVEN_TOP_LEVEL_TOOLS) {
      expect(box).toContain(`<code>${tool}</code>`);
    }
  });

  it("does not claim only two tools", () => {
    expect(box).not.toMatch(/gives it two tools/);
  });

  it("qualifies the tool count as 'up to seven', not an unconditional seven or eight", () => {
    expect(box).toMatch(/gives it up to seven tools/);
    expect(box).not.toMatch(/gives it (seven|eight) tools/);
  });

  it("qualifies create_bot as Chief-of-Staff-only, and direct-chat-only", () => {
    expect(box).toMatch(/section's Chief of Staff also gets[\s\S]{0,20}<code>create_bot<\/code>/);
    expect(box).toMatch(/only in a[\s\S]{0,20}direct chat/);
    expect(box).toMatch(/rooms don't grant it yet/);
  });

  it("says a peer-invoked turn gets none of the seven — the recursion ceiling", () => {
    expect(box).toMatch(/none of them in a turn another[\s\S]{0,20}bot invoked/);
    expect(box).toMatch(/bot-to-bot recursion/);
  });

  it("does not claim create_bot is approval-gated", () => {
    // The old copy's blanket "writes gated by the same approval cards as every
    // other engine" was false for create_bot, which has no approval record.
    expect(box).not.toMatch(/writes gated by the same approval/);
    expect(box).toMatch(/<code>create_bot<\/code> runs immediately, with no card/);
  });

  it("credits ask_bot and delegate_bot with the real approval flow", () => {
    expect(box).toMatch(/<code>ask_bot<\/code> and <code>delegate_bot<\/code> go through the same[\s\S]{0,20}approval flow as any other engine/);
  });

  it("does not recommend DSH for tool support", () => {
    expect(box).not.toMatch(/DSH/);
    expect(box).toMatch(/Claude, Codex, Antigravity, Cursor/);
  });

  it("never lets a sentence gap collapse to one space under HTML whitespace rules", () => {
    expect(() => expectNoCollapsingSentenceGaps(box)).not.toThrow();
  });
});

describe("MiniMax callout copy — ModelPicker rail", () => {
  const box = engineBox(MODEL_PICKER_SRC, '["minimax"].includes(railInstance.driverKind)');

  it("names the seven top-level harness tools", () => {
    for (const tool of SEVEN_TOP_LEVEL_TOOLS) {
      expect(box).toContain(`<code>${tool}</code>`);
    }
  });

  it("does not claim only two tools", () => {
    expect(box).not.toMatch(/has two harness tools/);
  });

  it("qualifies the tool count as 'up to seven', not an unconditional seven or eight", () => {
    expect(box).toMatch(/has up to seven harness tools in a turn it starts itself/);
    expect(box).not.toMatch(/has (seven|eight) harness tools today/);
  });

  it("qualifies create_bot as Chief-of-Staff-only, and direct-chat-only", () => {
    expect(box).toMatch(/Chief of Staff also gets[\s\S]{0,40}<code>create_bot<\/code>/);
    expect(box).toMatch(/but only in a direct[\s\S]{0,30}chat/);
  });

  it("says a peer-invoked turn gets none of the seven — the recursion ceiling", () => {
    expect(box).toMatch(/none of them in a[\s\S]{0,40}turn another bot invoked/);
  });

  it("does not recommend DSH for tool support", () => {
    expect(box).not.toMatch(/DSH/);
    expect(box).toMatch(/Claude, Codex, Antigravity, Cursor/);
  });

  it("never lets a sentence gap collapse to one space under HTML whitespace rules", () => {
    expect(() => expectNoCollapsingSentenceGaps(box)).not.toThrow();
  });
});
