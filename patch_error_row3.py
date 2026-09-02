with open("src/components/ErrorRow.tsx", "r") as f:
    content = f.read()

import_lucide = 'import { AlertTriangle, RefreshCw, Play, Send, Zap, RotateCcw, Download, Terminal } from "lucide-react";'
content = content.replace('import { AlertTriangle, RefreshCw } from "lucide-react";', import_lucide)

replace_target = '''        {setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              <RefreshCw size={12} /> Retry
            </button>
          )
        )}'''

replace_with = '''        {setupInstance && !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
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
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              <RefreshCw size={12} /> Retry
            </button>
          )
        )}'''

content = content.replace(replace_target, replace_with)

with open("src/components/ErrorRow.tsx", "w") as f:
    f.write(content)
