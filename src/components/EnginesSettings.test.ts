import { describe, expect, it, vi } from "vitest";

import { createCustomEngine, deleteCustomEngine, type EngineCredentialDeps } from "./EnginesSettings";

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

  it("purges the encrypted store before deleting, so a same-named future engine cannot inherit the old key", async () => {
    const calls: string[] = [];
    const setInstanceCredential = vi.fn(async (instanceId: string, value: string) => {
      calls.push(`clear:${instanceId}:${JSON.stringify(value)}`);
    });
    const deleteInstance = vi.fn(async (instanceId: string) => {
      calls.push(`delete:${instanceId}`);
    });

    const result = await deleteCustomEngine(
      { createInstance: vi.fn(), deleteInstance, setInstanceCredential },
      "custom-reused-name",
    );

    expect(setInstanceCredential).toHaveBeenCalledWith("custom-reused-name", "");
    expect(calls).toEqual(['clear:custom-reused-name:""', "delete:custom-reused-name"]);
    expect(result).toEqual({ credentialClearError: null });
  });

  it("still deletes the instance when purging the stored credential fails, but reports the failure", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const setInstanceCredential = vi.fn().mockRejectedValue(new Error("The operating-system credential store is unavailable"));

    const result = await deleteCustomEngine(
      { createInstance: vi.fn(), deleteInstance, setInstanceCredential },
      "custom-y",
    );

    expect(deleteInstance).toHaveBeenCalledWith("custom-y");
    expect(result).toEqual({ credentialClearError: "The operating-system credential store is unavailable" });
  });
});
