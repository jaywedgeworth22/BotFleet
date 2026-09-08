import { describe, expect, it } from "vitest";

import {
  FOREIGN_LOOPBACK_PORTS,
  foreignLoopbackOwner,
  formatListenInUse,
  isListenInUse,
} from "./harness-ports.ts";

describe("foreign loopback ports", () => {
  it("names the Mac services that often own 8791-8793", () => {
    expect(FOREIGN_LOOPBACK_PORTS).toEqual([8791, 8792, 8793]);
    expect(foreignLoopbackOwner(8791)).toBe("xcode-health");
    expect(foreignLoopbackOwner(8792)).toBe("mac-collab");
    expect(foreignLoopbackOwner(8793)).toBe("seat-mcp");
    expect(foreignLoopbackOwner(8799)).toBeNull();
    expect(foreignLoopbackOwner(8800)).toBeNull();
  });

  it("does not reserve 8791-8793 before a bind", () => {
    expect(formatListenInUse(8793, "harness")).toMatch(/already in use/);
    expect(formatListenInUse(8793, "harness")).toContain("seat-mcp");
    expect(formatListenInUse(8799, "harness")).toBe(
      "botfleet harness: 127.0.0.1:8799 is already in use",
    );
  });

  it("detects EADDRINUSE from a Node listen error", () => {
    expect(isListenInUse({ code: "EADDRINUSE" })).toBe(true);
    expect(isListenInUse(new Error("listen EADDRINUSE"))).toBe(false);
    expect(isListenInUse(null)).toBe(false);
  });
});
