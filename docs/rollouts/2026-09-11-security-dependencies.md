# Security Dependency Remediation

## Scope

GitHub Dependabot reported 26 open alerts across the Electron packaging toolchain, the docs application, the test runner, and transitive XML, YAML, archive, and image-processing packages.  The repository contained no evidence that the docs advisories had been exploited or that a vulnerable docs deployment was currently exposed.

## Changes

- Upgrade `electron-builder` from 24.13.3 to 26.16.1, which resolves `app-builder-lib` 26.16.1, `builder-util-runtime` 9.7.0, and `tar` 7.5.22.
- Upgrade the root and control-plane `vitest` requirements to 4.1.11.
- Upgrade the docs application from Next.js 16.3.2 to 16.3.3.
- Override only the vulnerable transitive versions of `@xmldom/xmldom` 0.8.13, `js-yaml` 4.3.1, and Sharp 0.35.2–0.35.3 to their first patched releases.
- Nest the custom Linux launcher metadata under `linux.desktop.entry`, the configuration shape required by Electron Builder 26.

The lockfile resolves `@xmldom/xmldom` 0.8.15, `js-yaml` 4.3.2, Sharp 0.35.4, Vitest 4.1.11, and Next.js 16.3.3.  The old versions appear only as override selectors and are absent as resolved package nodes.

## Validation

Validation is in progress.  The required evidence is the repository typecheck and test gate, docs type generation and production build, control-plane tests, an unsigned macOS package with packaged-resource inspection, the pull-request Linux package and smoke job, and the artifact-only Windows packaging workflow on the exact branch SHA.

The macOS validation workflow disables Developer ID discovery and the configured signing identity, builds an arm64 app directory, exercises the Electron Builder 26 `afterPack` hook, inspects the launcher and packaged helpers, starts the packaged server, and retains an unsigned zip artifact.  The Windows workflow creates an unsigned NSIS installer and checks the packaged tree, updater feed, and packaged server before retaining a workflow artifact.  Neither workflow publishes a release.  The pull-request CI matrix exercises typecheck, desktop and updater tests, and packaged-server smoke on macOS, Linux, and Windows; only the Ubuntu job builds and launches the complete Linux packages.  The Linux package verifier additionally checks the generated AppImage `AppRun` search-path expansions and rejects the empty path component fixed in `app-builder-lib` 26.15.0.  The first Linux package attempt exposed and confirmed the Electron Builder 26 desktop-entry migration before artifact generation.
