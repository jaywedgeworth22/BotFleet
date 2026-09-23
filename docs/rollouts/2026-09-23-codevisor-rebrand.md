# 2026-09-23 — Code-visor rebrand: new logo across app icons, site, and docs chrome

Seat: INSTINCT.  Branch `instinct/codevisor-rebrand`.

## Why

Owner picked the mint code-visor robot as the new BotFleet mark ("change the logo everywhere") and supplied the final art: light and dark icon tiles (1024), light and dark wordmark lockups with the `</>` visor glyph, and a cleaned-up fleet-at-a-console hero.  The light tile is the default app icon/favicon; the dark variants have no dark-mode placement in the code today, so they are not committed.

## What landed

- Web app favicons: `public/favicon-64.png`, `public/app-icon.png`, `public/app-icon.svg` (embedded-PNG SVG, same pattern as before) — light code-visor tile.
- Desktop: `build/icon-1024.png`, `build/icon.iconset/*` (all 12 sizes regenerated), `build/icon.icns` (repacked), `build/icon.ico` (16–256 multi-size), Linux `build/icon.svg`, and `electron/resources/app-icon.png` (tray/dock) — light tile.
- iOS: `AppIcon.appiconset/icon-1024.png` — light tile, RGB 24-bit (App Store forbids alpha).  `DynamicIslandIcon.imageset` (1x/2x/3x) — robot glyph on white.
- Site (`apps/site`): `logo-256.png` (header), `favicon-64.png`, `apple-touch-icon.png`, `icon-1024.png` (og:image) — light tile.  `icon-transparent-1024.png` — transparent robot mark keyed from the light tile.  `hero-bots.png` — the new fleet-at-a-console hero.  `wide-banner.png` — light wordmark lockup; `wide-banner-transparent.png` — keyed transparent lockup.
- Site hero `alt` text updated in `template.html` and `index.html`; `apps/site/README.md` asset bullets updated.

## Not changed

- GitHub social preview: a repo-settings image, not a file.  Still shows the old trio art — update in repo settings with the new hero (1200x630 crop) if wanted.
- Dark icon tile / dark lockup: no dark-mode asset placement exists in the code (favicons and app icons are single-asset).
- `docs/screenshots/*` and `ios/AppStore/screenshots/*`: historical captures, not logo placements.
- Provider marks (`public/*-mark.*`, `ios/**/ProviderMark*`) belong to bot providers, not BotFleet.

## Verification

Every committed binary was byte-verified against the generated source after push (sha256 over `raw.githubusercontent.com` branch URLs).  iOS icon corners are opaque (full-bleed square, not a pre-baked squircle).  Favicon legibility was checked at 64px.
