# Safe Mac Updater

Issue #319 replaces the machine-only update script with a tracked, tested transaction.  The updater remains an on-demand helper; it does not create a daemon, timer, or background process.

## Transaction

`scripts/update-botfleet.sh` launches `scripts/update-botfleet-mac.mjs` from the detached always-on checkout.  The implementation has four commands:

```sh
# Compose both phases for an ordinary update from current origin/main.
scripts/update-botfleet.sh update

# Build once in an isolated, already-provisioned staging checkout.
scripts/update-botfleet.sh prepare \
  --target <full-main-commit> \
  --source /absolute/path/to/staging-checkout \
  --stage /absolute/path/to/stage

# Import an existing build and dependency tree from that exact clean source.
scripts/update-botfleet.sh prepare \
  --target <full-main-commit> \
  --source /absolute/path/to/staging-checkout \
  --bundle /absolute/path/to/staging-checkout/release/mac-arm64/BotFleet.app \
  --dependencies /absolute/path/to/staging-checkout/node_modules \
  --stage /absolute/path/to/stage

# Apply the immutable stage after reviewing its prepared.json receipt.
scripts/update-botfleet.sh apply --stage /absolute/path/to/stage

# Recover admission if an interrupted updater fenced the harness but did not stop it.
scripts/update-botfleet.sh unquiesce
```

`prepare` fetches and pins a commit reachable from `origin/main`, requires a private stage and a clean staging checkout distinct from the live checkout, installs the frozen lockfile, and packages with the stable Developer ID identity.  The optional import form avoids rebuilding an existing artifact from that exact source and requires its dependency tree at the same time.  Both forms verify the code signature, Team ID, bundle ID, generated `Contents/Resources/server/build-identity.json`, and dependency fingerprint.  A dirty, mislabeled, symlinked, or publicly writable stage is rejected.  The command persists the signed application and exact staged `node_modules` tree before releasing a disposable worktree.

`apply` verifies the stage again, then checks runtime readiness twice: once before materializing same-volume candidates and again immediately before the interruption boundary.  The current runtime authenticates `/api/runtime` with the private data-owner nonce and must report its own clean exact source commit, zero active work, and the same single PID as the health endpoints and SQLite handles.  It then atomically fences main API mutations, webhook deliveries, direct turns, routines, and resource triggers before shutdown.  Mutations and webhook bodies already in flight hold an admission count, so the fence refuses until they finish; scheduled work is paused without deleting its durable queue.  The updater rechecks the process, port, and SQLite owner while the fence is held.  Any failed post-fence check releases admission automatically; `unquiesce` provides an authenticated recovery action if the updater itself is interrupted.  The replacement must report the staged source commit, version, API version, and UI identity after startup.  A legacy runtime without the complete readiness contract is refused; its one-time adoption remains a manually supervised rollout with separately recorded idle and process evidence.

At the boundary, the helper bootouts the launchd service to suppress KeepAlive, asks the application to quit, waits, and sends `SIGTERM` only to exact BotFleet processes that were verified before the boundary.  It never uses `SIGKILL`, process-name-wide termination, or Finder, Dock, System Settings, or icon-cache cleanup.  It refuses to continue while a process or database holder remains.

The live checkout, application bundle, and dependency tree move only after staging and quiescence succeed.  Same-volume renames retain the prior bundle and dependency tree while the checkout retains the prior commit.  Startup must prove the exact expected runtime and one data owner before the transaction succeeds.  Before rollback interrupts a failed replacement, the updater re-proves complete authenticated idle state.  If work began during startup verification or readiness is unknown, it leaves the replacement and every prior recovery copy intact, writes `pending-recovery.json` in the private stage, and exits unsuccessfully for supervised recovery after the work drains.  Otherwise, a checkout, copy, launchd, startup, identity, or attachment failure restores the prior bundle, dependency tree, and checkout and restarts only the components that were running before the attempt.

The desktop keeps the local update in `installing` state while its detached process runs.  At two minutes and again after one hour it reports progress without claiming failure or suggesting a concurrent retry; only a child-process error or nonzero exit marks the update failed.

## Rollout Ownership

This source change does not execute the updater or touch `/Applications/BotFleet.app`, `/Users/jay/apps/botfleet-server`, launchd, or a live BotFleet process.  After merge, the Mac rollout owner must install the wrapper at `/Users/jay/apps/update-botfleet.sh`, update the on-demand helper row in `/Users/jay/apps/MAC-LOCAL-PROCESSES.md`, and refresh the pinned `Background Jobs Master List` Coding note as one deployment change before the new helper is runnable.  The staged rollout may proceed only after active work is clear.

Signed release/feed acceptance remains separate from this local on-demand update transaction.
