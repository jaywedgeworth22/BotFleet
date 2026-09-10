import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// main.mjs imports the "electron" module and runs Electron-runtime side
// effects at load time, so it cannot be imported directly under vitest —
// same constraint electron/credential-patch.node-test.mjs documents for
// CREDENTIAL_PATCH. This checks the SOURCE SHAPE of the two call sites a
// custom engine's encrypted key must be replayed from instead: a spawned
// child (inside startServerOn) and an already-running harness this launch
// only attaches to (inside startServerPackaged). Missing either one leaves
// that boot path's custom engines keyless with no error — exactly the kind
// of silent regression a source-shape check catches that manual testing
// easily misses (the attach path only fires when a harness already happens
// to be running).
const MAIN_SOURCE = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

describe("custom-engine credential replay on boot", () => {
  it("replays stored instance credentials on the SPAWN path (startServerOn's ready branch)", () => {
    const match = MAIN_SOURCE.match(
      /if \(identity\.outcome === "ready"\) \{([\s\S]*?)\n {4}\}/,
    );
    expect(match, "startServerOn's ready branch not found").not.toBeNull();
    expect(match[1]).toMatch(/await replayInstanceCredentials\(port\);/);
  });

  it("also replays stored instance credentials on the ATTACH path (startServerPackaged's attached branch)", () => {
    // The regression this closes: a harness this launch only ATTACHES to
    // (already running from an earlier launch, or another window) never
    // goes through startServerOn at all, so its own replay call is the
    // ready-branch's alone — an attached harness that has since been
    // restarted by something outside this code path had no memory of any
    // instanceKeyOverrides a prior launch's replay put into it, and every
    // custom engine with an encrypted key silently went keyless.
    const startIdx = MAIN_SOURCE.indexOf('if (result.mode === "attached") {');
    expect(startIdx, 'startServerPackaged\'s attached branch not found').toBeGreaterThan(-1);
    const attachedBranchSource = MAIN_SOURCE.slice(startIdx, startIdx + 800);
    expect(attachedBranchSource).toMatch(/await replayInstanceCredentials\(SERVER_PORT\);/);
  });

  it("declares credential:set-instance as a sibling of credential:set, not folded into its fixed CREDENTIAL_PATCH union", () => {
    expect(MAIN_SOURCE).toContain('ipcMain.handle("credential:set-instance"');
    // A custom engine's instance id is operator-chosen at creation, so it is
    // validated defensively here too (the server's own route already
    // enforces the [\w.-]+ shape) rather than trusted as an arbitrary
    // renderer-supplied string reaching a filesystem/network call.
    expect(MAIN_SOURCE).toMatch(/credential:set-instance[\s\S]{0,400}\/\^\[\\w\.-\]\+\$\//);
  });

  it("never writes a replayed or newly-set instance key to config.json — only PATCHes with ?secretStorage=external", () => {
    const startIdx = MAIN_SOURCE.indexOf('ipcMain.handle("credential:set-instance"');
    expect(startIdx).toBeGreaterThan(-1);
    const handlerSource = MAIN_SOURCE.slice(startIdx, startIdx + 2000);
    expect(handlerSource).toMatch(/secretStorage=external/);

    const replayIdx = MAIN_SOURCE.indexOf("async function replayInstanceCredentials");
    expect(replayIdx).toBeGreaterThan(-1);
    const replaySource = MAIN_SOURCE.slice(replayIdx, replayIdx + 1200);
    expect(replaySource).toMatch(/secretStorage=external/);
  });
});
