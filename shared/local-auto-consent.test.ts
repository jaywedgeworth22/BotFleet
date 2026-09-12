import { describe, expect, it } from "vitest";
import { matchesLocalAutoConsent } from "./local-auto-consent";

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
});
