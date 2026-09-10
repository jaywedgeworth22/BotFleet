import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CompanionGatewayCard,
  describeIngressTestOutcome,
  RemoteAccessSection,
  TestConnectionControl,
} from "./RemoteAccessSection";
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

describe("describeIngressTestOutcome", () => {
  it("surfaces the IngressProbeResult reason on a successful response", () => {
    expect(describeIngressTestOutcome(true, 200, { ok: true, reason: "Reachable", tunnel: "cloudflared" })).toEqual({
      kind: "ok",
      reason: "Reachable",
      tunnel: "cloudflared",
    });
    expect(describeIngressTestOutcome(true, 200, { ok: false, reason: "Origin refused the connection" })).toEqual({
      kind: "error",
      reason: "Origin refused the connection",
      tunnel: undefined,
    });
  });

  it("surfaces the attached-UI shim's {error} body instead of a blank reason on a non-2xx response", () => {
    // electron/attached-ui-shim.mjs proxyHttp: on an unreachable local harness
    // it answers 502 with { error: "BotFleet harness on port <port> is not reachable" },
    // not an IngressProbeResult — the falsey-body-cast bug turned this into reason: undefined.
    const result = describeIngressTestOutcome(false, 502, {
      error: "BotFleet harness on port 5199 is not reachable",
    });
    expect(result).toEqual({ kind: "error", reason: "BotFleet harness on port 5199 is not reachable" });
  });

  it("falls back to the HTTP status when a non-2xx response has no usable error field", () => {
    expect(describeIngressTestOutcome(false, 500, null)).toEqual({
      kind: "error",
      reason: "Request failed with status 500",
    });
    expect(describeIngressTestOutcome(false, 503, { error: 42 })).toEqual({
      kind: "error",
      reason: "Request failed with status 503",
    });
  });
});

describe("TestConnectionControl", () => {
  it("keeps a fixed accessible name and no live region while idle", () => {
    const html = renderToStaticMarkup(createElement(TestConnectionControl, { test: null, onRunTest: () => {} }));
    expect(html).toContain('aria-label="Test Remote Access"');
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain("Testing");
  });

  it("updates the accessible name and marks aria-busy while the probe is running", () => {
    const html = renderToStaticMarkup(
      createElement(TestConnectionControl, { test: { kind: "running" }, onRunTest: () => {} }),
    );
    expect(html).toContain('aria-label="Testing Remote Access…"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
  });

  it("announces the running state through a polite live region", () => {
    const html = renderToStaticMarkup(
      createElement(TestConnectionControl, { test: { kind: "running" }, onRunTest: () => {} }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Testing connection…");
  });

  it("restores the idle accessible name and result region once the probe finishes", () => {
    const html = renderToStaticMarkup(
      createElement(TestConnectionControl, { test: { kind: "ok", reason: "Reachable" }, onRunTest: () => {} }),
    );
    expect(html).toContain('aria-label="Test Remote Access"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('data-testid="remote-access-test-result"');
    expect(html).toContain("Reachable");
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
