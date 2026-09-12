# Local VM Lifecycle And Fleet Auto Consent

Bot deletion now respects an active shared/per-bot VM mode change before starting asynchronous cleanup.  The reverse order already refuses mode changes while deletion owns a target; the two operations must finish serially so cleanup cannot remove a replacement container or orphan an unnamed one.  Integration tests use an isolated harness and fake executables, never the installed container runtime.

The fleet Auto warning now names every bot that would newly receive unattended access to This Computer.  Confirmation submits the exact displayed IDs and names with the original defaults; a changed fleet returns a new confirmation before any grant or default is saved.  The server checks again after awaiting interrupted turns.  A legacy boolean alone cannot acknowledge a bulk grant, while the existing per-bot confirmation remains supported.

Typecheck, two consent tests, two renderer checks, and seven real bulk-default API tests passed.  The actual warning component was rendered with three synthetic bot names and captured in `docs/screenshots/fleet-auto-consent.png`; no production permissions were changed.  Full validation and the Local VM concurrency fixture remain pending.
