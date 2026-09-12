import { describe, expect, it } from "vitest";

import { ProviderError } from "../../contracts.ts";
import { classifyHttpError, httpErrorFor } from "./errors.ts";

describe("classifyHttpError — status-to-code mapping table", () => {
  const rows: Array<{ status: number; code?: string; setup?: boolean }> = [
    { status: 401, code: "invalid_credentials", setup: true },
    { status: 403, code: "invalid_credentials", setup: true },
    { status: 402, code: "quota_or_region_restriction", setup: false },
    { status: 429, code: "quota_or_region_restriction", setup: false },
    { status: 404, code: "model_catalog_outage", setup: false },
    { status: 500, code: "upstream_outage", setup: false },
    { status: 502, code: "upstream_outage", setup: false },
    { status: 503, code: "upstream_outage", setup: false },
    { status: 599, code: "upstream_outage", setup: false },
    { status: 400 },
    { status: 405 },
    { status: 422 },
    { status: 301 },
  ];

  for (const row of rows) {
    it(`${row.status} -> ${row.code ?? "unclassified"}`, () => {
      expect(classifyHttpError(row.status)).toEqual(
        row.code ? { code: row.code, setup: row.setup } : undefined,
      );
    });
  }
});

describe("httpErrorFor", () => {
  // Narrows through the class rather than asserting a type, so the check
  // that `code` survived is the same check a caller performs.
  const codeOf = (error: Error) => (error instanceof ProviderError ? error.code : undefined);

  it("throws a ProviderError carrying the classified code for a 401", () => {
    const error = httpErrorFor(401, "invalid api key");
    expect(error).toBeInstanceOf(ProviderError);
    expect(codeOf(error)).toBe("invalid_credentials");
    expect(error.message).toBe("HTTP 401: invalid api key");
  });

  it("throws a ProviderError carrying upstream_outage for a 502", () => {
    const error = httpErrorFor(502, "bad gateway");
    expect(error).toBeInstanceOf(ProviderError);
    expect(codeOf(error)).toBe("upstream_outage");
  });

  it("throws a ProviderError carrying quota_or_region_restriction for a 429", () => {
    const error = httpErrorFor(429, "rate limited");
    expect(error).toBeInstanceOf(ProviderError);
    expect(codeOf(error)).toBe("quota_or_region_restriction");
  });

  it("falls back to a plain Error for an unmapped status, so an unclassified failure keeps today's behaviour", () => {
    const error = httpErrorFor(422, "bad request");
    expect(error).not.toBeInstanceOf(ProviderError);
    expect(error.message).toBe("HTTP 422: bad request");
  });

  it("omits the body suffix when the body is empty", () => {
    const error = httpErrorFor(500, "");
    expect(error.message).toBe("HTTP 500");
  });

  it("truncates a long body to 200 chars", () => {
    const long = "x".repeat(500);
    const error = httpErrorFor(500, long);
    expect(error.message).toBe(`HTTP 500: ${"x".repeat(200)}`);
  });
});
