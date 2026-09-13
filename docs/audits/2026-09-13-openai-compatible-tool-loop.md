# OpenAI-Compatible Tool Loop And Usage

The OpenAI-compatible engine now owns the complete model-to-tool loop, using the same bounded loop as MiniMax.  A user turn emits one terminal event, executes tool calls through the shared host and approval broker, and retains a stable transcript prefix between model rounds.  The obsolete harness executor and its 60-second listener timeout have been removed.

Streaming requests explicitly ask for usage.  Reported input, output, and cached-input tokens survive model rounds and an upstream streaming error; cached input remains a subset of input.  Upstream error frames fail the turn instead of completing successfully, and their private body is excluded from the new error message.  Direct Grok also requests streamed usage, sums reported usage once per retry attempt, retains cached tokens on failed streams, and fails unsupported tool calls truthfully.  Both API adapters use the same usage normalization; native diagnostics retain routing and size metadata rather than prompt/reply bodies.

## Validation

- 82 focused Grok, OpenAI-compatible, and shared-loop tests passed after the final usage changes.
- Three real-harness room checks passed for MiniMax, OpenAI-compatible, and direct Grok.
- An earlier overlapping run of OpenAI-compatible, Grok, and turn-tool tests passed 40 tests.
- Regression coverage checks one terminal event, approval routing, two-round usage totals, cached input, stream options, failed-stream usage, and credential isolation.
- `git diff --check` passed.  Local typecheck was stopped during sustained Mac load and is not a pass; the complete hosted typecheck and test matrix is required before opening the PR.
- No live provider request, subscription quota use, or Mac deployment is claimed by these fixture tests.
