import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildMacFeed, regenerateMacFeed } from "./regenerate-mac-feed.mjs";
import { verifyReleaseAssets } from "./verify-release-assets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "1.0.31";

function hash(file, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding);
}

function feed(directory, version, urls) {
  const entries = urls.map((url) => ({
    url,
    sha512: hash(join(directory, url), "sha512", "base64"),
    size: readFileSync(join(directory, url)).length,
  }));
  return [
    `version: ${version}`,
    "files:",
    ...entries.flatMap((entry) => [
      `  - url: ${entry.url}`,
      `    sha512: ${entry.sha512}`,
      `    size: ${entry.size}`,
    ]),
    `path: ${entries[0].url}`,
    `sha512: ${entries[0].sha512}`,
    "releaseDate: '2026-09-12T00:00:00.000Z'",
    "",
  ].join("\n");
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "botfleet-release-"));
  const files = [
    `BotFleet-${VERSION}-arm64.zip`,
    `BotFleet-${VERSION}-x64.zip`,
    `BotFleet-${VERSION}-arm64.dmg`,
    `BotFleet-${VERSION}-x64.dmg`,
    `BotFleet-${VERSION}-setup.exe`,
    `BotFleet-${VERSION}-x86_64.AppImage`,
    `BotFleet-${VERSION}-amd64.deb`,
  ];
  for (const file of files) writeFileSync(join(directory, file), `bytes:${file}`);
  for (const file of files.slice(0, 5)) writeFileSync(join(directory, `${file}.blockmap`), `map:${file}`);
  cpSync(join(directory, files[2]), join(directory, "BotFleet.dmg"));
  cpSync(join(directory, files[3]), join(directory, "BotFleet-intel.dmg"));
  cpSync(join(directory, files[4]), join(directory, "BotFleet-setup.exe"));
  cpSync(join(directory, files[5]), join(directory, "BotFleet.AppImage"));
  cpSync(join(directory, files[6]), join(directory, "BotFleet-amd64.deb"));
  writeFileSync(join(directory, "latest-mac.yml"), buildMacFeed(directory, VERSION, "2026-09-12T00:00:00.000Z"));
  writeFileSync(join(directory, "latest.yml"), feed(directory, VERSION, [files[4]]));
  writeFileSync(join(directory, "latest-linux.yml"), feed(directory, VERSION, [files[5]]));
  writeFileSync(
    join(directory, "SHA256SUMS-ubuntu-x64.txt"),
    [files[6], files[5]]
      .map((file) => `${hash(join(directory, file), "sha256", "hex")}  ${file}`)
      .join("\n") + "\n",
  );
  return { directory, files };
}

test("the assembled release has exact feeds, hashes, blockmaps, packages, and stable downloads", () => {
  const { directory } = fixture();
  try {
    assert.doesNotThrow(() => verifyReleaseAssets(directory, VERSION));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the verifier rejects stale feed bytes and stale stable downloads", () => {
  const staleFeed = fixture();
  const staleAlias = fixture();
  try {
    writeFileSync(join(staleFeed.directory, staleFeed.files[0]), "changed after feed generation");
    assert.throws(() => verifyReleaseAssets(staleFeed.directory, VERSION), /hash or size mismatch/);

    writeFileSync(join(staleAlias.directory, "BotFleet.dmg"), "stale alias");
    assert.throws(() => verifyReleaseAssets(staleAlias.directory, VERSION), /does not match/);
  } finally {
    rmSync(staleFeed.directory, { recursive: true, force: true });
    rmSync(staleAlias.directory, { recursive: true, force: true });
  }
});

test("mac feed regeneration replaces duplicate intermediate entries deterministically", () => {
  const { directory } = fixture();
  try {
    const feedPath = join(directory, "latest-mac.yml");
    writeFileSync(feedPath, "version: 0.0.0\nfiles:\n  - url: duplicate.zip\n");
    regenerateMacFeed({ feedPath, version: VERSION, releaseDate: "2026-09-12T00:00:00.000Z" });
    const text = readFileSync(feedPath, "utf8");
    assert.equal([...text.matchAll(/^\s{2}- url:/gm)].length, 4);
    assert.equal(new Set([...text.matchAll(/^\s{2}- url:\s+(\S+)/gm)].map((match) => match[1])).size, 4);
    assert.doesNotThrow(() => verifyReleaseAssets(directory, VERSION));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release workflow defaults to artifacts and requires explicit release mutation", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  assert.equal(pkg.version, VERSION);
  assert.match(pkg.scripts["package:mac:release"], /electron-builder --mac --arm64 --x64 --publish never/);
  assert.match(workflow, /Package both architectures\n\s+run: pnpm package:mac:release/);
  assert.match(workflow, /draft:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/);
  assert.match(workflow, /publish:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/);
  assert.match(workflow, /Publish \(only when asked to\)[\s\S]*?if: \$\{\{ inputs\.publish \}\}/);
  assert.match(workflow, /Preserve the complete verified release set/);
  assert.match(workflow, /node scripts\/verify-release-assets\.mjs assets "\$VERSION"/);
  assert.match(workflow, /required: MAC_CERT_P12_BASE64 MAC_CERT_PASSWORD/);
  assert.doesNotMatch(workflow, /RELEASES_PAT/);
  assert.match(workflow, /release:\n\s+name: Create the GitHub release\n\s+if: \$\{\{ inputs\.draft \|\| inputs\.publish \}\}[\s\S]*?permissions:\n\s+contents: write/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /group: release-\$\{\{ needs\.prepare\.outputs\.version \}\}/);
  assert.match(workflow, /--target "\$SHA"/);
  assert.match(workflow, /existing draft targets \$existing_target, not pinned \$SHA/);
  assert.match(workflow, /node scripts\/verify-release-assets\.mjs uploaded "\$VERSION"/);
});
