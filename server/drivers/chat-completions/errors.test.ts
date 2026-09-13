import { describe, expect, it } from "vitest";

import { ProviderError } from "../../contracts.ts";
import {
  RETRY_AFTER_CAP_MS,
  classifyHttpError,
  httpErrorFor,
  httpFailureOf,
  httpRetryPolicy,
  parseRetryAfter,
} from "./errors.ts";

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

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(parseRetryAfter(" 12 ")).toBe(12_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads an HTTP-date, relative to now", () => {
    const now = Date.parse("2026-09-13T00:00:00Z");
    expect(parseRetryAfter("Sun, 13 Sep 2026 00:00:05 GMT", now)).toBe(5_000);
    // a date already in the past is a cool-down that has expired, not a
    // negative wait
    expect(parseRetryAfter("Sun, 13 Sep 2026 00:00:00 GMT", now + 9_000)).toBe(0);
  });

  it("caps a cool-down no chat turn should serve", () => {
    expect(parseRetryAfter("600")).toBe(RETRY_AFTER_CAP_MS);
  });

  it("reads an absent or unusable header as no header at all", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("1.5")).toBeUndefined();
  });
});

describe("httpRetryPolicy", () => {
  it("spends the full schedule on the transient server statuses", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(httpRetryPolicy({ status }), `status ${status}`).toEqual({ maxAttempts: 3, reason: "server_error" });
    }
    expect(httpRetryPolicy({ status: 408 })).toEqual({ maxAttempts: 3, reason: "timeout" });
  });

  it("leaves the permanent 5xx statuses alone", () => {
    // 501 and 505 still classify as upstream_outage; they are just not
    // things a second identical request fixes
    expect(httpRetryPolicy({ status: 501 })).toBeUndefined();
    expect(httpRetryPolicy({ status: 505 })).toBeUndefined();
  });

  it("gives a 429 the full schedule only when the provider named its cool-down", () => {
    expect(httpRetryPolicy({ status: 429, retryAfterMs: 2_000 })).toEqual({
      maxAttempts: 3,
      reason: "rate_limited",
      retryAfterMs: 2_000,
    });
    // no header: one polite retry, then it reaches the fallback ladder as
    // the quota wall it usually is
    expect(httpRetryPolicy({ status: 429 })).toEqual({ maxAttempts: 2, reason: "rate_limited" });
  });

  it("never retries a request the provider will refuse identically", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(httpRetryPolicy({ status }), `status ${status}`).toBeUndefined();
    }
  });
});

describe("httpFailureOf", () => {
  it("carries the real status off the error httpErrorFor built", () => {
    expect(httpFailureOf(httpErrorFor(502, "bad gateway"))).toEqual({ status: 502, retryAfterMs: undefined });
  });

  it("carries a parsed Retry-After when the response had one", () => {
    const headers = { get: (name: string) => (name === "retry-after" ? "4" : null) };
    expect(httpFailureOf(httpErrorFor(429, "slow down", headers))).toEqual({ status: 429, retryAfterMs: 4_000 });
  });

  it("leaves the error itself byte-identical — the detail is held beside it, not on it", () => {
    const error = httpErrorFor(502, "bad gateway");
    expect(Object.keys(error)).not.toContain("status");
    expect(JSON.stringify(error)).toBe(JSON.stringify(new ProviderError("upstream_outage", error.message)));
  });

  it("reads anything it did not build as no detail, so the text classifier decides", () => {
    expect(httpFailureOf(new Error("socket hang up"))).toBeUndefined();
    expect(httpFailureOf(new TypeError("fetch failed"))).toBeUndefined();
  });
});
