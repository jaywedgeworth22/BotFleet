import { describe, expect, it } from "vitest";

import { coalesce, foldPrompts, gapEndsAt, gapMs, withinGap } from "./trigger-gap.ts";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe("gapMs", () => {
  it("reads a gap in whole milliseconds", () => {
    expect(gapMs(5)).toBe(5 * MIN);
    expect(gapMs(0.5)).toBe(30_000);
  });

  it("treats absent, zero and nonsense as no gap — the behavior every trigger had before", () => {
    expect(gapMs(undefined)).toBe(0);
    expect(gapMs(null)).toBe(0);
    expect(gapMs(0)).toBe(0);
    expect(gapMs(-5)).toBe(0);
    expect(gapMs(Number.NaN)).toBe(0);
    expect(gapMs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("withinGap", () => {
  it("holds a delivery that lands inside the quiet period", () => {
    expect(withinGap(NOW, NOW + 2 * MIN, 5)).toBe(true);
  });

  it("lets one through the moment the period closes", () => {
    expect(withinGap(NOW, NOW + 5 * MIN, 5)).toBe(false);
    expect(withinGap(NOW, NOW + 5 * MIN + 1, 5)).toBe(false);
  });

  it("never holds the first delivery, or any delivery with no gap set", () => {
    expect(withinGap(undefined, NOW, 5)).toBe(false);
    expect(withinGap(NOW, NOW + 1, 0)).toBe(false);
    expect(withinGap(NOW, NOW + 1, undefined)).toBe(false);
  });
});

describe("gapEndsAt", () => {
  it("says when the trigger opens again, so the caller can come back then", () => {
    expect(gapEndsAt(NOW, 5)).toBe(NOW + 5 * MIN);
  });

  it("has no answer when nothing is waiting on a gap", () => {
    expect(gapEndsAt(undefined, 5)).toBeNull();
    expect(gapEndsAt(NOW, 0)).toBeNull();
  });
});

describe("coalesce", () => {
  const at = (id: string, scheduledFor: number, key = "webhook:a", prompt?: string) => ({
    id,
    key,
    scheduledFor,
    prompt,
  });

  it("puts the longest-waiting delivery in front and folds the rest into it", () => {
    const decision = coalesce([at("c", NOW + 200), at("a", NOW), at("b", NOW + 100)], "webhook:a");
    expect(decision?.run.id).toBe("a");
    expect(decision?.folded.map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  it("only ever folds one trigger's own deliveries", () => {
    const decision = coalesce(
      [at("a", NOW), at("other", NOW + 1, "webhook:b"), at("b", NOW + 2)],
      "webhook:a",
    );
    expect(decision?.folded.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("breaks a same-timestamp tie the same way every time", () => {
    const first = coalesce([at("b", NOW), at("a", NOW)], "webhook:a");
    const second = coalesce([at("a", NOW), at("b", NOW)], "webhook:a");
    expect(first?.run.id).toBe("a");
    expect(second?.run.id).toBe("a");
  });

  it("answers nothing when this trigger has nothing waiting", () => {
    expect(coalesce([at("a", NOW, "webhook:b")], "webhook:a")).toBeNull();
    expect(coalesce([], "webhook:a")).toBeNull();
  });
});

describe("foldPrompts", () => {
  const entry = (id: string, prompt?: string) => ({ id, key: "webhook:a", scheduledFor: NOW, prompt });

  it("leaves a single delivery's prompt exactly as it was", () => {
    expect(foldPrompts({ run: entry("a", "Handle the alert"), folded: [] })).toBe("Handle the alert");
  });

  it("says how many arrived rather than repeating one template six times", () => {
    const folded = foldPrompts({
      run: entry("a", "A check failed"),
      folded: [entry("b", "A check failed"), entry("c", "A check failed")],
    });
    expect(folded).toContain("A check failed");
    expect(folded).toContain("3 deliveries");
    // the template appears once, not three times
    expect(folded.split("A check failed").length - 1).toBe(1);
  });

  it("keeps genuinely different deliveries, numbered", () => {
    const folded = foldPrompts({
      run: entry("a", "Disk is full"),
      folded: [entry("b", "CPU is pegged")],
    });
    expect(folded).toContain("Disk is full");
    expect(folded).toContain("CPU is pegged");
    expect(folded).toContain("--- 1 ---");
    expect(folded).toContain("--- 2 ---");
  });

  it("ignores empty prompts instead of folding blank sections", () => {
    expect(foldPrompts({ run: entry("a", "Only this"), folded: [entry("b", "   "), entry("c")] })).toBe(
      "Only this",
    );
    expect(foldPrompts({ run: entry("a"), folded: [] })).toBe("");
  });
});
