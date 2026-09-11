import { afterEach, describe, expect, it, vi } from "vitest";

import { InfisicalError, listSecrets, login, upsertSecret } from "./infisical-client.ts";

// Obviously fake, and never sent anywhere real: these exist so the
// assertions below have a credential-shaped string to look for. Every test
// that could plausibly leak one asserts it is absent from what came back.
const SENTINEL_CLIENT_SECRET = "sentinel-client-secret-not-real";
const SENTINEL_TOKEN = "sentinel-bearer-token-not-real";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login", () => {
  it("posts clientId and clientSecret to the universal-auth path and returns only the token", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://app.infisical.example/api/v1/auth/universal-auth/login");
      expect(init?.method).toBe("POST");
      // SAFETY: this suite's own call under test built the body, so its
      // shape is exactly the two fields asserted immediately below.
      const body = JSON.parse(String(init?.body)) as { clientId: string; clientSecret: string };
      expect(body).toEqual({ clientId: "client-1", clientSecret: SENTINEL_CLIENT_SECRET });
      return new Response(
        JSON.stringify({ accessToken: SENTINEL_TOKEN, expiresIn: 900, tokenType: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await login({
      siteUrl: "https://app.infisical.example",
      clientId: "client-1",
      clientSecret: SENTINEL_CLIENT_SECRET,
    });

    expect(token).toBe(SENTINEL_TOKEN);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws an InfisicalError carrying the status and no body detail on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: `bad credentials ${SENTINEL_CLIENT_SECRET}` }), { status: 401 })),
    );

    let caught: unknown;
    try {
      await login({ siteUrl: "https://app.infisical.example", clientId: "client-1", clientSecret: SENTINEL_CLIENT_SECRET });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InfisicalError);
    if (caught instanceof InfisicalError) {
      expect(caught.statusCode).toBe(401);
      expect(caught.message).not.toContain(SENTINEL_CLIENT_SECRET);
      expect(caught.message).toMatch(/401/);
    }
  });

  it("refuses a response with no accessToken", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));

    await expect(
      login({ siteUrl: "https://app.infisical.example", clientId: "client-1", clientSecret: SENTINEL_CLIENT_SECRET }),
    ).rejects.toThrow(/no accessToken/);
  });
});

describe("listSecrets", () => {
  it("builds the exact query, including viewSecretValue=false, when probing", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/api/v3/secrets/raw");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        workspaceId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewSecretValue: "false",
        expandSecretReferences: "false",
        include_imports: "false",
      });
      // SAFETY: this suite's own call built the headers as a plain record.
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${SENTINEL_TOKEN}`);
      return new Response(
        JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: "should-not-appear" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listSecrets({
      siteUrl: "https://app.infisical.example",
      token: SENTINEL_TOKEN,
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      viewValues: false,
    });

    expect(result.names).toEqual(["COMPOSIO_API_KEY"]);
    expect(result.values.size).toBe(0);
  });

  it("populates values only when viewValues is true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              secrets: [
                { secretKey: "COMPOSIO_API_KEY", secretValue: "real-value" },
                { secretKey: "PATH", secretValue: "/usr/bin" },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await listSecrets({
      siteUrl: "https://app.infisical.example",
      token: SENTINEL_TOKEN,
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      viewValues: true,
    });

    expect(result.names).toEqual(["COMPOSIO_API_KEY", "PATH"]);
    expect(result.values.get("COMPOSIO_API_KEY")).toBe("real-value");
    expect(result.values.get("PATH")).toBe("/usr/bin");
  });

  it("throws an InfisicalError on a non-2xx list response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(
      listSecrets({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewValues: true,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe("upsertSecret", () => {
  it("PATCHes the raw secret and returns on success", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://app.infisical.example/api/v3/secrets/raw/COMPOSIO_API_KEY");
      expect(init?.method).toBe("PATCH");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ workspaceId: "proj-1", environment: "prod", secretPath: "/", secretValue: "new-value" });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertSecret({
      siteUrl: "https://app.infisical.example",
      token: SENTINEL_TOKEN,
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      name: "COMPOSIO_API_KEY",
      value: "new-value",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to POST with type shared when the PATCH 404s", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.method));
      if (init?.method === "PATCH") return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        workspaceId: "proj-1",
        environment: "prod",
        secretPath: "/",
        secretValue: "new-value",
        type: "shared",
      });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertSecret({
      siteUrl: "https://app.infisical.example",
      token: SENTINEL_TOKEN,
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      name: "COMPOSIO_API_KEY",
      value: "new-value",
    });

    expect(calls).toEqual(["PATCH", "POST"]);
  });

  it("throws when both the PATCH and the fallback POST fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PATCH" ? new Response("nope", { status: 404 }) : new Response("nope", { status: 500 }),
      ),
    );

    await expect(
      upsertSecret({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        name: "COMPOSIO_API_KEY",
        value: "new-value",
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("throws immediately on a non-404 PATCH failure, without a fallback POST", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertSecret({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        name: "COMPOSIO_API_KEY",
        value: "new-value",
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("network failures and timeouts", () => {
  it("wraps fetch timeout in InfisicalError with 504 and phase context", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutErr;
      }),
    );

    let caught: unknown;
    try {
      await login({
        siteUrl: "https://app.infisical.example",
        clientId: "client-1",
        clientSecret: SENTINEL_CLIENT_SECRET,
        timeoutMs: 5000,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InfisicalError);
    if (caught instanceof InfisicalError) {
      expect(caught.statusCode).toBe(504);
      expect(caught.message).toBe("Infisical login timed out after 5000 ms");
    }
  });

  it("wraps listSecrets timeout in InfisicalError with 504", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutErr;
      }),
    );

    await expect(
      listSecrets({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewValues: false,
        timeoutMs: 2500,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 504,
      message: "Infisical secrets list timed out after 2500 ms",
    });
  });

  it("wraps upsertSecret timeout in InfisicalError with 504", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutErr;
      }),
    );

    await expect(
      upsertSecret({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        name: "COMPOSIO_API_KEY",
        value: "new-value",
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 504,
      message: "Infisical secret update timed out after 3000 ms",
    });
  });

  it("wraps general network failure in InfisicalError with 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(
      login({
        siteUrl: "https://app.infisical.example",
        clientId: "client-1",
        clientSecret: SENTINEL_CLIENT_SECRET,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 502,
      message: "Infisical login failed: fetch failed",
    });
  });
});

