---
name: sentence-gap
description: >-
  Always put a visibly wider gap between sentences in every human-readable reply and file. Applies on every turn — Cursor desktop, Cursor cloud, CLI, Grok, chat, commits, PRs, and docs. Follows Monet's portable protocol: literal &nbsp; plus a space in Markdown chat UIs; two ASCII spaces in files. Never type a raw U+00A0 in chat. Use whenever writing any prose a human will read.
---

# Sentence gap (portable — always on)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Source of truth: `/Users/jay/Code/ai-fleet-coordinator/docs/SENTENCE-GAP-PORTABLE-SKILL.md`

The block below is Monet's protocol, pasted verbatim. Follow it exactly. Do not weaken it. Cloud agents without the Mac filesystem still have the full protocol in this file.

### Rule: two visible spaces between sentences

Put a **visibly wider gap** between sentences — after `.` `!` `?` when a new sentence
follows — in every piece of prose a human reads.  Not just product copy: chat replies,
commit messages, PR titles and bodies, code comments, docs, tickets, Slack posts, release
notes, design docs.

Do **not** add a gap after a non-terminal abbreviation (`e.g.`, `i.e.`, `Dr.`, `v1.2.3`),
inside a URL, email, filename, or a brand name containing a period.

### The catch that wastes everyone's time

**Typing two literal spaces usually does nothing visible.**  HTML and most Markdown
renderers collapse runs of whitespace to a single space.  So the assistant "complies,"
the raw text really does contain two spaces, and the human still sees one.  Both sides
then argue about whether the instruction was followed.

**The gap must survive the renderer between you and the reader.**  Which mechanism works
depends on the surface, so pick by destination:

| Destination | Use | Why |
|---|---|---|
| **Chat / transcript UI that renders Markdown** | the literal entity text `&nbsp;` then a normal space → `End.&nbsp; Next.` | The renderer expands the entity into a real non-breaking space, so the gap is visible |
| **Plain-text chat (no Markdown rendering)** | two literal ASCII spaces | Nothing collapses them; an entity would show as the ugly text `&nbsp;` |
| **Files read as source** — repo docs, commit messages, code comments, config, diffs | two literal ASCII spaces | Read in an editor/terminal/`git diff`, which preserve them verbatim; an entity would appear literally |
| **HTML / JSX / SwiftUI / any rendered product copy** | `&nbsp;&#32;`, `{"  "}`, `  `, or a shared `SENTENCE_GAP` constant | Raw double spaces collapse in HTML |
| **Markdown source** | two literal spaces *between* sentences | ⚠️ Two spaces at the **end of a line** is the unrelated hard-line-break syntax — don't confuse the two |

### Verify, don't assume — run this self-test once per platform

The table above is a starting point, not gospel: renderers differ and change.  **On your
first run in a new tool, test it and ask the human what they actually see.**

> Output these two lines verbatim, then ask which shows a wider gap:
>
> A. `Sentence one.&nbsp; Sentence two.`
> B. `Sentence one.  Sentence two.`
>
> If A looks wider → use the `&nbsp;` entity on this surface.
> If B looks wider, or they look identical → use two literal spaces.
> If neither shows a gap → say so plainly and ask how they want it handled.
> Then keep using whichever won, for that surface, for the rest of the session.

### Already tested — do NOT burn time re-trying these

Verified on Claude Code (terminal + desktop), 2026-08-19/20:

- ❌ **Two literal ASCII spaces in chat** — collapsed by the Markdown renderer.  Invisible.
- ❌ **A raw U+00A0 character typed directly into chat** — normalized away in the
  transcript view.  **Especially deceptive: copy-pasting the reply out can still show two
  spaces, so it looks fixed when the human still sees one.**  Do not trust copy-paste as
  proof.
- ❌ **App/output settings** — no toggle governs inter-sentence spacing.  Output-style
  settings change tone only; headless output-format flags don't apply to interactive chat;
  screen-reader modes only drop borders.
- ❌ **Patching the client** — compiled and signed; breaks code signing and is wiped by
  auto-update.  Never attempt.
- ✅ **The literal entity text `&nbsp;` + a space in chat** — renders as a visibly wider
  gap.  This is the one that worked.
- ✅ **Two literal ASCII spaces in files** — correct and simplest; leave file content alone.

### The transferable lesson

When an instruction *appears* not to take effect, **stop repeating the promise and
diagnose the rendering layer between you and the reader** — then ask them what is on their
screen.  Four rounds of "fixed it!" were spent here before anyone checked whether the
change could be seen at all.  Intent is not output; output is not what is displayed.
