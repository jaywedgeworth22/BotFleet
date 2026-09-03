// The profile patch parser is the boundary that keeps paired clients from
// writing anything but identity fields. The strict half is the one that
// matters: a privileged bot field arriving here must be refused by NAME,
// so a future field cannot silently become remotely writable.
import { describe, expect, it } from "vitest";

import { parseBotProfilePatch } from "./bot-profile.ts";

describe("parseBotProfilePatch (strict — the paired boundary)", () => {
  it("refuses unknown keys — strict means the allowlist IS the contract", () => {
    const result = parseBotProfilePatch({ color: "red" } as never, true);
    expect(result).toEqual({ ok: false, error: "unsupported profile field: color" });
    const result2 = parseBotProfilePatch({ unknownProperty: true } as never, true);
    expect(result2).toEqual({ ok: false, error: "unsupported profile field: unknownProperty" });
  });

  it("accepts the full identity and configuration surface", () => {
    const result = parseBotProfilePatch(
      {
        name: "Mira",
        title: "Lead",
        description: "plans",
        notifications: true,
        voice: "vx",
        speakReplies: false,
        chiefOfStaff: true,
        autoApprove: true,
        autoReview: "shadow",
        composio: true,
        cloudBackend: "box",
        cwd: "/Users/test/Code",
      },
      true,
    );
    expect(result).toEqual({
      ok: true,
      patch: {
        name: "Mira",
        title: "Lead",
        description: "plans",
        notifications: true,
        voice: "vx",
        speakReplies: false,
        chiefOfStaff: true,
        autoApprove: true,
        autoReview: "shadow",
        composio: true,
        cloudBackend: "box",
        cwd: "/Users/test/Code",
      },
    });
  });
});

describe("parseBotProfilePatch (both modes)", () => {
  it("lenient mode drops unknown keys instead of failing — the desktop PATCH mixes fields", () => {
    const result = parseBotProfilePatch({ name: "Mira", color: "red" } as never, false);
    expect(result).toEqual({ ok: true, patch: { name: "Mira" } });
  });

  it("rejects a blank or oversized name", () => {
    expect(parseBotProfilePatch({ name: "   " }, true).ok).toBe(false);
    expect(parseBotProfilePatch({ name: "x".repeat(101) }, true).ok).toBe(false);
  });

  it("only stored-attachment avatar URLs pass; clears normalize to undefined", () => {
    for (const bad of ["https://example.com/a.png", "data:image/png;base64,AAAA", "/api/attachments/../config.json", "/api/attachments/a.svg"]) {
      expect(parseBotProfilePatch({ avatarUrl: bad } as never, true).ok, bad).toBe(false);
    }
    const cleared = parseBotProfilePatch({ avatarUrl: "" }, true);
    expect(cleared).toEqual({ ok: true, patch: { avatarUrl: undefined } });
    const nulled = parseBotProfilePatch({ avatarUrl: null }, true);
    expect(nulled).toEqual({ ok: true, patch: { avatarUrl: undefined } });
  });

  it("maps an avatarCrop issue to the readable message", () => {
    expect(parseBotProfilePatch({ avatarCrop: "hexagon" } as never, true)).toEqual({
      ok: false,
      error: "avatarCrop must be mascot, circle, rounded, or square",
    });
  });
});
