import { describe, expect, it } from "vitest";

import { showToolCallsEnabled, skillRecorderEnabled, summarizeToolCallsEnabled } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps Teach a skill hidden by default", () => {
    expect(skillRecorderEnabled(null)).toBe(false);
    expect(skillRecorderEnabled({})).toBe(false);
    expect(skillRecorderEnabled({ features: { skillRecorder: false } })).toBe(false);
  });

  it("shows Teach a skill only after explicit opt-in", () => {
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
  });

  it("hides tool-call chips by default", () => {
    expect(showToolCallsEnabled(null)).toBe(false);
    expect(showToolCallsEnabled({})).toBe(false);
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
  });

  it("shows tool-call chips only after explicit opt-in", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it("summarizes tool-call runs by default unless explicitly disabled", () => {
    expect(summarizeToolCallsEnabled(null)).toBe(true);
    expect(summarizeToolCallsEnabled({})).toBe(true);
    expect(summarizeToolCallsEnabled({ features: { summarizeToolCalls: true } })).toBe(true);
    expect(summarizeToolCallsEnabled({ features: { summarizeToolCalls: false } })).toBe(false);
  });
});
