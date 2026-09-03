// Copy rules the UI is expected to hold to, checked against the source rather
// than a rendered screen: both are one-word-at-a-time regressions that no
// behavioural test would ever notice.
//
//  1. One nomenclature.  A user of this app has Bots, never "agents" — the
//     word only survives where it names something outside the app's own
//     vocabulary (a browser user agent, an ssh-agent, a driver kind, a host
//     name, another vendor's product).
//  2. Title Case for the things a user clicks or that name a region.  This
//     locks the surfaces that had drifted, so a later edit that reintroduces
//     "Working folder" next to "Working Folder" fails here instead of
//     shipping.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  path,
  rel: path.slice(SRC.length + 1).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

/** JSX text nodes plus the three attributes that reach a person: a tooltip,
 * a screen-reader name, and the grey text inside an empty field. */
function userFacingStrings(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:title|aria-label|placeholder)="([^"]+)"/g)) found.push(match[1]!);
  for (const match of text.matchAll(/>\s*([A-Za-z][^<>{}\n]{1,120}?)\s*</g)) found.push(match[1]!);
  return found;
}

/** Where "agent" is still the accurate word: it is not the app's concept. */
const AGENT_ALLOWED = [
  "agents.botfleet.app", // a host name the user types back in
  "agent-memory", // an example Qdrant collection id, not a label
  "SSH config and agent", // ssh-agent, a thing the operating system runs
];

describe("one nomenclature: Bot, never Agent", () => {
  it("keeps 'agent' out of every user-facing string", () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      for (const value of userFacingStrings(text)) {
        if (!/\bagents?\b/i.test(value)) continue;
        if (AGENT_ALLOWED.some((allowed) => value.includes(allowed))) continue;
        offenders.push(`${path.slice(SRC.length + 1).replaceAll("\\", "/")}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("Title Case for controls and headings", () => {
  // Each entry is a label a user clicks or that names a region, with the
  // sentence-case spelling it must never drift back to.
  const LABELS: Array<[file: string, wrong: string, right: string]> = [
    ["components/ChatView.tsx", ">Working folder<", ">Working Folder<"],
    ["components/ChatView.tsx", ">Session usage<", ">Session Usage<"],
    ["components/ChatView.tsx", "Bot's computer", "Bot's Computer"],
    ["components/ChatView.tsx", "Agent profile & settings", "Bot Profile &amp; Settings"],
    ["components/SettingsPanel.tsx", ">Agent profile<", ">Bot Profile<"],
    ["components/SettingsPanel.tsx", ">Working folder<", ">Working Folder<"],
    ["components/SettingsPanel.tsx", ">Auto mode<", ">Auto Mode<"],
    ["components/QdrantRagConnection.tsx", "Agent RAG", "Bot RAG &amp; Shared Memory"],
    ["components/TeamMapPage.tsx", ">Agent handoffs<", ">Bot Handoffs<"],
    ["components/RoutinesPage.tsx", "Tasks &amp; routines", "Tasks &amp; Routines"],
    ["components/Sidebar.tsx", ">Archived bots<", ">Archived Bots<"],
    ["components/SettingsModal.tsx", 'title="Usage analytics"', 'title="Usage Analytics"'],
  ];

  for (const [file, wrong, right] of LABELS) {
    it(`${file} uses "${right}"`, () => {
      const source = FILES.find((entry) => entry.rel === file || entry.rel.endsWith(`/${file}`));
      expect(source, `${file} is missing`).toBeDefined();
      expect(source!.text).toContain(right);
      expect(source!.text).not.toContain(wrong);
    });
  }
});
