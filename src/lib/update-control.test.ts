// The renderer half: which update path the card uses, and the sentences it
// says.  Both are pure, which is the point — the components render them and
// the phone renders the same server fields, so the wording is checked once.
import { describe, expect, it } from "vitest";

import {
  availableLabel,
  bannerIsActionable,
  fetchUpdateStatus,
  idleLabel,
  installedLabel,
  isUpdateStatus,
  lastRunLabel,
  requestUpdateCheck,
  requestUpdateRun,
  runningLabel,
  shortCommit,
  updateSource,
  type UpdateStatus,
} from "./update-control";

const COMMIT = "ae8abe7d5d595b427164ddf37fecebcf7da65c05";
const NEXT = "3b30294e1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";

function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    installed: { version: "1.0.30", sourceCommit: COMMIT },
    available: null,
    checkedAt: "2026-09-13T12:00:00.000Z",
    running: null,
    lastRun: null,
    capabilities: { canCheck: true, canRun: true, reasons: [] },
    ...patch,
  };
}

const response = (body: unknown, init: { status?: number } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

describe("which path drives the card", () => {
  it("prefers the harness whenever this computer can check or install", () => {
    expect(updateSource(status(), true)).toBe("harness");
    expect(updateSource(status(), false)).toBe("harness");
    expect(updateSource(
      status({ capabilities: { canCheck: true, canRun: false, reasons: ["An update is already running."] } }),
      true,
    )).toBe("harness");
  });

  it("falls back to the release feed only when the bridge is there", () => {
    const useless = status({ capabilities: { canCheck: false, canRun: false, reasons: ["macOS only."] } });
    expect(updateSource(useless, true)).toBe("feed");
    expect(updateSource(useless, false)).toBe("none");
    expect(updateSource(null, true)).toBe("feed");
    expect(updateSource(null, false)).toBe("none");
  });
});

describe("what it says", () => {
  it("names the installed build by version and commit", () => {
    expect(installedLabel(status())).toBe("1.0.30 (ae8abe7)");
    expect(shortCommit("local")).toBe("local");
  });

  it("leads with the version when there is one, and the commit when there is not", () => {
    expect(availableLabel(status())).toBeNull();
    expect(availableLabel(status({
      available: { sourceCommit: NEXT, version: "1.0.31", aheadBy: 12, commits: [] },
    }))).toBe("Update Available: 1.0.31, 12 commits ahead");
    expect(availableLabel(status({
      available: { sourceCommit: NEXT, aheadBy: 1, commits: [] },
    }))).toBe("Update Available: 3b30294, 1 commit ahead");
  });

  it("shows a percentage only when the updater reported one", () => {
    expect(runningLabel({ runId: "r", startedAt: "", step: "Building and signing the app", logTail: [] }))
      .toBe("Building and signing the app…");
    expect(runningLabel({
      runId: "r",
      startedAt: "",
      step: "Installing dependencies",
      progress: 0.25,
      logTail: [],
    })).toBe("Installing dependencies (25%)…");
  });

  it("distinguishes the four outcomes", () => {
    const base = { runId: "r", startedAt: "", finishedAt: "", message: "" };
    expect(lastRunLabel({ ...base, outcome: "verified" })).toBe("The last update installed and verified.");
    expect(lastRunLabel({ ...base, outcome: "rolled-back" })).toBe("The last update failed and rolled back.");
    expect(lastRunLabel({ ...base, outcome: "refused" })).toBe("The last update was refused.");
    expect(lastRunLabel({ ...base, outcome: "failed" })).toBe("The last update failed.");
    expect(lastRunLabel(null)).toBeNull();
    // The updater's own sentence follows the headline, gapped.
    expect(lastRunLabel({ ...base, outcome: "failed", message: "Target is not reachable from origin/main." }))
      .toBe("The last update failed.\u00a0 Target is not reachable from origin/main.");
  });

  it("explains an idle card without pretending it checked", () => {
    expect(idleLabel(status({ checkedAt: null }))).toBe("This computer has not checked for a newer build yet.");
    expect(idleLabel(status())).toBe("BotFleet is on the newest build this computer knows about.");
    expect(idleLabel(status({
      capabilities: { canCheck: false, canRun: false, reasons: ["Updating from this computer is macOS only."] },
    }))).toBe("Updating from this computer is macOS only.");
  });

  it("only floats the popup when something is worth interrupting for", () => {
    expect(bannerIsActionable(null)).toBe(false);
    expect(bannerIsActionable(status())).toBe(false);
    expect(bannerIsActionable(status({ available: { sourceCommit: NEXT, aheadBy: 2, commits: [] } }))).toBe(true);
    expect(bannerIsActionable(status({
      running: { runId: "r", startedAt: "", step: "Building", logTail: [] },
    }))).toBe(true);
    const finished = { runId: "r", startedAt: "", finishedAt: "", message: "" };
    expect(bannerIsActionable(status({ lastRun: { ...finished, outcome: "verified" } }))).toBe(false);
    expect(bannerIsActionable(status({ lastRun: { ...finished, outcome: "rolled-back" } }))).toBe(true);
  });
});

describe("talking to the harness", () => {
  it("treats a harness that has no such route as no answer at all", async () => {
    expect(await fetchUpdateStatus(async () => response({ error: "no route" }, { status: 404 }))).toBeNull();
    expect(await fetchUpdateStatus(async () => response({ hello: true }))).toBeNull();
    expect(await fetchUpdateStatus(async () => {
      throw new Error("offline");
    })).toBeNull();
    expect(await fetchUpdateStatus(async () => response(status()))).toMatchObject({ installed: { version: "1.0.30" } });
  });

  it("sends JSON so the request is never a simple cross-origin form post", async () => {
    let seen: RequestInit | undefined;
    await requestUpdateCheck(async (_input, init) => {
      seen = init;
      return response(status());
    });
    expect(seen?.method).toBe("POST");
    expect(seen?.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("surfaces the harness's refusal verbatim", async () => {
    await expect(requestUpdateRun({}, async () =>
      response({ error: "An update is already running." }, { status: 409 }))).rejects.toThrow(
      "An update is already running.",
    );
  });

  it("asks for a forced run only when told to", async () => {
    const bodies: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return response({ runId: "run_one", status: status() }, { status: 202 });
    };
    expect((await requestUpdateRun({}, fetcher)).runId).toBe("run_one");
    await requestUpdateRun({ force: true }, fetcher);
    expect(bodies).toEqual(["{}", '{"force":true}']);
  });

  it("rejects a 202 that does not describe the run it started", async () => {
    await expect(requestUpdateRun({}, async () => response({ runId: "run_one" }, { status: 202 })))
      .rejects.toThrow("did not describe it");
  });

  it("recognises a status by shape, not by trust", () => {
    expect(isUpdateStatus(status())).toBe(true);
    expect(isUpdateStatus({ installed: { version: "1.0.30" } })).toBe(false);
    expect(isUpdateStatus("<!doctype html>")).toBe(false);
  });
});
