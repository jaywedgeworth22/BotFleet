import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("MiniMaxCallout product copy", () => {
  it("keeps the compact MiniMax line accurate and short", () => {
    expect(SRC).toMatch(/<strong[^>]*>\s*Talks to the Team\.\s*<\/strong>/);
    expect(SRC).toMatch(/Includes Files, Terminal, and this computer\./);
    const compact = SRC.match(
      /<strong[^>]*>Talks to the Team\.[\s\S]*?Includes Files, Terminal, and this computer\./,
    )?.[0] ?? "";
    expect(compact.length).toBeGreaterThan(0);
    expect(compact.length).toBeLessThan(140);
  });

  it("keeps the existing team and room semantics", () => {
    expect(SRC).toMatch(/In a chat this bot starts/);
    expect(SRC).toMatch(/None of that runs when another bot asked it/);
    expect(SRC).toMatch(/section lead can add a specialist/);
    expect(SRC).toMatch(/only in a direct chat/);
    expect(SRC).toMatch(/not in a room/);
  });

  it("states MiniMax direct and DeepSeek Harness limits accurately", () => {
    expect(SRC).toMatch(/does not include web access or connected apps/);
    expect(SRC).toMatch(/DeepSeek Harness with MiniMax M3 adds connected apps and more tools/);
    expect(SRC).toMatch(/cannot accept image attachments/);
  });

  it("keeps the disclosure accessible", () => {
    expect(SRC).toMatch(/Why This Engine\?/);
    expect(SRC).toMatch(/aria-expanded/);
    expect(SRC).toMatch(/aria-controls=\{detailId\}/);
    expect(SRC).toMatch(/const detailId = `minimax-callout-detail-\${instanceId}`/);
    expect(SRC).toMatch(/<ChevronDown[\s\S]*?aria-hidden="true"/);
  });

  it("does not leak coordinator or transport jargon", () => {
    for (const tool of TOOL_IDS) {
      expect(SRC).not.toContain(`<code>${tool}</code>`);
      expect(SRC).not.toContain(`_${tool}_`);
    }
    expect(SRC).not.toMatch(/Native HTTP API/);
    expect(SRC).not.toMatch(/OpenAI function-calling/);
    expect(SRC).not.toMatch(/bot-to-bot recursion/);
  });
});
