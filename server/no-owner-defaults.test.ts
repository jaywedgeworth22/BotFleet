// BotFleet is a public app: no endpoint, hostname, path, or project name
// belonging to whoever happens to maintain it may be a default or a
// hardcoded string in shipped code. Everyone configures their own values,
// and unconfigured means the feature is simply off.
//
// This is a source scan rather than a behavioural test on purpose — the
// regression it catches is a new default being pasted in somewhere none of
// the existing tests reach.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_DIRS = ["server", "src", "shared"];
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"]);

/** Assembled from fragments so this file does not trip its own scan. */
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: "personal service domain", pattern: new RegExp(["jays", "\\.", "services"].join("")) },
  { label: "maintainer home directory", pattern: new RegExp(["/Users/", "jay", "/"].join("")) },
  { label: "private corpus name", pattern: new RegExp(["fleet", "-", "agents"].join("")) },
  { label: "private tooling checkout", pattern: new RegExp(["apps/", "mac-collab"].join("")) },
  { label: "private tooling checkout", pattern: new RegExp(["apps/", "fleet-rag"].join("")) },
  { label: "private mesh address", pattern: new RegExp(["100", "\\.", "69", "\\.", "77"].join("")) },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    // Tests may name these strings to assert their absence.
    if (/\.(test|node-test)\.[^.]+$/.test(entry)) continue;
    if (SCANNED_EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

describe("shipped source carries no owner-specific defaults", () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)));

  it("finds source to scan at all", () => {
    // A scan that silently walked nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN)("contains no $label", ({ pattern }) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual([]);
  });
});
