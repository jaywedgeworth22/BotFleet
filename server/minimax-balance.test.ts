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

  it("routes a Token Plan / subscription key to /v1/token_plan/remains", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [
          {
            model_name: "MiniMax-M3",
            current_interval_remaining_percent: 62,
            current_weekly_remaining_percent: 40,
            end_time: Math.floor(Date.now() / 1000) + 3600,
            weekly_end_time: Math.floor(Date.now() / 1000) + 86_400 * 3,
          },
        ],
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.minimax.io/v1/token_plan/remains");
    expect(result.source).toBe("token-plan");
    expect(result.capExists).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.remainingPercent).toBeCloseTo(62);
    expect(result.secondaryRemainingPercent).toBeCloseTo(40);
    expect(result.windowsLabel).toBe("5hr/Week");
    expect(result.models?.["MiniMax-M3"]?.windowsLabel).toBe("5hr/Week");
    expect(result.resetsAt).not.toBeNull();
  });

  it("reports 'capped' status once the most restrictive model hits zero", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [
          { model_name: "MiniMax-M3", current_interval_remaining_percent: 62 },
          { model_name: "MiniMax-M2.7-highspeed", current_interval_remaining_percent: 0 },
        ],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.status).toBe("capped");
    expect(result.remainingPercent).toBe(0);
  });

  it("treats a fractional 0-1 percent as a fraction, not a raw percent", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        model_remains: [{ model_name: "MiniMax-M3", current_interval_remaining_percent: 0.62 }],
        base_resp: { status_code: 0 },
      }),
    );
    const mod = await loadModule();
    const result = await mod.getMiniMaxBalance("subscription-token", "https://api.minimax.io/v1");
    expect(result.remainingPercent).toBeCloseTo(62);
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
