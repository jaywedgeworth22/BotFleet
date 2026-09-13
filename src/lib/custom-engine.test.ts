import { describe, expect, it, vi } from "vitest";

import {
  ADD_ENGINE_DRIVERS,
  addEngineDriverOption,
  createCustomEngine,
  customEngineCalloutTitle,
  deleteCustomEngine,
  isCustomEngineInstance,
  validateAddEngine,
  type EngineCredentialDeps,
} from "./custom-engine";

describe("createCustomEngine", () => {
  it("never calls setInstanceCredential when there is no bridge (dev/browser fallback)", async () => {
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-ollama" });
    const deps: EngineCredentialDeps = {
      createInstance,
      deleteInstance: vi.fn(),
      // setInstanceCredential intentionally absent
    };

    const created = await createCustomEngine(deps, {
      name: "Ollama Local",
      endpoint: "http://localhost:11434/v1",
      key: "unused-without-a-bridge",
      models: ["llama3"],
    });

    expect(created).toEqual({ instanceId: "custom-ollama" });
    // The dev fallback still sends the plaintext key straight to the server.
    expect(createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ key: "unused-without-a-bridge" }),
    );
  });

  it("creates first, then hands the real instance id to the encrypted-credential bridge", async () => {
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-groq-2" });
    const setInstanceCredential = vi.fn().mockResolvedValue(undefined);
    const deps: EngineCredentialDeps = {
      createInstance,
      deleteInstance: vi.fn(),
      setInstanceCredential,
    };

    await createCustomEngine(deps, {
      name: "Groq",
      endpoint: "https://api.groq.com/openai/v1",
      key: "sk-groq-secret",
      models: ["llama-3.3-70b-versatile"],
    });

    // With the bridge present, the plaintext key never reaches the POST body.
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ key: undefined }));
    expect(setInstanceCredential).toHaveBeenCalledWith("custom-groq-2", "sk-groq-secret");
  });

  it("skips the bridge call entirely when no key was entered", async () => {
    const setInstanceCredential = vi.fn();
    const deps: EngineCredentialDeps = {
      createInstance: vi.fn().mockResolvedValue({ instanceId: "custom-keyless" }),
      deleteInstance: vi.fn(),
      setInstanceCredential,
    };

    await createCustomEngine(deps, {
      name: "Local LM Studio",
      endpoint: "http://localhost:1234/v1",
      key: "",
      models: ["local-model"],
    });

    expect(setInstanceCredential).not.toHaveBeenCalled();
  });

  it("rolls back the just-created instance and reports the failure when the credential save fails", async () => {
    // The exact bug the [BF-DESIGNER] review comment flagged: a half-created
    // keyless engine must not linger in the list, and a retry with the same
    // name must not mint a second "Engine-2" alongside it.
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-flaky" });
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const setInstanceCredential = vi.fn().mockRejectedValue(new Error("The operating-system credential store is unavailable"));
    const deps: EngineCredentialDeps = { createInstance, deleteInstance, setInstanceCredential };

    await expect(
      createCustomEngine(deps, {
        name: "Flaky Engine",
        endpoint: "https://example.test/v1",
        key: "sk-flaky",
        models: ["model-a"],
      }),
    ).rejects.toThrow(
      "Could not save the encrypted key, so the new engine was removed.  The operating-system credential store is unavailable",
    );

    expect(deleteInstance).toHaveBeenCalledWith("custom-flaky");
  });

  it("still rejects even if the rollback delete itself fails, without masking the original error", async () => {
    const deps: EngineCredentialDeps = {
      createInstance: vi.fn().mockResolvedValue({ instanceId: "custom-double-flaky" }),
      deleteInstance: vi.fn().mockRejectedValue(new Error("network down")),
      setInstanceCredential: vi.fn().mockRejectedValue(new Error("locked keychain")),
    };

    await expect(
      createCustomEngine(deps, {
        name: "Double Flaky",
        endpoint: "https://example.test/v1",
        key: "sk-x",
        models: ["model-a"],
      }),
    ).rejects.toThrow(/locked keychain/);
  });
});

describe("deleteCustomEngine", () => {
  it("deletes directly when there is no bridge, reporting no credential error", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const result = await deleteCustomEngine({ createInstance: vi.fn(), deleteInstance }, "custom-x");

    expect(deleteInstance).toHaveBeenCalledWith("custom-x");
    expect(result).toEqual({ credentialClearError: null });
  });

  it("deletes the instance BEFORE purging its encrypted key, not after", async () => {
    // The exact ordering bug a fresh review caught: purging first PATCHes
    // the live instance (setInstanceCredential's job), which reloads that
    // provider and settles any bot mid-turn on it as no-longer-busy —
    // silently defeating DELETE's own busy-bot guard. clearInstanceCredential
    // never touches the live harness at all, and must only run once the
    // delete has already gone through.
    const calls: string[] = [];
    const deleteInstance = vi.fn(async (instanceId: string) => {
      calls.push(`delete:${instanceId}`);
    });
    const clearInstanceCredential = vi.fn(async (instanceId: string) => {
      calls.push(`clear:${instanceId}`);
    });

    const result = await deleteCustomEngine(
      { createInstance: vi.fn(), deleteInstance, clearInstanceCredential },
      "custom-reused-name",
    );

    expect(clearInstanceCredential).toHaveBeenCalledWith("custom-reused-name");
    expect(calls).toEqual(["delete:custom-reused-name", "clear:custom-reused-name"]);
    expect(result).toEqual({ credentialClearError: null });
  });

  it("never purges the credential when the delete itself is refused (busy bot or no replacement)", async () => {
    // The other half of the same bug: if purge-then-delete deleted the
    // credential and THEN the route refused the delete (no replacement
    // engine available), the instance survived configured but keyless.
    // Delete-then-purge makes that structurally impossible — a rejected
    // delete must never reach the purge step at all.
    const deleteInstance = vi.fn().mockRejectedValue(new Error("cannot delete engine while a bot using it is working"));
    const clearInstanceCredential = vi.fn();

    await expect(
      deleteCustomEngine({ createInstance: vi.fn(), deleteInstance, clearInstanceCredential }, "custom-busy"),
    ).rejects.toThrow(/cannot delete engine/);

    expect(clearInstanceCredential).not.toHaveBeenCalled();
  });

  it("still reports success when there is no bridge — the dev fallback never wrote an encrypted key to purge", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const result = await deleteCustomEngine(
      { createInstance: vi.fn(), deleteInstance, clearInstanceCredential: undefined },
      "custom-dev-only",
    );
    expect(result).toEqual({ credentialClearError: null });
  });

  it("the delete having already succeeded, still reports it when purging the stored credential fails", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const clearInstanceCredential = vi.fn().mockRejectedValue(new Error("The operating-system credential store is unavailable"));

    const result = await deleteCustomEngine(
      { createInstance: vi.fn(), deleteInstance, clearInstanceCredential },
      "custom-y",
    );

    expect(deleteInstance).toHaveBeenCalledWith("custom-y");
    expect(result).toEqual({ credentialClearError: "The operating-system credential store is unavailable" });
  });
});

describe("the Add Engine form's driver choice", () => {
  it("omits the driver entirely for the route's own default", async () => {
    // An older client never sent one, and the body it did send has to keep
    // meaning exactly what it meant.
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-groq" });
    await createCustomEngine(
      { createInstance, deleteInstance: vi.fn() },
      { name: "Groq", endpoint: "https://api.groq.com/openai/v1", driver: "openai-compat", key: "", models: ["m"] },
    );
    expect(Object.hasOwn(createInstance.mock.calls[0][0], "driver")).toBe(false);
  });

  it("sends the driver for a second MiniMax connection", async () => {
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-minimax-china" });
    await createCustomEngine(
      { createInstance, deleteInstance: vi.fn() },
      { name: "MiniMax China", endpoint: "https://api.minimaxi.com/v1", driver: "minimax", key: "sk-cn", models: [] },
    );
    expect(createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ driver: "minimax", key: "sk-cn", models: [] }),
    );
  });

  it("asks for model IDs only where the driver has no catalog of its own", () => {
    expect(addEngineDriverOption("openai-compat").requiresModels).toBe(true);
    expect(addEngineDriverOption("minimax").requiresModels).toBe(false);
    // An unknown driver falls back to the first option rather than rendering
    // a form with no labels at all.
    expect(addEngineDriverOption("nonsense")).toBe(ADD_ENGINE_DRIVERS[0]);

    const base = { name: "Second MiniMax", endpoint: "https://api.minimaxi.com/v1" };
    expect(validateAddEngine({ ...base, driver: "minimax", models: [] })).toBeNull();
    expect(validateAddEngine({ ...base, driver: "openai-compat", models: [] })).toContain("model ID is required");
    expect(validateAddEngine({ ...base, driver: "minimax", models: [] , name: "" })).toBe("Engine name is required");
    expect(validateAddEngine({ ...base, driver: "minimax", models: [], endpoint: " " })).toBe("Endpoint URL is required");
    expect(
      validateAddEngine({ ...base, driver: "openai-compat", models: Array.from({ length: 16 }, (_, i) => `m${i}`) }),
    ).toContain("At most 15");
  });

  it("treats any instance other than a driver's reserved one as added by the operator", () => {
    expect(isCustomEngineInstance({ driverKind: "minimax", instanceId: "minimax" })).toBe(false);
    expect(isCustomEngineInstance({ driverKind: "minimax", instanceId: "custom-minimax-china" })).toBe(true);
    expect(isCustomEngineInstance({ driverKind: "openai-compat", instanceId: "openaiCompat" })).toBe(false);
    expect(isCustomEngineInstance({ driverKind: "openai-compat", instanceId: "custom-ollama" })).toBe(true);
    // A single-instance engine is never custom, whatever its id.
    expect(isCustomEngineInstance({ driverKind: "claudeAgent", instanceId: "claude" })).toBe(false);
    // The server's own flag still wins when it is set.
    expect(isCustomEngineInstance({ driverKind: "claudeAgent", instanceId: "claude", isCustom: true })).toBe(true);
  });

  it("names the engine the operator actually added in the row callout", () => {
    expect(customEngineCalloutTitle("minimax")).toBe("Added MiniMax Connection.");
    expect(customEngineCalloutTitle("openai-compat")).toBe("Custom OpenAI-Compatible Engine.");
  });
});
