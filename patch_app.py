import re

with open("src/App.tsx", "r") as f:
    content = f.read()

toast_code = """
function GlobalErrorToast() {
  const { state, dispatch } = useStore();
  if (!state.error) return null;
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] max-w-md w-full shadow-2xl rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger flex items-start gap-3 backdrop-blur-md">
      <div className="flex-1">
        <p className="font-semibold mb-1 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          System Error
        </p>
        <p className="break-words">{state.error}</p>
        <div className="mt-2 flex gap-3 font-medium">
          <button className="underline hover:opacity-80" onClick={() => window.location.reload()}>Reload App</button>
          <button className="underline hover:opacity-80" onClick={() => dispatch({ type: "toggleSettings", open: true })}>Open Settings</button>
        </div>
      </div>
      <button onClick={() => dispatch({ type: "error", message: null })} className="p-1 opacity-70 hover:opacity-100">&times;</button>
    </div>
  );
}
"""

if "function GlobalErrorToast" not in content:
    content = content.replace("export function App() {", toast_code + "\nexport function App() {")

if "<GlobalErrorToast />" not in content:
    content = content.replace("<div className=\"flex h-screen w-screen overflow-hidden bg-app text-ink selection:bg-accent/30 selection:text-ink\">", "<div className=\"flex h-screen w-screen overflow-hidden bg-app text-ink selection:bg-accent/30 selection:text-ink\">\n      <GlobalErrorToast />")

with open("src/App.tsx", "w") as f:
    f.write(content)
