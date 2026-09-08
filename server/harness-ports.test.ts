import { describe, expect, it } from "vitest";

import {
  assertHarnessListenPort,
  FOREIGN_LOOPBACK_PORTS,
  foreignLoopbackOwner,
  formatListenInUse,
} from "./harness-ports.ts";

describe("foreign loopback ports", () => {
  it("names the Mac services that own 8791-8793", () => {
    expect(FOREIGN_LOOPBACK_PORTS).toEqual([8791, 8792, 8793]);
    expect(foreignLoopbackOwner(8791)).toBe("xcode-health");
    expect(foreignLoopbackOwner(8792)).toBe("mac-collab");
    expect(foreignLoopbackOwner(8793)).toBe("seat-mcp");
    expect(foreignLoopbackOwner(8799)).toBeNull();
    expect(foreignLoopbackOwner(8800)).toBeNull();
  });

  it("refuses to bind seat-mcp's port even when the env asks", () => {
    expect(() => assertHarnessListenPort(8793, "harness")).toThrow(/seat-mcp/);
    expect(() => assertHarnessListenPort(8799, "harness")).not.toThrow();
  });

  it("explains EADDRINUSE without sending the operator to lsof first", () => {
    expect(formatListenInUse(8793, "harness")).toContain("seat-mcp");
    expect(formatListenInUse(8799, "harness")).toContain("already in use");
  });
});
