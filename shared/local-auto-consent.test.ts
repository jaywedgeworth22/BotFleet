import { describe, expect, it } from "vitest";
import { matchesLocalAutoConsent, requiresLocalAutoConsent } from "./local-auto-consent";

describe("fleet local Auto consent", () => {
  const bots = [{ id: "a", name: "Ada" }, { id: "b", name: "Lin" }];
  it("accepts an unchanged set regardless of display order", () => {
    expect(matchesLocalAutoConsent([...bots].reverse(), bots)).toBe(true);
  });
  it("refuses missing, added, removed, renamed, or duplicate identities", () => {
    for (const consent of [true, null, [], [bots[0]], [...bots, { id: "c", name: "Sam" }],
      [bots[0], bots[0]], [bots[0], { id: "b", name: "Changed" }], [bots[0], { id: "c", name: "Lin" }]]) {
      expect(matchesLocalAutoConsent(consent, bots)).toBe(false);
    }
  });

  it("covers explicit, inherited, and automatic host grants without undoing Off", () => {
    expect(requiresLocalAutoConsent(["local"], ["cloud"], ["cloud"])).toBe(true);
    expect(requiresLocalAutoConsent(undefined, ["local"], ["cloud"])).toBe(true);
    expect(requiresLocalAutoConsent(undefined, ["cloud"], null)).toBe(false);
    expect(requiresLocalAutoConsent(undefined, [], null)).toBe(true);
    expect(requiresLocalAutoConsent(undefined, undefined, ["cloud"])).toBe(false);
    expect(requiresLocalAutoConsent([], ["local"], null)).toBe(false);
  });
});
