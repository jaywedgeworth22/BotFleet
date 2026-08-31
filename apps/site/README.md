# botfleet-site

The marketing / status site for **[BotFleet.app](https://botfleet.app)**.  A static page listing the add-on features BotFleet has added on top of upstream [OpenMausBot](https://github.com/milind-soni/OpenMausBot), badged **Beta** or **Established** by how far along each one is.

## Stack

Plain static HTML/CSS (no build step), hosted on Vercel.  DNS is a Cloudflare zone (`botfleet.app`) on the Usage.Jays.Services account; the registrar is Namecheap with nameservers pointed at Cloudflare.

- `features.json` — the feature list (the only file to edit for content changes).
- `template.html` + `build.mjs` — render `index.html` from the data.
- `sync-status.mjs` — refreshes each card's PR state from GitHub and reports merged-but-unlisted PRs and promotion candidates; it never moves a card between sections on its own.
- `logo-256.png` / `icon-1024.png` / `apple-touch-icon.png` / `favicon-64.png` — BotFleet brand assets (from the BotFleet repo's `build/` icons).
- `vercel.json` — clean URLs.
- `.github/workflows/deploy.yml` — every push to `main` builds and deploys to Vercel; a daily run also syncs PR states.

## Updating the feature list

Edit `features.json`, run `node build.mjs`, commit, push — the Action deploys.  Rules:

- Feature statuses: `Established` = merged to BotFleet `main` or deployed and verified; `Beta` = shipped in a branch or open PR.  The builder hides any section with zero features (owner rule for Established).
- `node sync-status.mjs` after PRs merge; it updates states in `features.json` and prints promotion candidates — moving a card to Established stays a judgment call.
- Owner copy rules apply: two spaces between sentences (`&nbsp; ` in HTML strings so the gap survives rendering), Title Case headings, light theme.
- No internal agent seat names on the public site.
- The bot roster is an example fleet, not a product claim — keep it framed that way.

Manual deploy fallback: `vercel deploy --prod` from the repo root (project `botfleet-site`).

## Coordination

Fleet coordination happens on THE BOARD and #agent-sync per `/Users/jay/apps/AGENT-SYNC.md`.  This repo mirrors its effort rows in `docs/EFFORT-LOG.md`.
