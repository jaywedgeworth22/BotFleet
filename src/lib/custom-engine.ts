// Async orchestration for adding/removing a user-defined OpenAI-compatible
// engine, factored out of src/components/EnginesSettings.tsx so it can be
// unit-tested without dragging in that component's tree — EnginesSettings
// imports ProviderMark (./ProviderIcons), which pulls in root-relative image
// assets (e.g. "/codex-mark.png") that vitest's Node-environment asset
// resolution mishandles cross-platform (a bare "file:///codex-mark.png" is a
// valid-looking POSIX path but an invalid Windows file URL, so importing the
// component tree at all broke the Windows CI job). None of that belongs
// anywhere near this file: it is plain async control flow with no React, no
// DOM, and no icons.

/** Dependencies createCustomEngine/deleteCustomEngine need, injected rather
 * than reached for directly (`api`, `window.ogb`) — this repo has no
 * component-render test harness (no React Testing Library), so the async
 * orchestration a bug actually lives in — not a pure value transform — is
 * pulled out where plain `vi.fn()` mocks can exercise it, the same way
 * `server/harness/registry.test.ts` injects a fake driver instead of a real
 * one. */
export type EngineCredentialDeps = {
  createInstance: (body: {
    name: string;
    endpoint: string;
    key?: string;
    models: string[];
    iconUrl?: string;
  }) => Promise<{ instanceId: string }>;
  deleteInstance: (instanceId: string) => Promise<unknown>;
  /** Absent entirely outside the desktop shell — the dev/browser fallback
   * never routes a key through the encrypted store. */
  setInstanceCredential?: (instanceId: string, value: string) => Promise<void>;
};

/** Create a custom engine, then — only when the encrypted-credential bridge
 * exists and a key was entered — hand that key to the encrypted store under
 * the id the server just minted. If that second step fails, the instance
 * that step one already created is deleted before the error propagates: a
 * half-created, keyless engine must not linger in the list (the normal path
 * never leaves one behind), and a retry must not mint a second "Engine-2"
 * alongside it. */
export async function createCustomEngine(
  deps: EngineCredentialDeps,
  input: { name: string; endpoint: string; key: string; models: string[]; iconUrl?: string },
): Promise<{ instanceId: string }> {
  const hasBridge = Boolean(deps.setInstanceCredential);
  const created = await deps.createInstance({
    name: input.name,
    endpoint: input.endpoint,
    key: hasBridge ? undefined : input.key || undefined,
    models: input.models,
    iconUrl: input.iconUrl,
  });
  if (hasBridge && input.key) {
    try {
      await deps.setInstanceCredential!(created.instanceId, input.key);
    } catch (credentialError) {
      await deps.deleteInstance(created.instanceId).catch(() => {});
      const reason = credentialError instanceof Error ? credentialError.message : String(credentialError);
      // NBSP, not two ASCII spaces — this renders straight into a plain
      // <div> in the modal, where white-space:normal collapses a run of
      // ordinary spaces to one (see server/secret-persistence.test.ts's
      // "renders its sentence gaps with NBSP" for the same rule elsewhere
      // in this app).
      throw new Error(`Could not save the encrypted key, so the new engine was removed.  ${reason}`);
    }
  }
  return created;
}

/** Delete a custom engine, purging the encrypted store's copy of its key
 * FIRST. Deleting the instance alone only clears the harness's live,
 * in-memory override — a later engine created with the exact same name
 * reuses the exact same slugged instance id, and without this the next
 * app launch's credential replay would hand THAT engine the deleted one's
 * bearer token, possibly against a different endpoint. A failed purge still
 * lets the delete proceed — the visible engine goes away either way — the
 * caller decides how to surface `credentialClearError`. */
export async function deleteCustomEngine(
  deps: EngineCredentialDeps,
  instanceId: string,
): Promise<{ credentialClearError: string | null }> {
  let credentialClearError: string | null = null;
  if (deps.setInstanceCredential) {
    try {
      await deps.setInstanceCredential(instanceId, "");
    } catch (e) {
      credentialClearError = e instanceof Error ? e.message : String(e);
    }
  }
  await deps.deleteInstance(instanceId);
  return { credentialClearError };
}
