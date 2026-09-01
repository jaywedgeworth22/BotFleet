import { describe, it, expect } from "vitest";
import { generateProxyToken, proxyTokens } from "./cloud-proxy.ts";

describe("Cloud Proxy Token", () => {
  it("generates and stores tokens", () => {
    const token = generateProxyToken();
    expect(typeof token).toBe("string");
    expect(proxyTokens.has(token)).toBe(true);
  });
});
