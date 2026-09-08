import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applySkin, followsComputerLook, readSkin } from "./lib/skins";
import { initSentry, initSentryFromRuntime } from "./lib/sentry";
import "./styles.css";

initSentry();
// Runtime fallback for the desktop app and dev/attached windows, where no
// DSN was inlined at build time: ask the harness what it resolved. A no-op
// when initSentry() above already started the SDK from a build-time DSN.
void initSentryFromRuntime();

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first.
applySkin(readSkin());

if (globalThis.window && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const pref = readSkin();
    if (followsComputerLook(pref)) applySkin(pref);
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
