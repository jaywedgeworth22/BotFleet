import { InstanceInfo } from "@/state/store";


import { AlertTriangle, RefreshCw, Play, Send, Zap, RotateCcw, Download, Terminal } from "lucide-react";

import { EngineSetup } from "./EngineSetup";


/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
function ErrorRow({
  message,
  onRetry,
  setupInstance,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
}) {
  return (
    <div className="flex justify-start">
      <div className="w-fit max-w-[min(42rem,78%)] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{message}</span>
        </div>
        {setupInstance && !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : message.includes("stall watchdog timeout") && onRetry ? (
          <button onClick={onRetry} className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
            <Play size={12} /> Continue
          </button>
        ) : message.includes("queued message failed") && onRetry ? (
          <button onClick={onRetry} className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
            <Send size={12} /> Send Again
          </button>
        ) : message.includes("offline missed routine") && onRetry ? (
          <button onClick={onRetry} className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
            <Zap size={12} /> Run Missed Routine Now
          </button>
        ) : message.includes("webhook ingress failed") && onRetry ? (
          <button onClick={onRetry} className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
            <RotateCcw size={12} /> Restart Receiver
          </button>
        ) : message.includes("git checkpoint missing") && onRetry ? (
          <div className="mt-2 p-2 bg-black/10 rounded-md">
            <div className="flex items-center gap-1.5 text-[12.5px] font-mono text-danger/90">
              <Terminal size={12} /> git fetch origin && git checkout main
            </div>
          </div>
        ) : message.includes("auto-update failed") && onRetry ? (
          <div className="flex items-center gap-2 mt-1.5">
            <button onClick={onRetry} className="flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
              <RefreshCw size={12} /> Retry
            </button>
            <a href="https://botfleet.io/download" className="flex items-center gap-1.5 rounded-full bg-danger/10 border border-danger/20 px-2.5 py-1 text-[12.5px] hover:bg-danger/20 text-danger">
              <Download size={12} /> Get It From The Website
            </a>
          </div>
        ) : message.toLowerCase().includes("provider") || message.toLowerCase().includes("api key") || message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("model") ? (
          <div className="flex items-center flex-wrap gap-2 mt-1.5">
            {onRetry && (
              <button onClick={onRetry} className="flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
                <RefreshCw size={12} /> Retry With Fallback
              </button>
            )}
            <button onClick={() => window.dispatchEvent(new CustomEvent("open-settings", { detail: { view: "model" } }))} className="flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
              Switch Model
            </button>
            <button onClick={() => window.dispatchEvent(new CustomEvent("open-settings", { detail: { view: "keys" } }))} className="flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15">
              Add API Key
            </button>
          </div>
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              <RefreshCw size={12} /> Retry
            </button>
          )
        )}
      </div>
    </div>
  );
}

export { ErrorRow };
