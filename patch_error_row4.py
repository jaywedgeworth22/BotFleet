with open("src/components/ErrorRow.tsx", "r") as f:
    content = f.read()

provider_error_block = '''        ) : message.toLowerCase().includes("provider") || message.toLowerCase().includes("api key") || message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("model") ? (
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
          onRetry && ('''

content = content.replace('''        ) : (
          onRetry && (''', provider_error_block)

with open("src/components/ErrorRow.tsx", "w") as f:
    f.write(content)
