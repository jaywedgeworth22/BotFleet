import { describe, expect, it } from "vitest";

import {
  qdrantLastSuccessLabel,
  qdrantRouteLabel,
  qdrantStateLabel,
  settleQdrantSave,
  settleQdrantSaveWithStatusFence,
} from "./qdrant-status";

describe("Qdrant RAG status copy", () => {
  it("uses the server-selected route and last successful check", () => {
    const status = {
      ready: false,
      source: "recall-service" as const,
      checkedAt: Date.UTC(2026, 8, 12, 10),
      lastSuccessAt: Date.UTC(2026, 8, 12, 9, 30),
    };

    expect(qdrantRouteLabel(status, "")).toBe("Recall service");
    expect(qdrantStateLabel(status)).toBe("Needs attention");
    expect(qdrantLastSuccessLabel(status)).not.toBe("None recorded");
  });

  it("remains useful with the old status payload", () => {
    expect(qdrantRouteLabel({ ready: true }, "")).toBe("This Mac's recall CLI");
    expect(qdrantRouteLabel({ ready: true }, "https://recall.example.test")).toBe("Recall service");
    expect(qdrantLastSuccessLabel({ ready: true })).toBe("None recorded");
    expect(qdrantStateLabel({ ready: true })).toBe("Ready");
  });

  it("turns a rejected save into visible local failure state", async () => {
    await expect(settleQdrantSave(async () => { throw new Error("settings are locked"); })).resolves.toEqual({
      ok: false,
      error: "settings are locked",
    });
  });

  it("does not clear a connection result started while a field save is pending", async () => {
    let finishSave!: (value: string) => void;
    const save = new Promise<string>((resolve) => {
      finishSave = resolve;
    });
    let testRevision = 0;
    const result = settleQdrantSaveWithStatusFence(() => save, testRevision, () => testRevision);

    testRevision += 1;
    finishSave("saved");

    await expect(result).resolves.toEqual({ ok: true, value: "saved", clearTestResult: false });
  });
});
