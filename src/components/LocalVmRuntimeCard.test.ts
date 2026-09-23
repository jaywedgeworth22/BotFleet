import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("LocalVmRuntimeCard copy", () => {
  it("keeps two spaces between sentences in the Safety and Storage subtitle", () => {
    const source = readFileSync(new URL("./LocalVmRuntimeCard.tsx", import.meta.url), "utf8");
    const lines = source.split("\n").filter((line) => line.includes("Cua Driver operates only"));
    // One line each for the per-bot and shared-VM variants.
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toMatch(/[a-z0-9)]\. [A-Z]/);
    }
    expect(lines.join("\n")).toContain("desktop.  Every");
    expect(lines.join("\n")).toContain("replacement.  Viewers");
    expect(lines.join("\n")).toContain("container.  Each");
  });
});
