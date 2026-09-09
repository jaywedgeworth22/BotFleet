// Keeping secrets out of the native protocol log — and out of the transcript.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but the messages that set a session up carry
// the credentials the agent is handed: the box token and the comms token
// travel inside `session/new`'s mcpServers env, and a Composio consumer key
// travels in an MCP header.  Those logs sit in ~/.botfleet/native as
// ordinary files, are read by anyone debugging, and get pasted into issues.
//
// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
// tells you a token was passed, under which name, and how long it was —
// enough to debug "the proxy got no token" without the token being there.
//
// This lives in `shared/` rather than `server/` because the other caller is
// `shared/tool-activity.ts`, which clips a tool result down to one line for
// the transcript — and that clip has to happen AFTER redaction, not before
// (see the truncation note below).  `server/redact.ts` re-exports both
// entry points, so every existing server importer is unaffected.
//
// Truncation is the reason these patterns are shaped the way they are.  A
// secret that has been cut in half upstream has lost the closing marker a
// naive pattern anchors on — the `END … PRIVATE KEY` trailer, a JWT's third
// segment, a quoted value's closing quote.  Redacting before the clip is the
// real fix; recognising the truncated shapes is the belt to that braces,
// because the detail also arrives pre-clipped on paths we do not own.

/** Key names whose value is a credential.  Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`.  Only
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
// what would otherwise become permanent.  High precision on purpose: a
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
// ── authorization headers ────────────────────────────────────────────
// The whole value of an authorization header, whatever scheme it names.
//
// `KEY_VALUE` cannot reach this one: a scheme-prefixed credential has a
// SPACE in it, and KEY_VALUE's value is deliberately space-free so that
// prose after a colon does not match.  Anchoring on the header NAME instead
// is what makes that space safe — and it is why the scheme words are not
// spelled out here.  A bare scheme word would be a false-positive machine
// ("Basic authentication requires…", "Token expired yesterday"); the same
// word behind this header name cannot be prose.  The scheme is kept, so the
// line still says what kind of credential went out.
//
// The value runs to the END of the header value, not to the end of the first
// token, because a structured credential carries its secret in a LATER part:
// SigV4 signs with `…, Signature=<secret>` after two harmless parameters, and
// Digest's own parameters are comma-separated and individually quoted.  The
// value therefore crosses commas and semicolons.
//
// Where it STOPS is decided by CONTEXT — by how the value was introduced —
// and not by scanning forward for pairs of quotes.  That is why there are two
// patterns below rather than one.  A single pattern that stepped over
// balanced quote pairs had to answer both questions at once, and got each of
// them wrong in the other's direction: it needed a length cap on the quoted
// part so that a serialized object's siblings were not eaten, and that same
// cap is what let an OAuth `oauth_signature` longer than the cap end the
// match early and ship the signature into the transcript and into Sentry.
// Asking how the value was introduced answers both at once.

/** An authorization value INTRODUCED BY A QUOTE — the JSON and config
 * spelling, `"authorization": "Bearer …"` or `authorization='…'`.
 *
 * The quote that opened it is what ends it, so the value runs to the matching
 * close, crosses no quote at all, and takes no length cap.  Nothing past that
 * quote is touched, which is the whole point: a one-line serialized object
 * carries `,"status":"ok","message":"…"` after the header key, and those
 * siblings used to be eaten by the balanced-quote scan and were then
 * permanently missing from stored bot text and from failure details.
 *
 * A backslash escape is stepped over rather than mistaken for the close, so
 * a quote inside the string does not end the value early.  The two branches
 * are disjoint on their first character (one requires a backslash, the other
 * forbids it), which is what keeps this linear on a string that never
 * closes.
 *
 * END OF TEXT closes it too, because a value whose closing quote was clipped
 * away upstream has no other end left.  That fallback fires only where the
 * run really did reach the end — a quote of its own kind would have stopped
 * it first — so it can never be the path a terminated value takes, and the
 * siblings are still safe.  It is the one shape `KEY_VALUE_UNTERMINATED`
 * cannot reach: OAuth and Digest write ESCAPED quotes inside the value, and
 * that pattern's value class stops at the first quote of any kind. */
const AUTH_HEADER_QUOTED =
  /\b((?:proxy-)?authorization)(["']?\s*[=:]\s*)(["'])([A-Za-z][A-Za-z0-9-]{2,}\s+)?((?:\\.|(?!\3)[^\\\r\n])+)(\3|$)/gi;

/** A BARE authorization value — an HTTP header line as `curl -v`, an access
 * log, or an echoed stderr line prints it.
 *
 * Nothing closes this one but the line, so it runs to the end of the line and
 * crosses quoted parameters of ANY length.  That length is the whole defect
 * this replaces: OAuth hides its secret in `oauth_signature="…344 chars…"`
 * and SigV4 in a trailing `Signature=…`, and any cap on the quoted part ends
 * the match before either of them and leaves the signature in the clear.
 *
 * "The line" means the line the credential is on, which is not always the
 * line the header name is on: a FOLDED header (RFC 7230 obs-fold, and what
 * a pretty-printer produces) puts the break between the scheme and the
 * credential, `Digest\n  username="…", response="<secret>"`.  That is why
 * the separator after the scheme is `\s+` and not horizontal whitespace —
 * restricting it leaves the bare pattern looking at a six-character
 * `Digest` and declining, and no later pattern knows what the continuation
 * line is.
 *
 * Which quotes on that line belong to the value is decided the same way —
 * by context, and the context is not on the header line at all.  A quote in
 * a header value is just a character; the only quote that must survive is
 * the one WRAPPING the header, `curl -H "…"`, and that quote announced
 * itself before the header name.  So the value runs to the end of its line
 * and is then cut at the wrapper's closing quote if a wrapper was open —
 * see `wrapperQuoteAt`, which asks how that quote OPENED to know a delimiter
 * from prose, which nesting level it belongs to, and whether the text around
 * it is escaped — and at nothing else.
 *
 * That is the third answer this pattern has had, and the first that is a
 * rule rather than a guess.  Reading the value's own quotes to find its end
 * cannot work, because nothing on the line distinguishes a parameter's quote
 * from a wrapper's: `oauth_signature="…"` and a `Basic` credential whose
 * base64 padding leaves an `=` in front of the wrapper look identical, `\"`
 * is the parameter's delimiter inside a shell argument and an escape inside
 * it on a raw line, and a clipped parameter and a terminal wrapper both end
 * the text.  Every one of those was a real leak or a real over-mask found
 * against a version of this pattern that tried to tell them apart locally.
 * Asking who opened the quote answers all of them at once, and asking it
 * OUTSIDE the value is what makes the answer available. */
const AUTH_HEADER_BARE = /\b((?:proxy-)?authorization)(["']?\s*[=:](?!\s*["'])\s*)([A-Za-z][A-Za-z0-9-]{2,}\s+)?([^\r\n]+)/gi;

/** The quote wrapping the header, if the header sits inside one — the `"` of
 * a `curl -H "…"` argument, the `'` of its single-quoted twin, or either of
 * those already backslash-escaped because the command reached us inside a
 * string of somebody else's.
 *
 * Looks only BEFORE the header name, on its own line, because that is where a
 * wrapper announces itself and it is the one thing the value cannot tell you
 * about itself.  Three things make the answer trustworthy:
 *
 * A wrapper is ADJACENT to the header: the argument that wraps a header
 * opens immediately in front of it, whitespace apart.  `-H "…`, `-H'…`,
 * `-H"…` (shell quoting may start mid-word) and `\"…` all qualify; a quote
 * with text between it and the header name wraps something else, or nothing
 * at all.  That last case is the one that bites: `size=2"; <header>: …` and
 * `he said "wat; <header>: …` carry an unbalanced quote that delimits
 * nothing, and cutting the value there leaves a stub and hands the
 * credential back in the clear.  Adjacency is also what lets an apostrophe
 * in `it's` be harmless, without having to guess at what shell words look
 * like.
 *
 * Quotes NEST, so this keeps a stack and considers the INNERMOST still open.
 * `bash -c 'curl -H "…"'` is wrapped by the `"`, not by the `'`: the inner
 * quote is what ends the header's own argument, and answering with the outer
 * one masks straight through it and takes the rest of the command.
 *
 * And a wrapper carries its ESCAPING LEVEL, because the text may already be
 * quoted once over — a driver that hands us `curl -H \"<header>: …\" <url>`
 * has wrapper quotes spelled `\"`, and one closes the argument exactly where
 * a bare `"` would in unescaped text.  A wrapper opened as `\"` is closed by
 * `\"`; a bare one by a bare one. */
interface Wrapper {
  quote: string;
  /** the wrapper was written `\"`, so its partner is written `\"` as well */
  escaped: boolean;
}

function wrapperQuoteAt(text: string, index: number): Wrapper | undefined {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const open: Array<Wrapper & { after: number }> = [];
  for (let i = lineStart; i < index; i++) {
    let escaped = false;
    let at = i;
    if (text[i] === "\\") {
      const next = text[i + 1];
      if (next !== '"' && next !== "'") {
        i += 1; // an ordinary escape: the character behind it is content
        continue;
      }
      escaped = true;
      at = i + 1;
      i += 1;
    }
    const quote = text[at];
    if (quote !== '"' && quote !== "'") continue;
    const top = open[open.length - 1];
    if (top?.quote === quote && top.escaped === escaped) open.pop();
    else open.push({ quote, escaped, after: at + 1 });
  }
  const innermost = open[open.length - 1];
  if (!innermost) return undefined;
  // Adjacency is the whole test.  An argument that WRAPS this header opens
  // immediately in front of it, whitespace apart — `-H "…`, `-H'…`, `-H"…`,
  // `\"…`.  A quote with text between it and the header name wraps something
  // else, or nothing: `size=2"; <header>: …` and `he said "wat; <header>: …`
  // have an unbalanced quote in front of the header that delimits nothing,
  // and cutting the value there hands back the credential.
  if (!/^\s*$/.test(text.slice(innermost.after, index))) return undefined;
  return { quote: innermost.quote, escaped: innermost.escaped };
}

/** How much of a bare header value is the credential: everything up to the
 * wrapper's closing quote, written the way the wrapper's opening was, or all
 * of it when nothing wrapped the header. */
function bareValueEnd(value: string, wrapper: Wrapper | undefined): number {
  if (!wrapper) return value.length;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\") {
      if (wrapper.escaped && value[i + 1] === wrapper.quote) return i;
      i += 1;
      continue;
    }
    if (!wrapper.escaped && value[i] === wrapper.quote) return i;
  }
  return value.length;
}

/** How long a value has to be before it is worth masking.
 *
 * The eight-character floor is there to keep prose after a colon out of the
 * mask, and a RECOGNISED SCHEME retires that worry: `Basic`, `Digest` or
 * `OAuth` standing behind the header name cannot be prose, so whatever
 * follows one is a credential however short.  `Basic dTpw` is `u:p`, and
 * measuring the floor against `dTpw` alone left it in the clear. */
const minMaskable = (scheme: string | undefined) => (scheme ? 1 : 8);

const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match.
 *
 * `authorization` is deliberately NOT in this list: the two AUTH_HEADER
 * patterns above own that key end to end, and running both would mask the
 * scheme they had just kept on purpose (`AWS4-HMAC-SHA256` is a long enough
 * token to look like a value to this pattern).  The unterminated variant
 * below keeps it, because that one runs only where neither of them can
 * match at all — a quote that was opened and never closed. */
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
/** The same key list, for a value whose CLOSING quote was lost upstream.
 * `KEY_VALUE` needs `\3` to close the value, so `{"api_key":"<300 chars>"}`
 * clipped to 240 characters matches nothing and the key material goes out
 * intact.  Anchored at end-of-text, because that is the only place a quote
 * that never closes can legitimately come from: something cut the string.
 * The value class is deliberately wide (anything but a quote) — over-redacting
 * the tail of a string that was already truncated costs a reader nothing. */
const KEY_VALUE_UNTERMINATED =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["'])([^"']{8,})$/i;

/** Text that is nothing but masks already.
 *
 * Redaction runs twice by design — once in `describeResult()` before the
 * clip, once in the Sentry observer for a detail that arrived some other way
 * — and a second pass must not mask a mask, because it would then report the
 * marker's length instead of the secret's, and the length is the part a
 * reader debugs with.
 *
 * WHOLLY masked, not "contains a mask", and the distinction is load-bearing:
 * a value that is only partly masked still has a live secret in the rest of
 * it, so it must go through the pass again.  That is why this is not a
 * `includes()` check — a SigV4 header whose `AKIA…` had been masked by the
 * prefix pass would have looked "already done" and shipped its signature. */
const WHOLLY_MASKED = /^[\s,;]*(?:«redacted \d+ chars»[\s,;]*)+$/;

export function redactSecretsInText(text: string): string {
  if (!text || text.length < 8) return text;
  let out = text;
  out = out.replace(PEM_BLOCK, (m, open: string, body: string, close: string) => {
    const trimmed = body.trim();
    if (WHOLLY_MASKED.test(trimmed)) return m; // already redacted; keep the reported length
    if (!trimmed && !close) return open;
    const masked = mask(trimmed);
    return close ? `${open}\n${masked}\n${close}` : `${open}\n${masked}`;
  });
  // The authorization header goes FIRST, before the prefix pass.  Its value
  // is a whole credential, and a prefix pass that had already masked one part
  // of it (SigV4 carries an `AKIA…` access-key id before the signature) would
  // leave a partly-masked value behind for this pass to trip over.
  //
  // Quote-introduced first, bare second.  They cannot both claim the same
  // header — the bare one refuses a value that opens with a quote — so the
  // order is only about reading the two rules in the order they are written.
  // Both keep a value that is WHOLLY masked already, and both decline a value
  // too short to be a credential rather than masking the prose after a colon.
  out = out.replace(
    AUTH_HEADER_QUOTED,
    (m, key: string, sep: string, quote: string, scheme: string | undefined, value: string, close: string) => {
      // A value that ran to the end of the text lost its closing quote to a
      // clip, and the scheme goes INSIDE the mask on that path alone.  That
      // is not cosmetic: `KEY_VALUE_UNTERMINATED` still lists `authorization`
      // and still sees this shape, and only a WHOLLY masked value makes it
      // stand down — a `Basic «redacted …»` left behind would be masked a
      // second time and would then report the marker's length instead of the
      // secret's.  Masking scheme and value together reproduces, byte for
      // byte, what that pass produced before this one could reach the shape.
      const body = close ? value : `${scheme ?? ""}${value}`;
      if (body.length < minMaskable(scheme) || WHOLLY_MASKED.test(body)) return m;
      const kept = close ? (scheme ?? "") : "";
      return `${key}${sep}${quote}${kept}${mask(body)}${close}`;
    },
  );
  out = out.replace(
    AUTH_HEADER_BARE,
    (m, key: string, sep: string, scheme: string | undefined, value: string, offset: number, whole: string) => {
      // trailing blanks are the line's, not the credential's, so they stay
      // outside the mask and out of the length it reports
      const end = bareValueEnd(value, wrapperQuoteAt(whole, offset));
      // trailing blanks are the line's, not the credential's, so they stay
      // outside the mask and out of the length it reports
      const credential = value.slice(0, end).replace(/[^\S\r\n]+$/, "");
      if (credential.length < minMaskable(scheme) || WHOLLY_MASKED.test(credential)) return m;
      return `${key}${sep}${scheme ?? ""}${mask(credential)}${value.slice(credential.length)}`;
    },
  );
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(KEY_VALUE_UNTERMINATED, (m, key: string, sep: string, quote: string, value: string) =>
    WHOLLY_MASKED.test(value) ? m : `${key}${sep}${quote}${mask(value)}`,
  );
  return out;
}

/** Deep copy with credential VALUES replaced.  Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]).  Anything unrecognised is copied as-is. */
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
