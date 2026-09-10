import { useState } from "react";
import {
  COMPANION_GATEWAY_BLURB,
  COMPANION_GATEWAY_LABEL,
  NAMED_REMOTE_URL,
  REMOTE_ACCESS_BLURB,
  REMOTE_ACCESS_HEADING,
  REMOTE_URL_LABEL,
  sentenceGapHtml,
} from "@/lib/remote-access";
import { Card, CopyableValue } from "./SettingsPrimitives";

export type RemoteAccessTestResult =
  | { kind: "running" }
  | { kind: "ok"; reason: string; tunnel?: string }
  | { kind: "error"; reason: string; tunnel?: string };

/**
 * Turns a raw /api/ingress/test fetch outcome into a RemoteAccessTestResult.
 *
 * A successful response carries an IngressProbeResult ({ ok, reason, tunnel? }).
 * A non-2xx response does NOT: when the packaged renderer talks through the
 * attached-UI shim (electron/attached-ui-shim.mjs proxyHttp) and the local
 * harness is unreachable, the shim answers with its own HTTP 502 and a plain
 * { error: string } body. Casting that shape to IngressProbeResult reads a
 * falsey `ok` and an undefined `reason`, so the control would display a blank
 * error exactly when there is something useful to say. Check response.ok
 * first and surface the shim's `error` field in that case.
 */
export function describeIngressTestOutcome(
  ok: boolean,
  status: number,
  body: unknown,
): RemoteAccessTestResult {
  if (!ok) {
    const error =
      typeof body === "object" && body !== null && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : undefined;
    return { kind: "error", reason: error ?? `Request failed with status ${status}` };
  }
  const parsed = body as { ok: boolean; reason: string; tunnel?: string };
  return parsed.ok
    ? { kind: "ok", reason: parsed.reason, tunnel: parsed.tunnel }
    : { kind: "error", reason: parsed.reason, tunnel: parsed.tunnel };
}

const buttonSecondary =
  "rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * The button + status region, split out so its accessible-name and live-region
 * behavior across all three test states (idle/running/done) can be unit
 * tested without driving a real fetch through RemoteAccessSection.
 */
export function TestConnectionControl({
  test,
  onRunTest,
}: {
  test: RemoteAccessTestResult | null;
  onRunTest: () => void;
}) {
  const running = test?.kind === "running";
  return (
    <>
      <button
        onClick={onRunTest}
        disabled={running}
        // The visible label swaps to "Testing…" while the probe runs, but a
        // fixed aria-label would keep announcing "Test Remote Access" the
        // whole time — screen-reader users would get no indication the
        // five-second probe even started. Mirror the running state in the
        // accessible name and mark the control aria-busy to match.
        aria-label={running ? "Testing Remote Access…" : "Test Remote Access"}
        aria-busy={running}
        className={buttonSecondary}
      >
        {running ? "Testing…" : "Test Connection"}
      </button>
      {test ? (
        running ? (
          <span role="status" aria-live="polite" className="text-[12px] leading-relaxed text-ink-secondary">
            Testing connection…
          </span>
        ) : (
          <span
            role={test.kind === "ok" ? "status" : "alert"}
            aria-live="polite"
            data-testid="remote-access-test-result"
            className={`text-[12px] leading-relaxed ${test.kind === "ok" ? "text-success" : "text-danger"}`}
          >
            {test.reason}
          </span>
        )
      ) : null}
    </>
  );
}

export function RemoteAccessSection() {
  const [test, setTest] = useState<RemoteAccessTestResult | null>(null);

  const runTest = async () => {
    setTest({ kind: "running" });
    try {
      // Probe /api/health, not the bare root: Cloudflare Access protects
      // everything on this tunnel except that one path, so a bare-root
      // probe would just follow the redirect to the Access login page and
      // report HTTP 200 even when the tunnel or the BotFleet origin
      // behind it is down. /api/health is public and probeIngressUrl
      // requires its real BotFleet payload for this exact path.
      const response = await fetch("/api/ingress/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicUrl: `${NAMED_REMOTE_URL}/api/health` }),
      });
      const body = await response.json().catch(() => null);
      setTest(describeIngressTestOutcome(response.ok, response.status, body));
    } catch (cause) {
      setTest({ kind: "error", reason: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <Card title={REMOTE_ACCESS_HEADING} subtitle={sentenceGapHtml(REMOTE_ACCESS_BLURB)}>
      <div className="flex flex-col gap-3">
        <CopyableValue label={REMOTE_URL_LABEL} value={NAMED_REMOTE_URL} />
        <div className="flex flex-wrap items-center gap-3">
          <TestConnectionControl test={test} onRunTest={() => void runTest()} />
        </div>
      </div>
    </Card>
  );
}

export function CompanionGatewayCard() {
  return <Card title={COMPANION_GATEWAY_LABEL} subtitle={sentenceGapHtml(COMPANION_GATEWAY_BLURB)} />;
}

