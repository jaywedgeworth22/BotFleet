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
  /** Purge the encrypted store's copy of an instance's key WITHOUT touching
   * the live harness — deleteCustomEngine's own concern, and deliberately a
   * different operation from setInstanceCredential(id, ""): that one PATCHes
   * the live instance (which no longer exists once the engine is deleted,
   * and reloads the provider if it still does — see deleteCustomEngine's own
   * comment on why that ordering was the bug). Absent outside the desktop
   * shell, same as setInstanceCredential — the dev fallback never wrote to
   * the encrypted store in the first place, so there is nothing to purge. */
  clearInstanceCredential?: (instanceId: string) => Promise<void>;
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

/** Delete a custom engine, THEN purge the encrypted store's copy of its key.
 *
 * Delete first, not purge first: an earlier version purged first, on the
 * theory that a later engine reusing the same name (same slug, same
 * instance id) must never have the deleted one's key replayed into it. That
 * is true, but purging first defeated a DIFFERENT safety check instead —
 * clearing a packaged instance's key PATCHes the live harness
 * (?secretStorage=external), which reloads that provider and settles any
 * bot currently mid-turn on it as no-longer-busy. The DELETE route's own
 * 409 guard ("cannot delete engine while a bot using it is working") reads
 * that same busy flag, so purging first silently defeated it — and if the
 * route then refused the delete anyway (no replacement engine available),
 * the instance was left configured with its key already gone.
 *
 * Deleting first lets the route's busy-bot and no-replacement guards see
 * accurate state and run first, exactly as if no credential existed.  Only
 * once the delete has actually succeeded does the key get purged — the
 * server's own delete handler already drops the live, in-memory override at
 * that point; this purges the encrypted store's copy so a same-named future
 * engine cannot inherit it, matching the same intent the earlier ordering
 * was reaching for. A failed purge is surfaced but does not undo the
 * delete — the visible engine is already gone either way. */
export async function deleteCustomEngine(
  deps: EngineCredentialDeps,
  instanceId: string,
): Promise<{ credentialClearError: string | null }> {
  await deps.deleteInstance(instanceId);
  let credentialClearError: string | null = null;
  if (deps.clearInstanceCredential) {
    try {
      await deps.clearInstanceCredential(instanceId);
    } catch (e) {
      credentialClearError = e instanceof Error ? e.message : String(e);
    }
  }
  return { credentialClearError };
}
