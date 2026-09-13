import { describe, expect, it } from "vitest";

import {
  API_KEY_ENGINES,
  apiKeyEngineSpec,
  engineKeyStatus,
  splitEngineKeySave,
} from "./engine-key-config";

const minimax = apiKeyEngineSpec("minimax");
const openaiCompat = apiKeyEngineSpec("openaiCompat");

// Obviously fake, and never sent anywhere: these exist so the assertions have
// credential-shaped strings to work on.
const SENTINEL_KEY = "sentinel-engine-key-not-real";

describe("the API-key engine roster", () => {
  it("names a config section, a credential slot and two mapped fields for each engine", () => {
    // Every id here is an `AppConfig` section AND a `ConfigStatus` key, and
    // every credentialName is a slot electron/main.mjs's CREDENTIAL_PATCH
    // knows how to build a patch for. A drift on either side is a save that
    // silently goes nowhere.
    expect(API_KEY_ENGINES.map((engine) => engine.id)).toEqual(["openaiCompat", "minimax"]);
    for (const engine of API_KEY_ENGINES) {
      expect(engine.credentialName).toBe(`${engine.id}ApiKey`);
      expect(engine.keyFieldId).toBe(`${engine.id}.key`);
      expect(engine.urlFieldId).toBe(`${engine.id}.url`);
      expect(engine.label.trim()).toBe(engine.label);
      expect(engine.docsUrl.startsWith("https://")).toBe(true);
    }
    expect(() => apiKeyEngineSpec("nope" as "minimax")).toThrow();
  });
});

describe("engineKeyStatus", () => {
  it("keeps a key that is saved but not yet replayed distinct from one that was never set", () => {
    // Reporting the packaged-app replay gap as "Not set" invites the operator
    // to paste a key they have already saved.
    expect(engineKeyStatus({ configured: false, pending: true })).toEqual({
      label: "Waiting for this computer",
      tone: "waiting",
    });
    expect(engineKeyStatus({ configured: true, pending: false })).toEqual({ label: "Saved", tone: "ok" });
    expect(engineKeyStatus({ configured: false, pending: false })).toEqual({ label: "Not set", tone: "unset" });
    expect(engineKeyStatus(undefined)).toEqual({ label: "Not set", tone: "unset" });
    // Pending wins: the value is in the store, it simply is not live yet.
    expect(engineKeyStatus({ configured: true, pending: true }).label).toBe("Waiting for this computer");
  });
});

describe("splitEngineKeySave", () => {
  it("sends the key through the encrypted store and the endpoint over HTTP", () => {
    const result = splitEngineKeySave({
      engine: minimax,
      key: SENTINEL_KEY,
      url: "https://api.minimaxi.com/v1",
      savedUrl: "",
      hasBridge: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.save.bridgeSecret).toEqual({ name: "minimaxApiKey", value: SENTINEL_KEY });
    // The endpoint is configuration, not a credential — and `credential:set`
    // carries one secret field, so it could not travel that way regardless.
    expect(result.save.configPatch).toEqual({ minimax: { url: "https://api.minimaxi.com/v1" } });
    expect(JSON.stringify(result.save.configPatch)).not.toContain(SENTINEL_KEY);
  });

  it("falls back to the config patch when there is no desktop bridge", () => {
    const result = splitEngineKeySave({
      engine: openaiCompat,
      key: SENTINEL_KEY,
      url: "",
      savedUrl: "https://openrouter.ai/api/v1",
      hasBridge: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.save.bridgeSecret).toBeNull();
    expect(result.save.configPatch).toEqual({ openaiCompat: { url: "", key: SENTINEL_KEY } });
  });

  it("treats a blank key field as 'leave the saved key alone', never as a clear", () => {
    // /api/config never echoes a key back, so the field is blank on every
    // load. Sending "" here would wipe a saved key the moment somebody
    // changed only the endpoint beside it.
    for (const hasBridge of [true, false]) {
      const result = splitEngineKeySave({
        engine: minimax,
        key: "   ",
        url: "https://api.minimax.io/v1",
        savedUrl: "https://api.minimaxi.com/v1",
        hasBridge,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.save.bridgeSecret).toBeNull();
      expect(result.save.configPatch).toEqual({ minimax: { url: "https://api.minimax.io/v1" } });
      expect(Object.hasOwn(result.save.configPatch!.minimax, "key")).toBe(false);
    }
  });

  it("clears only on an explicit clear, through whichever half owns the value", () => {
    const withBridge = splitEngineKeySave({
      engine: minimax,
      key: "",
      url: "https://api.minimaxi.com/v1",
      savedUrl: "",
      hasBridge: true,
      clear: true,
    });
    expect(withBridge.ok).toBe(true);
    if (!withBridge.ok) return;
    // The store is where the value lives, so the clear goes there; the
    // handler deletes the entry and writes the same empty tombstone.
    expect(withBridge.save.bridgeSecret).toEqual({ name: "minimaxApiKey", value: "" });
    expect(Object.hasOwn(withBridge.save.configPatch!.minimax, "key")).toBe(false);

    const noBridge = splitEngineKeySave({
      engine: minimax,
      key: "",
      url: "",
      savedUrl: "",
      hasBridge: false,
      clear: true,
    });
    expect(noBridge.ok).toBe(true);
    if (!noBridge.ok) return;
    expect(noBridge.save.bridgeSecret).toBeNull();
    // Endpoint unchanged, so it stays out of the patch entirely.
    expect(noBridge.save.configPatch).toEqual({ minimax: { key: "" } });
  });

  it("refuses an endpoint that is not an absolute http(s) URL, and one carrying credentials", () => {
    for (const url of ["api.minimax.io/v1", "ftp://api.minimax.io/v1", "https://user:pw@api.minimax.io/v1"]) {
      const result = splitEngineKeySave({ engine: minimax, key: "", url, savedUrl: "", hasBridge: true });
      expect(result.ok, url).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("absolute http");
    }
    // An empty endpoint is the documented "use the driver's own default".
    expect(splitEngineKeySave({ engine: minimax, key: "", url: "", savedUrl: "", hasBridge: true }).ok).toBe(true);
  });

  it("never builds a patch touching a section other than the row's own", () => {
    const result = splitEngineKeySave({
      engine: openaiCompat,
      key: SENTINEL_KEY,
      url: "https://openrouter.ai/api/v1",
      savedUrl: "",
      hasBridge: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.save.configPatch!)).toEqual(["openaiCompat"]);
  });
});

describe("an endpoint that did not change", () => {
  it("stays out of the patch, so a key-only save cannot 409 on a vault-managed URL", () => {
    // `<engine>.url` is a mapped SECRET_FIELDS row, so with the vault
    // managing it and Write Through off, /api/config refuses ANY save that
    // names it — including one that resends the vault's own value unchanged.
    const result = splitEngineKeySave({
      engine: minimax,
      key: SENTINEL_KEY,
      url: "  https://api.minimaxi.com/v1  ",
      savedUrl: "https://api.minimaxi.com/v1",
      hasBridge: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.save.configPatch).toEqual({ minimax: { key: SENTINEL_KEY } });
  });

  it("leaves nothing at all to send when only the key moves through the bridge", () => {
    const result = splitEngineKeySave({
      engine: minimax,
      key: SENTINEL_KEY,
      url: "https://api.minimax.io/v1",
      savedUrl: "https://api.minimax.io/v1",
      hasBridge: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.save.configPatch).toBeNull();
    expect(result.save.bridgeSecret).toEqual({ name: "minimaxApiKey", value: SENTINEL_KEY });
  });
});
