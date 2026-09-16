// Grok (HTTP) works in a bot workspace, like every other engine that can
// read and write files.
//
// `worksInWorkspace` was hardcoded to exclude `grok` and `boxAgent` on both
// the 1:1 and the room lane, under a comment reading "API/box engines have
// no local filesystem story".  That stopped being true of the API engines
// when #442 gave them workspace file tools through the
// `workspaceOrHostComputer` gate: MiniMax and OpenAI-compat gained
// `read_file` / `write_file` / `edit_file` plus MEMORY.md and the skills
// index, and Grok did not — not because of a capability it lacks, but
// because it never got a workspace at all.  A Grok bot with no "This
// Computer" grant therefore had seven tools and no persistence of any kind.
//
// boxAgent stays excluded, and for a different reason: its turn runs on
// box.ascii.dev, so a folder on this machine is not one it can open.
//
// The engine is `server/testing/fake-openai-server.ts` — the Grok driver's
// `config.url` points at it, so the real harness runs a real Grok turn over
// the loopback and the assertions read the exact request body it sent.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

const says = (text: string) => ({
  kind: "sse" as const,
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

interface CompletionBody {
  messages?: Array<{ role?: string; content?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}

posixOnly("a Grok bot works in its own workspace", () => {
  let child: ChildProcess;
  let engine: FakeOpenAiServer;
  let home: string;
  let base: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const until = async <T,>(probe: () => Promise<T | null>, what: string, timeoutMs = 30_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = await probe();
      if (hit !== null && hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const botById = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === id);

  /** The last body the harness POSTed to the fake engine. */
  const lastCompletion = (): CompletionBody => {
    const rounds = engine.requests.filter((r) => r.url.includes("/chat/completions"));
    // SAFETY: the fake engine records the JSON body the harness POSTed, and
    // the caller has already asserted at least one round ran.
    return rounds[rounds.length - 1]!.body as CompletionBody;
  };

  beforeAll(async () => {
    engine = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "omb-grok-workspace-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grok",
            // `config.url` wins over the driver's default, and the fake
            // server's url already carries the /v1 the driver expects.
            config: { url: engine.url },
            // A placeholder: the fake engine never checks it, and this must
            // never be a real credential.
            environment: { XAI_API_KEY: "fake-key-for-tests" },
          },
        },
      }),
      { mode: 0o600 },
    );
    const port = await freePortBlock([0]);
    base = `http://127.0.0.1:${port}`;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await engine?.close();
    await removeTempDir(home);
  });

  it(
    "offers the workspace file tools and carries the memory and skills blocks",
    async () => {
      const created = await api("POST", "/api/bots");
      expect(created.status).toBe(201);
      const bot = created.body.bot;
      expect(
        (await api("PATCH", `/api/bots/${bot.id}`, {
          name: "Scribe",
          // No "This Computer" grant: the workspace has to be the only
          // source of file tools, which is exactly the bot this gap left
          // with seven tools and no memory.
          computers: [],
          modelSelection: { instanceId: "grok", model: "grok-4-fast" },
        })).status,
      ).toBe(200);

      // One enabled skill, written straight into the manifest the workspace
      // reads.  The import ROUTE fetches from GitHub, which a test must not
      // do; the on-disk shape is the same either way.
      const skillsDir = join(home, ".botfleet", "workspaces", bot.id, "skills");
      mkdirSync(join(skillsDir, "release-notes"), { recursive: true });
      writeFileSync(
        join(skillsDir, "release-notes", "SKILL.md"),
        "---\nname: release-notes\ndescription: Writes the release notes the way this team writes them.\n---\n\nDo the thing.\n",
      );
      writeFileSync(
        join(skillsDir, "skills.json"),
        `${JSON.stringify(
          {
            "release-notes": {
              description: "Writes the release notes the way this team writes them.",
              enabled: true,
              source: "github.com/example/skills/release-notes",
              sha256: "0".repeat(64),
              importedAt: new Date().toISOString(),
              warnings: [],
              skippedFiles: [],
            },
          },
          null,
          2,
        )}\n`,
      );

      engine.queueCompletion(says("Noted."));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "remember my timezone" })).status).toBe(202);
      await until(async () => ((await botById(bot.id))?.busy === false ? true : null), "the grok turn");

      const sent = lastCompletion();
      const offered = (sent.tools ?? []).map((t) => t.function?.name);
      // The three workspace file tools #442 built the gate for.
      expect(offered).toContain("read_file");
      expect(offered).toContain("write_file");
      expect(offered).toContain("edit_file");

      const system = (sent.messages ?? []).find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("Your private long-term memory file is");
      expect(system).toContain("MEMORY.md");
      // the same ternary emits both, so the skills index proves the gate
      expect(system).toContain("Imported skills");
      expect(system).toContain("release-notes");
    },
    60_000,
  );
});
