import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMPANION_GATEWAY_BLURB,
  COMPANION_GATEWAY_LABEL,
  NAMED_REMOTE_URL,
  REMOTE_ACCESS_BLURB,
  REMOTE_ACCESS_HEADING,
  REMOTE_URL_LABEL,
  sentenceGapHtml,
} from "./remote-access";

const here = dirname(fileURLToPath(import.meta.url));

describe("Remote Access Designer copy", () => {
  it("locks heading, label, named-tunnel URL, and blurbs", () => {
    expect(REMOTE_ACCESS_HEADING).toBe("Remote Access");
    expect(REMOTE_URL_LABEL).toBe("Remote URL");
    expect(NAMED_REMOTE_URL).toBe("https://botfleet.jays.services");
    expect(REMOTE_ACCESS_BLURB).toBe(
      "Opens BotFleet on this Mac through Jay's Tunnel.  Sign in with Cloudflare Access (same idea as agents.jays.services).  Health check stays public.",
    );
    expect(COMPANION_GATEWAY_LABEL).toBe("Companion Gateway");
    expect(COMPANION_GATEWAY_BLURB).toBe(
      "agents.botfleet.app is a separate path.  Leave it alone until that sidecar is up.",
    );
  });

  it("keeps two ASCII spaces between sentences in the source blurbs", () => {
    expect(REMOTE_ACCESS_BLURB).toMatch(/Tunnel\.  Sign/);
    expect(REMOTE_ACCESS_BLURB).toMatch(/services\)\.  Health/);
    expect(COMPANION_GATEWAY_BLURB).toMatch(/path\.  Leave/);
  });

  it("turns those gaps into NBSP+space for HTML", () => {
    const html = sentenceGapHtml(REMOTE_ACCESS_BLURB);
    expect(html).toContain("Tunnel.\u00A0 Sign");
    expect(html).toContain("services).\u00A0 Health");
    expect(html).not.toMatch(/Tunnel\.  Sign/);
    expect(sentenceGapHtml(COMPANION_GATEWAY_BLURB)).toContain("path.\u00A0 Leave");
  });

  it("does not invent TryCloudflare on the named-tunnel path", () => {
    const section = readFileSync(join(here, "../components/RemoteAccessSection.tsx"), "utf8");
    const copy = readFileSync(join(here, "remote-access.ts"), "utf8");
    expect(section.toLowerCase()).not.toContain("trycloudflare");
    expect(copy.toLowerCase()).not.toContain("trycloudflare");
    expect(section).toContain("NAMED_REMOTE_URL");
    expect(section).toContain("REMOTE_ACCESS_HEADING");
    expect(section).toContain("REMOTE_URL_LABEL");
    expect(section).toContain("COMPANION_GATEWAY_LABEL");
  });

  it("wires a Settings sidebar section to the named tunnel, not TryCloudflare", () => {
    const settings = readFileSync(join(here, "../components/SettingsModal.tsx"), "utf8");
    expect(settings).toContain('id: "remote"');
    expect(settings).toContain('label: "Remote Access"');
    expect(settings).toContain("<RemoteAccessSection />");
    expect(settings).toContain('{section === "remote" && <RemoteAccessSection />}');
  });

  it("shows Companion Gateway on the Phone section, not mixed into Remote Access", () => {
    const phone = readFileSync(join(here, "../components/CompanionSection.tsx"), "utf8");
    expect(phone).toContain("<CompanionGatewayCard />");
  });
});
