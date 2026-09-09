// Keeping secrets out of the native protocol log — and out of the transcript.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but the messages that set a session up carry
// the credentials the agent is handed: the box token and the comms token
// travel inside `session/new`'s mcpServers env, and a Composio consumer key
// travels in an MCP header. Those logs sit in ~/.botfleet/native as
// ordinary files, are read by anyone debugging, and get pasted into issues.
//
// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
// tells you a token was passed, under which name, and how long it was —
// enough to debug "the proxy got no token" without the token being there.
//
// This lives in `shared/` rather than `server/` because the other caller is
// `shared/tool-activity.ts`, which clips a tool result down to one line for
// the transcript — and that clip has to happen AFTER redaction, not before
// (see the truncation note below). `server/redact.ts` re-exports both
// entry points, so every existing server importer is unaffected.
//
// Truncation is the reason these patterns are shaped the way they are. A
// secret that has been cut in half upstream has lost the closing marker a
// naive pattern anchors on — the `END … PRIVATE KEY` trailer, a JWT's third
// segment, a quoted value's closing quote. Redacting before the clip is the
// real fix; recognising the truncated shapes is the belt to that braces,
// because the detail also arrives pre-clipped on paths we do not own.

/** Key names whose value is a credential. Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`. Only
 * treat it as a credential when it stands alone or is a suffix, which is how
 * every real one is spelled (API_KEY, consumer-key, xai_key). */
function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

const mask = (value: string) => `«redacted ${value.length} chars»`;

// ── content-shaped secrets ────────────────────────────────────────────
// What a bot's own reply, a tool title, or a permission card can carry —
// and, since the rebuild replays activity into every handed-over context,
// what would otherwise become permanent. High precision on purpose: a
// generic "long hex/base64" heuristic would rewrite real code in the
// transcript, so only shapes that are unmistakably credentials match.

const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai / stripe
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  // jwt — the third segment is OPTIONAL and unbounded on purpose: a token
  // clipped at 240 characters loses its signature (and often the tail of
  // its payload), and the header alone is `{"alg":…}`, so anchoring on a
  // complete three-segment token is exactly what lets a cut one through.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
];
/** `Bearer <token>` standing on its own, anywhere.  Case-insensitive: a
 * lowercase spelling is just as much a credential, and the 12-character
 * minimum is what keeps "Bearer tokens are sent in the …" out of it. */
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
/** The whole value of an authorization header, whatever scheme it names.
 *
 * `KEY_VALUE` cannot reach this one: a scheme-prefixed credential has a
 * SPACE in it, and KEY_VALUE's value is deliberately space-free so that
 * prose after a colon does not match.  Anchoring on the header NAME instead
 * is what makes that space safe — and it is why the scheme words are not
 * spelled out here.  A bare scheme word would be a false-positive machine
 * ("Basic authentication requires…", "Token expired yesterday"); the same
 * word behind this header name cannot be prose.  The scheme is kept, so the
 * line still says what kind of credential went out. */
const AUTH_HEADER =
  /\b((?:proxy-)?authorization)(["']?\s*[=:]\s*)(["']?)([A-Za-z][A-Za-z0-9-]{2,}\s+)?([A-Za-z0-9._~+/=-]{8,})\3/gi;
const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match. */
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
/** The same key list, for a value whose CLOSING quote was lost upstream.
 * `KEY_VALUE` needs `\3` to close the value, so `{"api_key":"<300 chars>"}`
 * clipped to 240 characters matches nothing and the key material goes out
 * intact. Anchored at end-of-text, because that is the only place a quote
 * that never closes can legitimately come from: something cut the string.
 * The value class is deliberately wide (anything but a quote) — over-redacting
 * the tail of a string that was already truncated costs a reader nothing. */
const KEY_VALUE_UNTERMINATED =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["'])([^"']{8,})$/i;

/** Already-masked text must not be masked again — a second pass would report
 * the length of the marker instead of the length of the secret, and the
 * length is the part a reader debugs with. */
const MASK_MARKER = "«redacted ";

export function redactSecretsInText(text: string): string {
  if (!text || text.length < 8) return text;
  let out = text;
  out = out.replace(PEM_BLOCK, (_m, open: string, body: string, close: string) => {
    const trimmed = body.trim();
    if (!trimmed && !close) return open;
    const masked = mask(trimmed);
    return close ? `${open}\n${masked}\n${close}` : `${open}\n${masked}`;
  });
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(
    AUTH_HEADER,
    (m, key: string, sep: string, quote: string, scheme: string | undefined, value: string) =>
      value.includes(MASK_MARKER) ? m : `${key}${sep}${quote}${scheme ?? ""}${mask(value)}${quote}`,
  );
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(KEY_VALUE_UNTERMINATED, (m, key: string, sep: string, quote: string, value: string) =>
    value.includes(MASK_MARKER) ? m : `${key}${sep}${quote}${mask(value)}`,
  );
  return out;
}

/** Deep copy with credential VALUES replaced. Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]). Anything unrecognised is copied as-is. */
export function redactSecrets(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return redactSecretsInText(input);
  if (depth > 12 || input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => {
      // ACP env entries: {name: "OMB_COMMS_TOKEN", value: "…"}
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string };
        // A non-secret-shaped name (a custom env var, a feature flag) does
        // not clear the value of suspicion — the same content pass every
        // other string in this tree gets is what catches a credential
        // someone stashed under an ordinary-looking name.
        return isSecretName(entry.name)
          ? { ...entry, value: mask(entry.value) }
          : { ...entry, value: redactSecretsInText(entry.value) };
      }
      return redactSecrets(item, depth + 1);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    // any other string may still CONTAIN a credential (a command line, a
    // header value, a bot's reply) — the content pass catches those
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}
