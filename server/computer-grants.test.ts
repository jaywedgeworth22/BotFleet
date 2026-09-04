import { describe, expect, it } from "vitest";
import {
  computerLabel,
  computerSystemPrompt,
  hostToolPrefix,
  nameMounts,
  turnComputerMounts,
  type ComputerMount,
} from "./computer-grants.ts";
import { buildMcpServers } from "./drivers/pi.ts";
import type { SendTurnInput } from "./contracts.ts";

const stdio = (env: Record<string, string> = {}) => ({ command: "/bin/cua", args: ["mcp"], env });
const hostStdio = () => ({ ...stdio(), scope: "local-computer" as const });
const box = () => ({ kind: "box" as const, boxId: "b1", token: "t" });

const mount = (kind: ComputerMount["kind"], stdioOrBox: "stdio" | "box" = "stdio"): ComputerMount => ({
  name: "",
  label: computerLabel(kind, "darwin"),
  kind,
  ...(stdioOrBox === "box" ? { box: box() } : { stdio: kind === "local" ? hostStdio() : stdio() }),
});

describe("nameMounts", () => {
  it("keeps the historical server name when there is exactly one computer", () => {
    expect(nameMounts([mount("vps")]).map((m) => m.name)).toEqual(["computer"]);
    expect(nameMounts([mount("local")]).map((m) => m.name)).toEqual(["computer"]);
  });

  it("gives each computer a distinct, self-describing name once there are several", () => {
    expect(nameMounts([mount("vps"), mount("local")]).map((m) => m.name)).toEqual([
      "computer_shared_vm",
      "computer_host",
    ]);
    expect(nameMounts([mount("box", "box"), mount("vm")]).map((m) => m.name)).toEqual([
      "computer_box",
      "computer_local_vm",
    ]);
  });

  it("names nothing when nothing was granted", () => {
    expect(nameMounts([])).toEqual([]);
  });
});

describe("turnComputerMounts", () => {
  it("returns the granted computers when the turn carries them", () => {
    const computers = nameMounts([mount("vps"), mount("local")]);
    expect(turnComputerMounts({ computers }).map((m) => m.kind)).toEqual(["vps", "local"]);
  });

  it("normalizes a legacy single-box turn under the historical name", () => {
    const [only] = turnComputerMounts({ computer: box() });
    expect(only.name).toBe("computer");
    expect(only.kind).toBe("box");
    expect(only.box).toEqual(box());
  });

  it("reads scope to tell a legacy host computer from a legacy sandbox", () => {
    expect(turnComputerMounts({ localComputer: hostStdio() })[0].kind).toBe("local");
    expect(turnComputerMounts({ localComputer: stdio() })[0].kind).toBe("vm");
  });

  it("is empty for a turn with no computer at all", () => {
    expect(turnComputerMounts({})).toEqual([]);
    expect(turnComputerMounts(undefined)).toEqual([]);
  });
});

describe("hostToolPrefix", () => {
  it("is null when no granted computer is the person's own machine", () => {
    expect(hostToolPrefix(nameMounts([mount("vps")]))).toBeNull();
    expect(hostToolPrefix(nameMounts([mount("vps"), mount("vm")]))).toBeNull();
  });

  it("points at the host's own tools, never at a remote desktop's", () => {
    expect(hostToolPrefix(nameMounts([mount("local")]))).toBe("mcp__computer");
    // The whole point of scoping by prefix: the shared VM's tools also start
    // with "mcp__computer", and must NOT be treated as the person's desktop.
    expect(hostToolPrefix(nameMounts([mount("vps"), mount("local")]))).toBe("mcp__computer_host");
  });
});

describe("computerSystemPrompt", () => {
  it("says nothing when the bot has no computer", () => {
    expect(computerSystemPrompt([])).toBe("");
  });

  it("keeps the established wording for a single computer", () => {
    const one = computerSystemPrompt(nameMounts([mount("vps")]));
    expect(one).toContain("You have your own self-hosted remote Linux computer");
    expect(one).toContain("protected-input step");
    // no multi-computer machinery leaks into the single case
    expect(one).not.toContain("Default to");
    expect(one).not.toContain("mcp__computer_");
  });

  it("does not describe the box to the agent already running on it", () => {
    const mounts = nameMounts([mount("box", "box")]);
    expect(computerSystemPrompt(mounts, { boxAgent: true })).not.toContain("your own cloud computer");
    expect(computerSystemPrompt(mounts, { boxAgent: false })).toContain("your own cloud computer");
  });

  it("names every computer and its tool prefix when the bot holds several", () => {
    const prompt = computerSystemPrompt(nameMounts([mount("vps"), mount("local")]), {
      hostPlatform: "darwin",
    });
    expect(prompt).toContain("You have 2 computers");
    expect(prompt).toContain("mcp__computer_shared_vm__");
    expect(prompt).toContain("mcp__computer_host__");
    expect(prompt).toContain("Shared VM");
    expect(prompt).toContain("This Mac");
  });

  it("states the owner's selection rule: remote by default, host only when it earns it", () => {
    const prompt = computerSystemPrompt(nameMounts([mount("vps"), mount("local")]), {
      hostPlatform: "darwin",
    });
    expect(prompt).toContain("Default to Shared VM for everything");
    expect(prompt).toContain("Xcode");
    expect(prompt).toContain("twice as fast");
    expect(prompt).toContain("five minutes");
    // both halves are required — the speed exception is not a 2x-alone rule
    expect(prompt).toContain("Both conditions must hold");
  });

  it("omits the host-versus-remote rule when there is no host to choose", () => {
    const prompt = computerSystemPrompt(nameMounts([mount("vps"), mount("vm")]));
    expect(prompt).toContain("You have 2 computers");
    expect(prompt).not.toContain("Default to");
  });
});

describe("driver mounting (pi)", () => {
  // threadId and text are the only required fields, so the turn needs no cast.
  const turn = (integrations: SendTurnInput["integrations"]): SendTurnInput => ({
    threadId: "t",
    text: "hi",
    integrations,
  });

  it("mounts a single computer under the historical name", () => {
    const servers = buildMcpServers(turn({ computers: nameMounts([mount("vps")]) }));
    expect(Object.keys(servers ?? {})).toEqual(["computer"]);
  });

  it("mounts BOTH computers when a bot was granted both", () => {
    // The regression this module exists for: the drivers used an if/else if
    // keyed on one slot, so a bot holding a shared VM and this Mac silently
    // received only the VM. Access to both means two servers, not a winner.
    const servers = buildMcpServers(turn({ computers: nameMounts([mount("vps"), mount("local")]) }));
    expect(Object.keys(servers ?? {}).sort()).toEqual(["computer_host", "computer_shared_vm"]);
  });

  it("carries host scope on the host mount alone", () => {
    const servers = buildMcpServers(turn({ computers: nameMounts([mount("vps"), mount("local")]) })) ?? {};
    expect(servers.computer_host).toMatchObject({ scope: "local-computer" });
    expect(servers.computer_shared_vm).not.toHaveProperty("scope");
  });

  it("still mounts a legacy single-computer turn", () => {
    expect(Object.keys(buildMcpServers(turn({ localComputer: hostStdio() })) ?? {})).toEqual(["computer"]);
    expect(Object.keys(buildMcpServers(turn({ computer: box() })) ?? {})).toEqual(["computer"]);
  });

  it("mounts nothing when no computer was granted", () => {
    expect(buildMcpServers(turn({}))).toBeNull();
  });
});
