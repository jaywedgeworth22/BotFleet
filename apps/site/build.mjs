#!/usr/bin/env node
// Renders index.html from template.html + features.json.
// Rules encoded here: a section with zero features is hidden entirely
// (owner rule: hide Established if nothing qualifies); descriptions are
// trusted HTML (sentence gaps use &nbsp; per fleet copy rules).
import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("./features.json", import.meta.url), "utf8"));
const template = readFileSync(new URL("./template.html", import.meta.url), "utf8");
const REPO = data.site.repo;

function provHtml(prov) {
  if (prov.type === "host") return prov.note;
  if (prov.type === "main") {
    const note = prov.note ? ` · ${prov.note}` : "";
    return `Merged to <a href="${REPO}">main</a>${note}`;
  }
  if (prov.type === "pr") {
    const links = prov.prs.map((n) => `<a href="${REPO}/pull/${n}">#${n}</a>`).join(", ");
    const plural = prov.prs.length > 1 ? "Pull requests" : "Pull request";
    const state = prov.note ?? prov.state;
    return `${plural} ${links} · ${state}`;
  }
  throw new Error(`unknown prov type: ${prov.type}`);
}

function cardHtml(f) {
  return `      <article class="card">
        <h3>${f.title}</h3>
        <p>${f.desc}</p>
        <div class="prov">${provHtml(f.prov)}</div>
      </article>`;
}

function sectionHtml(s) {
  if (!s.features.length) return "";
  return `  <section class="features" id="${s.id}">
    <h2>${s.title} <span class="badge ${s.badge}">${s.badgeLabel}</span></h2>
    <p class="sub">${s.sub}</p>
    <div class="grid">

${s.features.map(cardHtml).join("\n\n")}

    </div>
  </section>`;
}

const updated = new Date().toLocaleDateString("en-US", {
  weekday: "short", month: "short", day: "numeric", year: "numeric",
  timeZone: "America/Chicago",
});

function sentrySnippet(dsn) {
  const trimmed = (dsn || "").trim();
  if (!trimmed.startsWith("https://")) return "";
  // Public client DSN only.  Do not log the value.
  const json = JSON.stringify(trimmed);
  return `<script src="https://browser.sentry-cdn.com/10.73.0/bundle.tracing.replay.feedback.min.js" crossorigin="anonymous"></script>
<script>
(function () {
  if (typeof Sentry === "undefined") return;
  Sentry.init({
    dsn: ${json},
    environment: "production",
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    enableLogs: true,
    integrations: [
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
      Sentry.feedbackIntegration({ colorScheme: "light", autoInject: true, showBranding: false, buttonLabel: "Report a problem", submitButtonLabel: "Send", formTitle: "Report a problem" })
    ]
  });
})();
</script>`;
}

const html = template
  .replaceAll("{{TESTFLIGHT_URL}}", data.site.testflightUrl)
  .replaceAll("{{REPO_URL}}", data.site.repo)
  .replaceAll("{{UPSTREAM_URL}}", data.site.upstream)
  .replaceAll("{{RELEASES_URL}}", data.site.releases)
  .replaceAll("{{MAC_DOWNLOAD_URL}}", data.site.macDownload)
  .replaceAll("{{ROSTER}}", data.exampleFleet.map((b) => `<span>${b}</span>`).join(""))
  .replaceAll("{{UPDATED}}", updated)
  .replaceAll("{{SECTIONS}}", data.sections.map(sectionHtml).join("\n\n"))
  .replaceAll("{{SENTRY_SNIPPET}}", sentrySnippet(process.env.VITE_SENTRY_DSN));

writeFileSync(new URL("./index.html", import.meta.url), html);
console.log(`built index.html — ${data.sections.map((s) => `${s.id}:${s.features.length}`).join(" ")} — updated ${updated}`);
