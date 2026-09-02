import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeDraftAttachmentUpdates } from "./drafts";

describe("draft attachment live updates", () => {
  const target = new EventTarget();

  beforeEach(() => {
    vi.stubGlobal("addEventListener", target.addEventListener.bind(target));
    vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target));
    vi.stubGlobal("dispatchEvent", target.dispatchEvent.bind(target));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes the window listener on unsubscribe", () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("addEventListener", add);
    vi.stubGlobal("removeEventListener", remove);

    const unsubscribe = subscribeDraftAttachmentUpdates("bot:one", vi.fn());
    expect(add).toHaveBeenCalledWith("omb-draft-attachments-updated", expect.any(Function));

    unsubscribe();
    expect(remove).toHaveBeenCalledWith("omb-draft-attachments-updated", expect.any(Function));
  });

  it("notifies only the matching conversation id", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeDraftAttachmentUpdates("bot:one", onChange);

    target.dispatchEvent(
      new CustomEvent("omb-draft-attachments-updated", { detail: { id: "bot:other" } }),
    );
    expect(onChange).not.toHaveBeenCalled();

    target.dispatchEvent(
      new CustomEvent("omb-draft-attachments-updated", { detail: { id: "bot:one" } }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
