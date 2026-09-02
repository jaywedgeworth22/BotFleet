# Releasing

One workflow builds everything: **Actions → Release → Run workflow**.  It
builds macOS (arm64 + x64, signed, notarized, stapled), Windows, and Ubuntu
from a single pinned commit, verifies every artifact the way a user would
receive it, assembles a complete draft on
[jaywedgeworth22/botfleet-releases](https://github.com/jaywedgeworth22/botfleet-releases),
and — if you ticked **publish** — flips it live.
Leave publish unticked to review the draft notes first, then publish from the
GitHub UI.

There is exactly one publish target.  `electron-builder.yml` `publish` names
`jaywedgeworth22/botfleet-releases`, which electron-builder bakes into every
packaged app's `app-update.yml`; `release.yml` uploads to the same repository
through its `RELEASES_REPO` variable.  Keep the two in step, or installed apps
check a feed no release ever lands on.  The releases repo is public and
separate from the source repo so no token ever reaches a user's machine.
Nothing under `milind-soni/*` is ours to publish to.

The workflow refuses to overwrite an already-published version, so the only
prerequisite per release is that `package.json`'s version is bumped on the
ref you run it against.

## What Auto-Update Needs on the Release

electron-updater reads a feed file, not the DMG:

- **macOS:** `latest-mac.yml` plus the `BotFleet-<version>-arm64.zip` and
  `BotFleet-<version>-x64.zip` it lists (and their `.blockmap` files).
  The DMGs are for humans; the updater downloads the zips.
- **Windows:** `latest.yml` plus `BotFleet-<version>-setup.exe` and its
  `.blockmap`.
- **Ubuntu:** `latest-linux.yml` plus the AppImage.

A release that carries only DMGs, as
[`v0.1.38`](https://github.com/jaywedgeworth22/botfleet-releases/releases/tag/v0.1.38)
does today, cannot be found by any installed app: **Check for updates** fails
on every platform.  Until the
workflow runs green, the fix is manual: run `pnpm package:mac` locally,
notarize and staple, regenerate the feed with
`node scripts/regenerate-mac-feed.mjs`, and upload `latest-mac.yml`, both
zips, and both blockmaps to the `v0.1.38` release.  Never hand-edit or carry
forward a feed file; it pins sha512 hashes of the exact bytes on the release.

## Why the Gates Exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft.  Don't remove a gate without reading the comment
above it.

## One-Time Setup: Four Secrets

Set these in **BotFleet → Settings → Secrets and variables → Actions**.  Only
the repository owner does this; agents never handle these values.

### 1. `MAC_CERT_P12_BASE64` + `MAC_CERT_PASSWORD`

The Developer ID Application certificate for team **CC8UTF7ATG**, which is the
identity `electron-builder.yml` pins
(`Developer ID Application: Jay Wedgeworth, LLC (CC8UTF7ATG)`).  A certificate
from any other team fails the pinned identity even if it imports cleanly.
Export it from the Mac that currently signs releases:

```sh
# Keychain Access → My Certificates → "Developer ID Application: Jay
# Wedgeworth, LLC (CC8UTF7ATG)" → right-click → Export… → .p12 with a strong
# password, then:
base64 -i DeveloperID.p12 | pbcopy   # → MAC_CERT_P12_BASE64
# the export password             → MAC_CERT_PASSWORD
```

The two `release.yml` runs so far both stopped at *Import the Developer ID
certificate into a throwaway keychain*, which is what an absent or mismatched
pair of these secrets looks like.

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI — revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
   for team CC8UTF7ATG
2. Generate a **Team Key** with the **Developer** role
3. Download the `.p8` (one chance only), note the Key ID and Issuer ID

```sh
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_P8_BASE64
```

### 3. `RELEASES_PAT`

A fine-grained personal access token that lets the workflow create and edit
releases: **GitHub → Settings → Developer settings → Fine-grained tokens** →
repository access: only `jaywedgeworth22/botfleet-releases` → permissions:
**Contents: Read and write**.  Set a long expiry and a calendar reminder.

### Local Fallback

The hand-cut path still works when Actions is down or a release needs
surgery: `pnpm package:mac`, gate with `codesign --verify --deep --strict`,
notarize with the local keychain profile (`xcrun notarytool submit …
--keychain-profile AC_PASSWORD`), staple, re-zip, regenerate blockmaps and
`node scripts/regenerate-mac-feed.mjs`, upload to the matching
`jaywedgeworth22/botfleet-releases` release, publish, and always verify the
published bytes against the published feed by downloading them back.
