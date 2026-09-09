import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CompanionGatewayCard, RemoteAccessSection } from "./RemoteAccessSection";
import {
  COMPANION_GATEWAY_BLURB,
  COMPANION_GATEWAY_LABEL,
  NAMED_REMOTE_URL,
  REMOTE_ACCESS_BLURB,
  REMOTE_ACCESS_HEADING,
  REMOTE_URL_LABEL,
  sentenceGapHtml,
} from "@/lib/remote-access";

describe("RemoteAccessSection", () => {
  it("renders Designer heading, Remote URL value, copy control, and Test Connection button", () => {
    const html = renderToStaticMarkup(createElement(RemoteAccessSection));
    expect(html).toContain(REMOTE_ACCESS_HEADING);
    expect(html).toContain(REMOTE_URL_LABEL);
    expect(html).toContain(NAMED_REMOTE_URL);
    expect(html).toContain(sentenceGapHtml(REMOTE_ACCESS_BLURB).replaceAll("'", "&#x27;"));
    expect(html).toContain('aria-label="Copy Remote URL"');
    expect(html).toContain("Copy");
    expect(html).toContain("Test Connection");
    expect(html).toContain('aria-label="Test Remote Access"');
    expect(html.toLowerCase()).not.toContain("trycloudflare");
  });
});

describe("CompanionGatewayCard", () => {
  it("renders the companion-path label and blurb without a fake tunnel URL", () => {
    const html = renderToStaticMarkup(createElement(CompanionGatewayCard));
    expect(html).toContain(COMPANION_GATEWAY_LABEL);
    expect(html).toContain(sentenceGapHtml(COMPANION_GATEWAY_BLURB));
    expect(html).not.toContain(NAMED_REMOTE_URL);
    expect(html.toLowerCase()).not.toContain("trycloudflare");
  });
});
