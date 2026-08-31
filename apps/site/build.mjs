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
  if (prov.type === "main") return `Merged to <a href="${REPO}">main</a>`;
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

const html = template
  .replaceAll("{{TESTFLIGHT_URL}}", data.site.testflightUrl)
  .replaceAll("{{REPO_URL}}", data.site.repo)
  .replaceAll("{{UPSTREAM_URL}}", data.site.upstream)
  .replaceAll("{{ROSTER}}", data.exampleFleet.map((b) => `<span>${b}</span>`).join(""))
  .replaceAll("{{UPDATED}}", updated)
  .replaceAll("{{SECTIONS}}", data.sections.map(sectionHtml).join("\n\n"));

writeFileSync(new URL("./index.html", import.meta.url), html);
console.log(`built index.html — ${data.sections.map((s) => `${s.id}:${s.features.length}`).join(" ")} — updated ${updated}`);
