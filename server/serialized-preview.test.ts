import { describe, expect, it } from "vitest";

import { serializedPreview } from "./serialized-preview.ts";

const serializedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8") - 2;

describe("serializedPreview", () => {
  it("keeps ASCII at the same 160-character cut as before", () => {
    const text = "x".repeat(2_000);
    expect(serializedPreview(text, 160)).toEqual({ preview: "x".repeat(160), truncated: true });
    expect(serializedPreview("short", 160)).toEqual({ preview: "short", truncated: false });
  });

  it("bounds CJK and NUL-heavy text by serialized size", () => {
    for (const text of ["漢".repeat(2_000), "\u0000".repeat(2_000), "\"\\".repeat(2_000)]) {
      const { preview, truncated } = serializedPreview(text, 160);
      expect(truncated).toBe(true);
      expect(serializedBytes(preview)).toBeLessThanOrEqual(160);
      expect(preview.length).toBeGreaterThan(0);
    }
  });

  it("never splits an emoji surrogate pair at the boundary", () => {
    const text = "a" + "😀".repeat(100);
    const { preview } = serializedPreview(text, 160);
    expect(preview).toBe("a" + "😀".repeat(39));
    expect(/[\uD800-\uDBFF]$/.test(preview)).toBe(false);
  });

  it("keeps 100 worst-case previews under the 50 KB list target", () => {
    const worst = serializedPreview("\u0000".repeat(2_000), 160).preview;
    expect(Buffer.byteLength(JSON.stringify(Array(100).fill({ instructionsPreview: worst })), "utf8")).toBeLessThan(50_000);
  });
});
