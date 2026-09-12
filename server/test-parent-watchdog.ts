// Self-preservation for a harness process spawned by the test suite.
//
// A vitest worker that gets SIGKILLed (the timeout-under-load scenario that
// left six ~4.4 GB harness processes running with parent pid 1 on 2026-09-12,
// after their worker died mid-suite) never runs another line of JS on the
// way out, so nothing ever signals this process — its own `afterAll`,
// `waitForExit`, and the process-`exit` guard in server/testing/cleanup.ts
// are all just as dead as the worker. The only way this process can still
// die with its test is to notice its parent is gone and act on its own.
//
// Gated by the caller on the BOTFLEET_TEST_CHILD marker (see
// server/testing/cleanup.ts's spawnDetached): the always-on launchd harness
// (com.jay.botfleet-server) never sets it, so this module changes nothing
// about production behavior, where the parent legitimately is launchd for
// the whole life of the process.

/** How often to check in production. `process.ppid` is a cached field read,
 * not a syscall, so this can afford to be frequent without measurable cost. */
const DEFAULT_CHECK_INTERVAL_MS = 2_000;

/**
 * Poll `process.ppid` against the pid recorded at spawn time and call
 * `onOrphaned` the moment it changes — a reparent to launchd/init (pid 1 on
 * this Mac) is the observable proof the original parent is gone, whether it
 * exited cleanly or was SIGKILLed outright.
 *
 * Returns the interval so a caller that wants to stop watching (tests do)
 * can `clearInterval` it. Production never needs to: the process either
 * notices its parent died, or is asked to stop by that same parent first.
 */
export function installTestParentWatchdog(
  parentPidAtBoot: number,
  onOrphaned: () => void,
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (process.ppid !== parentPidAtBoot) onOrphaned();
  }, intervalMs);
  timer.unref?.();
  return timer;
}
