import { InstanceInfo } from "@/state/store";

import { AlertTriangle, RefreshCw, Play, Send, Zap, RotateCcw, Download, Terminal, Laptop, Monitor } from "lucide-react";

import { EngineSetup } from "./EngineSetup";

export const ERROR_RECOVERY_EVENT = "omb-error-recovery";

export type ErrorRecoveryAction =
  | "switch-model"
  | "add-key"
  | "open-computer"
  | "use-this-computer"
  | "create-local-vm";

export type ErrorRecoveryDetail = {
  action: ErrorRecoveryAction;
  botId?: string;
};

export function requestErrorRecovery(action: ErrorRecoveryAction, botId?: string): void {
  window.dispatchEvent(new CustomEvent(ERROR_RECOVERY_EVENT, { detail: { action, botId } satisfies ErrorRecoveryDetail }));
}

export function isComputerDispatchError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("computer tool failed") ||
    lower.includes("no computer") ||
    lower.includes("local vm") ||
    lower.includes("this computer") ||
    lower.includes("desktop failed") ||
    lower.includes("provision")
  );
}

export function isProviderError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("provider") ||
    lower.includes("api key") ||
    lower.includes("rate limit") ||
    lower.includes("model")
  );
}

function RecoveryButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof RefreshCw;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
    >
      <Icon size={12} /> {label}
    </button>
  );
}

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
  botId,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
  botId?: string;
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
          <div className="mt-1.5">
            <RecoveryButton icon={Play} label="Continue" onClick={onRetry} />
          </div>
        ) : message.includes("queued message failed") && onRetry ? (
          <div className="mt-1.5">
            <RecoveryButton icon={Send} label="Send Again" onClick={onRetry} />
          </div>
        ) : message.includes("offline missed routine") && onRetry ? (
          <div className="mt-1.5">
            <RecoveryButton icon={Zap} label="Run Missed Routine Now" onClick={onRetry} />
          </div>
        ) : message.includes("webhook ingress failed") && onRetry ? (
          <div className="mt-1.5">
            <RecoveryButton icon={RotateCcw} label="Restart Receiver" onClick={onRetry} />
          </div>
        ) : message.includes("git checkpoint missing") && onRetry ? (
          <div className="mt-2 p-2 bg-black/10 rounded-md">
            <div className="flex items-center gap-1.5 text-[12.5px] font-mono text-danger/90">
              <Terminal size={12} /> git fetch origin && git checkout main
            </div>
          </div>
        ) : message.includes("auto-update failed") && onRetry ? (
          <div className="flex items-center gap-2 mt-1.5">
            <RecoveryButton icon={RefreshCw} label="Retry" onClick={onRetry} />
            <a href="https://botfleet.io/download" className="flex items-center gap-1.5 rounded-full bg-danger/10 border border-danger/20 px-2.5 py-1 text-[12.5px] hover:bg-danger/20 text-danger">
              <Download size={12} /> Get It From The Website
            </a>
          </div>
        ) : isComputerDispatchError(message) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {onRetry && <RecoveryButton icon={RefreshCw} label="Retry" onClick={onRetry} />}
            <RecoveryButton icon={Monitor} label="Open Computer" onClick={() => requestErrorRecovery("open-computer", botId)} />
            <RecoveryButton icon={Laptop} label="Use This Computer" onClick={() => requestErrorRecovery("use-this-computer", botId)} />
            <RecoveryButton icon={Monitor} label="Create Local VM" onClick={() => requestErrorRecovery("create-local-vm", botId)} />
          </div>
        ) : isProviderError(message) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {onRetry && (
              <RecoveryButton icon={RefreshCw} label="Retry With Fallback" onClick={onRetry} />
            )}
            <RecoveryButton icon={RefreshCw} label="Switch Model" onClick={() => requestErrorRecovery("switch-model", botId)} />
            <RecoveryButton icon={RefreshCw} label="Add API Key" onClick={() => requestErrorRecovery("add-key", botId)} />
          </div>
        ) : (
          onRetry && (
            <div className="mt-1.5">
              <RecoveryButton icon={RefreshCw} label="Retry" onClick={onRetry} />
            </div>
          )
        )}
      </div>
    </div>
  );
}

export { ErrorRow };
