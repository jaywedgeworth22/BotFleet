// Unit tests for the MiniMax balance/quota fetcher. We don't want to hit the
// real (undocumented) API in tests, so global fetch is stubbed before the
// module loads — same shape as deepseek-balance.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<FetchResponse>>();

function mockResponse(ok: boolean, status: number, body: unknown): FetchResponse {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  // Reset the module-level cache between tests so different (key, url) pairs
  // don't leak across cases.
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadModule() {
  return await import("./minimax-balance.ts");
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000; // 18,000,000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 604,800,000

// The coordinator's own example magnitude ("observed 1789275600000 style").
const INTERVAL_END = 1_789_275_600_000;
const INTERVAL_START = INTERVAL_END - FIVE_HOURS_MS;
const WEEKLY_END = 1_789_360_800_000;
const WEEKLY_START = WEEKLY_END - SEVEN_DAYS_MS;

/** Live-verified 2026-09-13 via `mmx quota show` against a real Token Plan
 *  account (no secrets involved — only the response shape was recorded).
 *  Two model rows: "general" (the chat quota, zero counts, 100%/94%
 *  remaining) and "video" (a separate quota pool, non-zero counts, 85%/88%
 *  remaining) — proves the two are parsed independently and never blended
 *  into one number. */
const TOKEN_PLAN_FIXTURE = {
  model_remains: [
    {
      model_name: "general",
      start_time: INTERVAL_START,
      end_time: INTERVAL_END,
      remains_time: 3_600_000,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      current_interval_remaining_percent: 100,
      current_interval_status: 1,
      weekly_start_time: WEEKLY_START,
      weekly_end_time: WEEKLY_END,
      weekly_remains_time: 259_200_000,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      current_weekly_remaining_percent: 94,
      current_weekly_status: 1,
    },
    {
      model_name: "video",
      start_time: INTERVAL_START,
      end_time: INTERVAL_END,
      remains_time: 3_600_000,
      current_interval_total_count: 20,
      current_interval_usage_count: 3,
      current_interval_remaining_percent: 85,
      current_interval_status: 1,
      weekly_start_time: WEEKLY_START,
      weekly_end_time: WEEKLY_END,
      weekly_remains_time: 259_200_000,
      current_weekly_total_count: 100,
      current_weekly_usage_count: 12,
      current_weekly_remaining_percent: 88,
      current_weekly_status: 1,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

describe("getMiniMaxBalance", () => {
  it("returns a 'no key configured' snapshot when the key is empty", async () => {
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("", "https://api.minimax.io");
    expect(result.error).toBe("no key configured");
    expect(result.source).toBe("unavailable");
    expect(result.capExists).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes a pay-as-you-go secret key to /account/query_balance", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        available_amount: "12.34",
        cash_balance: "10.00",
        voucher_balance: "2.34",
        credit_balance: "0.00",
        owed_amount: "0.00",
        balance_alert_switch: false,
        balance_alert_threshold: "5.00",
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("sk-api-test123", "https://api.minimax.io/v1");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.minimax.io/account/query_balance");
    expect(result.source).toBe("account-balance");
    expect(result.capExists).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.balanceUsd).toBeCloseTo(12.34);
    expect(result.error).toBeNull();
  });

  it("routes a Token Plan / subscription key to /v1/token_plan/remains and reads 'general' for the headline", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, TOKEN_PLAN_FIXTURE));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.minimax.io/v1/token_plan/remains");
    expect(result.source).toBe("token-plan");
    expect(result.capExists).toBe(true);
    expect(result.status).toBe("ok");
    // The headline is "general"'s own figures (100%/94%), not blended with
    // "video"'s (85%/88%) — they are unrelated quota pools.
    expect(result.remainingPercent).toBe(100);
    expect(result.secondaryRemainingPercent).toBe(94);
    expect(result.windowsLabel).toBe("5hr/Week");
    // Epoch fields are milliseconds, passed through verbatim — no unit
    // rescaling. "general"'s own 5-hour window resets at end_time exactly.
    expect(result.resetsAt).toBe(INTERVAL_END);
    expect(result.weeklyResetsAt).toBe(WEEKLY_END);
    // Every row lands in `models`, including "video", for display — it is
    // just never used for the headline.
    expect(result.models?.general).toMatchObject({ remainingPercent: 100, secondaryRemainingPercent: 94 });
    expect(result.models?.video).toMatchObject({ remainingPercent: 85, secondaryRemainingPercent: 88 });
    expect(result.error).toBeNull();
  });

  it("maps current_interval_status/current_weekly_status: 1 is active, anything else is unknown (never capped)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, TOKEN_PLAN_FIXTURE));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.models?.general?.intervalStatus).toBe("active");
    expect(result.models?.general?.weeklyStatus).toBe("active");

    // Same (key, url) pair as above — bust the 5-minute cache so this
    // second fetch actually reaches the mock instead of serving the first
    // response back.
    mod.invalidateMiniMaxBalance();
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ ...TOKEN_PLAN_FIXTURE.model_remains[0], current_interval_status: 3, current_weekly_status: undefined }],
        base_resp: { status_code: 0 },
      }),
    );
    const unknownResult = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(unknownResult.models?.general?.intervalStatus).toBe("unknown");
    expect(unknownResult.models?.general?.weeklyStatus).toBe("unknown");
    // An unrecognized status must never be read as "capped" on its own —
    // that comes only from the percent fields (still 100 here).
    expect(unknownResult.status).toBe("ok");
  });

  it("ignores usage/total counts entirely — never derives a percent from them", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, TOKEN_PLAN_FIXTURE));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    // "general" has zero counts and 100% remaining; "video" has non-zero
    // counts (3/20 used) and only 85% remaining — if percent were ever
    // derived from counts, "general" would show 100% (0/0) and this
    // assertion would still pass by coincidence, so the real proof is that
    // neither model's exposed shape carries a count field at all.
    expect(result.models?.general).not.toHaveProperty("current_interval_usage_count");
    expect(result.models?.video?.remainingPercent).toBe(85);
  });

  it("falls back to remains_time (a duration) when the absolute end_time is missing", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [
          {
            model_name: "general",
            remains_time: 7_200_000,
            current_interval_remaining_percent: 100,
            weekly_remains_time: 259_200_000,
            current_weekly_remaining_percent: 94,
          },
        ],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.resetsAt).toBe(now + 7_200_000);
    expect(result.weeklyResetsAt).toBe(now + 259_200_000);
    vi.useRealTimers();
  });

  it("reports 'capped' status once general's most restrictive window hits zero, unaffected by a capped 'video' row", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [
          { model_name: "general", current_interval_remaining_percent: 0, current_weekly_remaining_percent: 50 },
          { model_name: "video", current_interval_remaining_percent: 0, current_weekly_remaining_percent: 0 },
        ],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.status).toBe("capped");
    expect(result.remainingPercent).toBe(0);
  });

  it("does not go capped when only an unrelated 'video' row is exhausted", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [
          { model_name: "general", current_interval_remaining_percent: 62, current_weekly_remaining_percent: 40 },
          { model_name: "video", current_interval_remaining_percent: 0, current_weekly_remaining_percent: 0 },
        ],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.status).toBe("ok");
    expect(result.remainingPercent).toBe(62);
    expect(result.models?.video?.remainingPercent).toBe(0);
  });

  it("has no headline when there is no 'general' row, but still keeps the other rows for display", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "video", current_interval_remaining_percent: 85 }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.status).toBe("unknown");
    expect(result.remainingPercent).toBeNull();
    expect(result.capExists).toBe(true);
    expect(result.models?.video?.remainingPercent).toBe(85);
  });

  it("clamps an out-of-range percent defensively without rescaling it", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "general", current_interval_remaining_percent: 142 }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.remainingPercent).toBe(100);
  });

  it("uses the balance alert threshold as the near-cap signal", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        available_amount: "4.00",
        balance_alert_switch: true,
        balance_alert_threshold: "5.00",
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("sk-api-test", "https://api.minimax.io");
    expect(result.status).toBe("near_cap");
  });

  it("returns an error snapshot on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(false, 401, null));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("sk-api-bad", "https://api.minimax.io");
    expect(result.error).toBe("HTTP 401");
    expect(result.source).toBe("unavailable");
  });

  it("surfaces the MiniMax base_resp error message when status_code is non-zero", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, { base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("sk-api-bad", "https://api.minimax.io");
    expect(result.error).toBe("invalid api key");
    expect(result.source).toBe("unavailable");
  });

  it("falls back to 'unknown' on an unrecognized response shape", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, { unrelated: true }));
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io");
    expect(result.error).toBe("unrecognized response shape");
    expect(result.source).toBe("unavailable");
  });

  it("strips a /v1 suffix off the configured URL before building the endpoint", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, { model_remains: [], base_resp: { status_code: 0 } }));
    const mod = await loadModule();
    await mod.getMiniMaxBalance("subscription-token", "https://api.minimaxi.com/v1");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.minimaxi.com/v1/token_plan/remains");
  });

  it("times out a hanging fetch instead of blocking /api/quotas forever", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise<FetchResponse>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const mod = await loadModule();
      const pending = mod.getMiniMaxBalance("sk-api-test", "https://api.minimax.io");
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await pending;
      expect(result.error).toBe("timeout");
      expect(result.source).toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });
});
