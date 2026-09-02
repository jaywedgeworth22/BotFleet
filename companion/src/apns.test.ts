import { describe, expect, it } from "vitest";

import { apnsJwt } from "./apns.ts";

describe("apnsJwt", () => {
  it("builds a three-part ES256 token from a p8", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const p8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = apnsJwt({ keyId: "ABC123", teamId: "TEAMID1", p8 }, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(header).toEqual({ alg: "ES256", kid: "ABC123" });
    expect(payload.iss).toBe("TEAMID1");
    expect(payload.iat).toBe(1_700_000_000);
  });
});
