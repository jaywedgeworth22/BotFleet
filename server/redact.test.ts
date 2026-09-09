// The native log must keep the shape of a session-setup message and lose the
// credential values. These tests use the exact shapes the drivers actually
// write — the ACP `env: [{name,value}]` wire form and the claude mcpServers
// object form — so a change to either shape breaks the test, not the secret.
import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redact.ts";

const flat = (value: unknown) => JSON.stringify(value);

describe("redactSecrets", () => {
  it("masks the tokens in an ACP session/new, keeping the shape", () => {
    const sessionNew = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/new",
      params: {
        cwd: "/Users/someone",
        mcpServers: [
          {
            name: "agents",
            command: "/usr/bin/node",
            args: ["/app/agents-proxy.js"],
            env: [
              { name: "OMB_BOT_ID", value: "bot-123" },
              { name: "OMB_COMMS_TOKEN", value: "s3cret-comms-token-value" },
            ],
          },
          {
            name: "computer",
            command: "/usr/bin/node",
            args: ["/app/computer-proxy.js"],
            env: [
              { name: "OGB_BOX_ID", value: "box-9" },
              { name: "OGB_BOX_TOKEN", value: "box_live_abcdefghijklmnop" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));

    expect(out).not.toContain("s3cret-comms-token-value");
    expect(out).not.toContain("box_live_abcdefghijklmnop");
    // shape survives: still the same method, servers, names and non-secret env
    expect(out).toContain("session/new");
    expect(out).toContain("OMB_COMMS_TOKEN");
    expect(out).toContain("OGB_BOX_TOKEN");
    expect(out).toContain("bot-123");
    expect(out).toContain("box-9");
    expect(out).toContain("/app/agents-proxy.js");
    // and it says how long the value was, which is what you debug with
    expect(out).toContain("«redacted 24 chars»");
  });

  it("masks a Composio key in an MCP header and an env object", () => {
    const config = {
      mcpServers: {
        composio: {
          type: "http",
          url: "https://app.composio.dev/tool_router/v3/trs_test/mcp",
          headers: { "x-api-key": "ak_live_supersecret" },
        },
        computer: { env: { ELECTRON_RUN_AS_NODE: "1", OGB_BOX_TOKEN: "box_live_zzz" } },
      },
    };

    const out = flat(redactSecrets(config));
    expect(out).not.toContain("ak_live_supersecret");
    expect(out).not.toContain("box_live_zzz");
    expect(out).toContain("app.composio.dev");
    expect(out).toContain("ELECTRON_RUN_AS_NODE");
    expect(out).toContain('"1"'); // a non-secret value is untouched
  });

  it("still content-redacts an ACP env entry whose name is not secret-shaped", () => {
    // A credential can land under an ordinary-looking variable name (a
    // custom env var, a feature flag someone repurposed) — the ACP
    // {name,value} shortcut must not skip the content pass just because
    // the NAME alone doesn't scream "secret".
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const leaked = `sk-ant-api03-${alpha}`;
    const sessionNew = {
      params: {
        mcpServers: [
          {
            name: "custom",
            env: [
              { name: "SESSION_CONFIG", value: leaked },
              { name: "FEATURE_FLAG", value: "enabled" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));
    expect(out).not.toContain(leaked);
    expect(out).toContain("SESSION_CONFIG");
    expect(out).toContain("FEATURE_FLAG");
    expect(out).toContain("enabled");
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("leaves ordinary protocol traffic alone", () => {
    const update = {
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "the key to this bug" } } },
    };
    expect(redactSecrets(update)).toEqual(update);
  });

  it("does not mangle words that merely contain 'key'", () => {
    const msg = { keyboard: "cmd+k", monkey: "business", keys: "SECRET-LIST", hotkey: "ctrl" };
    const out = redactSecrets(msg) as Record<string, string>;
    expect(out.keyboard).toBe("cmd+k");
    expect(out.monkey).toBe("business");
    expect(out.hotkey).toBe("ctrl");
    // `keys` standing alone IS treated as a credential holder
    expect(out.keys).toContain("redacted");
  });

  it("survives cycles-adjacent depth and non-objects", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(42)).toBe(42);
    let deep: Record<string, unknown> = { token: "deep-secret" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => redactSecrets(deep)).not.toThrow();
  });
});

import { redactSecretsInText } from "./redact.ts";
import { clip, DETAIL_LIMIT } from "../shared/tool-activity.ts";

// Obviously-fake credential material, assembled from pieces so no
// token-shaped literal sits in the source (GitHub push protection rightly
// flags those) and so nobody reading the file mistakes it for a live key.
const FAKE = "RkFLRQ"; // base64 of "FAKE"
const FAKE_KEY_BODY = "FAKEFAKE".repeat(38); // 304 chars of nothing
const JWT_HEADER = "eyJhbGciOiJGQUtFIn0"; // base64url of {"alg":"FAKE"}
const JWT_PAYLOAD = `eyJwYXlsb2FkIjoi${FAKE.repeat(40)}`; // long enough to outlive the clip
const JWT_SIG = "RkFLRVNJRw"; // base64 of "FAKESIG"
const OPAQUE = `FAKE${"0123456789".repeat(30)}`; // a 304-char opaque value

// Content-shaped secrets: what a bot's own reply, a tool title, or a
// permission card can carry. High precision on purpose — a false positive
// here rewrites real code in the transcript.
describe("redactSecretsInText", () => {
  it("masks known key prefixes wherever they appear", () => {
    // fixtures are assembled at runtime so no token-shaped literal sits in
    // the source — GitHub's push protection (rightly) flags those
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const cases: Array<[string, RegExp]> = [
      [`set ANTHROPIC_API_KEY=sk-ant-api03-${alpha}`, /sk-ant/],
      [`OpenAI: sk-proj-${alpha}ABCD`, /sk-proj/],
      [`gh token ${"gh" + "p_"}${alpha}`, /ghp_/],
      [`fine-grained ${"github_" + "pat_"}11ABCDEFG0${alpha}`, /github_pat_/],
      [`slack ${"xox" + "b-"}${"123456789012"}-${"1234567890123"}-${alpha.slice(0, 24)}`, /xoxb-/],
      [`aws ${"AKIA" + "IOSFODNN7EXAMPLE"} and more`, /IOSFODNN7EXAMPLE/],
      [`google ${"AIza" + "SyA-"}${alpha.slice(0, 32)}`, /AIza/],
      [`npm ${"npm" + "_"}${alpha}`, /npm_[a-z]/],
    ];
    for (const [input, leak] of cases) {
      const out = redactSecretsInText(input);
      expect(out, input).not.toMatch(leak);
      expect(out).toMatch(/«redacted \d+ chars»/);
    }
  });

  it("masks JWTs, PEM private key blocks, and bearer tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecretsInText(`token ${jwt} ok`)).toBe(`token «redacted ${jwt.length} chars» ok`);
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactSecretsInText(`here:\n${pem}\ndone`);
    expect(out).not.toContain("b3BlbnNzaC1r");
    expect(out).toMatch(/BEGIN OPENSSH PRIVATE KEY[\s\S]*«redacted \d+ chars»[\s\S]*END OPENSSH PRIVATE KEY/);
    expect(redactSecretsInText('curl -H "Authorization: Bearer abc.def-ghi_jkl123456789"')).toBe('curl -H "Authorization: Bearer «redacted 24 chars»"');
  });

  it("masks a truncated PEM private key block that lost its closing trailer", () => {
    const truncatedPem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0abcdefghijklm1234567890";
    const out = redactSecretsInText(`output: ${truncatedPem}`);
    expect(out).not.toContain("MIIEowIBAAKCAQEA0abcdef");
    expect(out).toMatch(/BEGIN RSA PRIVATE KEY[\s\S]*«redacted \d+ chars»/);
  });

  // ── truncated shapes ────────────────────────────────────────────────
  // Redaction now runs before the transcript clip (see describeResult), but
  // a pre-clipped detail still reaches this function on paths we do not own,
  // and a secret cut in half has lost the closing marker the naive patterns
  // anchor on.  Each case below is the same secret put through `clip` at the
  // driver's own DETAIL_LIMIT, which is exactly how it used to get through.

  it("masks a JWT that lost its third segment to a clip", () => {
    // assembled from obviously-fake base64 so no token-shaped literal sits
    // in the source: "FAKE"/"FAKESIG" encoded, and an {"alg":"FAKE"} header
    const jwt = `${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIG}`;
    const raw = `POST /v1/thing failed, sent Authentication with ${jwt} and got 401`;
    expect(raw.length).toBeGreaterThan(DETAIL_LIMIT);

    const clipped = clip(raw, DETAIL_LIMIT);
    // the clip really did remove the signature — otherwise this proves nothing
    expect(clipped).not.toContain(JWT_SIG);
    expect(clipped).toContain(JWT_PAYLOAD.slice(0, 40));

    const out = redactSecretsInText(clipped);
    expect(out).not.toContain(JWT_PAYLOAD.slice(0, 40));
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("masks a JWT cut mid-payload with no third segment at all", () => {
    const cut = `${JWT_HEADER}.${JWT_PAYLOAD.slice(0, 60)}`;
    const out = redactSecretsInText(`bearer exchange failed for ${cut}`);
    expect(out).not.toContain(JWT_PAYLOAD.slice(0, 20));
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("still masks a complete three-segment JWT", () => {
    const jwt = `${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIG}`;
    expect(redactSecretsInText(`token ${jwt} ok`)).toBe(`token «redacted ${jwt.length} chars» ok`);
  });

  it("masks a quoted secret value whose closing quote was clipped away", () => {
    const raw = `curl failed: {"api_key":"${OPAQUE}","retry":false}`;
    expect(raw.length).toBeGreaterThan(DETAIL_LIMIT);

    const clipped = clip(raw, DETAIL_LIMIT);
    // the clip really did remove the closing quote KEY_VALUE needs via \3
    expect(clipped).not.toContain('","retry"');
    expect(clipped).toContain(OPAQUE.slice(0, 40));

    const out = redactSecretsInText(clipped);
    expect(out).not.toContain(OPAQUE.slice(0, 40));
    expect(out).toContain('"api_key":"«redacted');
  });

  it("masks an unterminated quoted value for every secret-shaped key it knows", () => {
    for (const key of ["api_key", "apiKey", "client_secret", "access_token", "password", "AUTHORIZATION"]) {
      const out = redactSecretsInText(`failed: {"${key}":"${OPAQUE.slice(0, 120)}`);
      expect(out, key).not.toContain(OPAQUE.slice(0, 20));
      expect(out, key).toMatch(/«redacted \d+ chars»/);
    }
  });

  it("does not mask an unterminated value twice", () => {
    // the prefix pass gets there first; a second mask would report the
    // length of the marker instead of the length of the secret
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const out = redactSecretsInText(`{"api_key":"${key}`);
    expect(out).toBe(`{"api_key":"«redacted ${key.length} chars»`);
  });

  it("leaves a PEM footer intact when nothing was clipped", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;
    const out = redactSecretsInText(pem);
    expect(out).not.toContain("FAKEFAKE");
    expect(out).toContain("-----END RSA PRIVATE KEY-----");
  });

  it("masks the value of a secret-shaped key=value or key: value, keeping the key", () => {
    expect(redactSecretsInText("export DATABASE_PASSWORD=hunter2hunter2")).toBe("export DATABASE_PASSWORD=«redacted 14 chars»");
    expect(redactSecretsInText('{"api_key": "abcd1234efgh5678"}')).toBe('{"api_key": "«redacted 16 chars»"}');
    expect(redactSecretsInText("client_secret: 'zzzz-yyyy-xxxx-1'")).toBe("client_secret: '«redacted 16 chars»'");
    expect(redactSecretsInText("--token=abc123def456")).toBe("--token=«redacted 12 chars»");
  });

  it("leaves ordinary text, code, hashes and URLs alone", () => {
    for (const s of [
      "the keyboard shortcut is cmd-k",
      "git commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e",
      "https://example.com/path?page=2&sort=asc",
      "const token = await getToken(); // fetches later",
      "password: (leave blank to keep the current one)",
      "Bearer tokens are sent in the Authorization header",
      "sk-8", // too short to be a key
    ]) {
      expect(redactSecretsInText(s), s).toBe(s);
    }
  });

  it("is applied to string values inside redactSecrets too", () => {
    const out = redactSecrets({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop'", note: "fine" }) as Record<string, string>;
    expect(out.command).toContain("«redacted");
    expect(out.note).toBe("fine");
  });
});
