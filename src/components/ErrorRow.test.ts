import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorRow, isComputerDispatchError, isProviderError } from "./ErrorRow";

describe("ErrorRow recovery", () => {
  it("classifies computer-dispatch failures before generic model copy", () => {
    expect(isComputerDispatchError("computer tool failed: no desktop")).toBe(true);
    expect(isComputerDispatchError("this bot has no computer yet — open the Computer panel and provision one")).toBe(
      true,
    );
    expect(isComputerDispatchError("The Local VM desktop failed to start: x")).toBe(true);
    expect(isProviderError("rate limit from the provider")).toBe(true);
    expect(isProviderError("missing api key")).toBe(true);
  });

  it("offers computer recovery actions instead of a Retry-only card", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorRow, {
        message: "computer tool failed: no desktop",
        onRetry: () => {},
      }),
    );
    expect(html).toContain("Retry");
    expect(html).toContain("Open Computer");
    expect(html).toContain("Use This Computer");
    expect(html).toContain("Create Local VM");
  });

  it("keeps Switch Model and Add API Key on provider failures", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorRow, {
        message: "provider 401: invalid api key",
        onRetry: () => {},
      }),
    );
    expect(html).toContain("Retry With Fallback");
    expect(html).toContain("Switch Model");
    expect(html).toContain("Add API Key");
  });
});
