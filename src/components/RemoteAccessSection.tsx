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

type RemoteAccessTestResult =
  | { kind: "running" }
  | { kind: "ok"; reason: string; tunnel?: string }
  | { kind: "error"; reason: string; tunnel?: string };

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
      // SAFETY: /api/ingress/test guarantees an IngressProbeResult JSON payload with ok and reason.
      const body = (await response.json()) as {
        ok: boolean;
        reason: string;
        tunnel?: string;
      };
      setTest(
        body.ok
          ? { kind: "ok", reason: body.reason, tunnel: body.tunnel }
          : { kind: "error", reason: body.reason, tunnel: body.tunnel },
      );
    } catch (cause) {
      setTest({ kind: "error", reason: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const buttonSecondary =
    "rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <Card title={REMOTE_ACCESS_HEADING} subtitle={sentenceGapHtml(REMOTE_ACCESS_BLURB)}>
      <div className="flex flex-col gap-3">
        <CopyableValue label={REMOTE_URL_LABEL} value={NAMED_REMOTE_URL} />
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void runTest()}
            disabled={test?.kind === "running"}
            aria-label="Test Remote Access"
            className={buttonSecondary}
          >
            {test?.kind === "running" ? "Testing…" : "Test Connection"}
          </button>
          {test && test.kind !== "running" ? (
            <span
              role={test.kind === "ok" ? "status" : "alert"}
              data-testid="remote-access-test-result"
              className={`text-[12px] leading-relaxed ${test.kind === "ok" ? "text-success" : "text-danger"}`}
            >
              {test.reason}
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function CompanionGatewayCard() {
  return <Card title={COMPANION_GATEWAY_LABEL} subtitle={sentenceGapHtml(COMPANION_GATEWAY_BLURB)} />;
}

