import { describe, expect, it } from "vitest";

import { replyAuthor, replySnippet } from "./replies";
import type { Message } from "@/state/store";

const base: Message = { id: "m1", at: 1, role: "bot", kind: "text", text: "hello" };

describe("reply display", () => {
  it("uses human labels and member attribution", () => {
    expect(replyAuthor({ ...base, role: "user" })).toBe("You");
    expect(replyAuthor({ ...base, from: { botId: "b", name: "Scout", color: "green" } })).toBe("Scout");
    expect(replyAuthor(base, "Mochi")).toBe("Mochi");
  });

  it("doesn't call a peer bot's ask_bot reply 'You' just because it's role: user", () => {
    // ask_bot replies are mirrored in with role: "user" so they align right
    // like anything else the human sees on that side — but they still carry
    // `from.botId`, and that's what should decide the label, not the role.
    expect(
      replyAuthor({ ...base, role: "user", from: { botId: "b", name: "Scout", color: "green" } }),
    ).toBe("Scout");
  });

  it("turns saved images into a readable bounded snippet", () => {
    expect(replySnippet('<attached-image path="/tmp/a.png" /> hi\nthere')).toBe("[image] hi there");
    expect(replySnippet("123456", 5)).toBe("1234…");
  });
});
