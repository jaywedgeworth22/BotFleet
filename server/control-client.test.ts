import { describe, expect, it } from "vitest";

import { createControlClient } from "./control-client.ts";

describe("createControlClient", () => {
  it("stays disengaged when URL or token is missing", async () => {
    const client = createControlClient({
      url: "",
      token: "",
      fetchImpl: async () => {
        throw new Error("must not fetch when unconfigured");
      },
    });
    expect(client.configured).toBe(false);
    await expect(client.state(true)).resolves.toEqual({ held: false, helpOpen: false });
  });

  it("fails closed when configured and the harness fetch throws", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () => {
        throw new Error("harness down");
      },
    });
    expect(client.configured).toBe(true);
    await expect(client.state(true)).resolves.toEqual({ held: true, helpOpen: false });
  });

  it("fails closed when configured and the harness returns non-ok", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    await expect(client.state(true)).resolves.toEqual({ held: true, helpOpen: false });
  });

  it("fails closed when configured and the body is not JSON", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    });
    await expect(client.state(true)).resolves.toEqual({ held: true, helpOpen: false });
  });

  it("returns the harness hold when the read succeeds", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ held: false, helpOpen: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.state(true)).resolves.toEqual({ held: false, helpOpen: true });
  });
});
