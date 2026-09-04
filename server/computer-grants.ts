/** Computer grants: a bot may hold more than one computer at a time.
 *
 * The picker in Settings has always stored an ARRAY of destinations, but for
 * a long time the runtime read only `computers[0]` and the drivers mounted a
 * single MCP server named "computer" behind an `if/else if`. A bot granted
 * both a remote desktop and this machine therefore got exactly one of them,
 * silently, with the remote always winning. That is a routing decision the
 * agent should be making per task, not one the harness should make once.
 *
 * So a grant is a capability, never a preference: every granted computer is
 * mounted as its own MCP server with its own tool prefix, and the agent picks.
 * Granting only the VM means only the VM — there is no fallback to this
 * machine, by design.
 *
 * Naming is deliberately conservative. With exactly one computer the server is
 * still called "computer", so single-computer bots see the identical tool
 * surface, prompt, and allow-list they always have. Distinct names appear only
 * once a second computer is actually mounted.
 */

/** One computer granted to a bot for one turn. Exactly one of `box` / `stdio`
 * is set: the cloud box speaks through BotFleet's REST-to-MCP adapter, while
 * host, sandbox, and VPS computers expose Cua Driver's own MCP server. */
export interface ComputerMount {
  /** MCP server name, and therefore the agent's tool prefix. */
  name: string;
  /** Human label used in the system prompt ("Shared VM", "This Mac"). */
  label: string;
  kind: ComputerKind;
  box?: {
    kind?: "box";
    boxId: string;
    token: string;
    control?: { url: string; token: string };
  };
  stdio?: {
    command: string;
    args: string[];
    env: Record<string, string>;
    platform?: "darwin" | "linux" | "win32";
    generation?: string;
    scope?: "local-computer";
  };
}

export type ComputerKind = "box" | "vps" | "vm" | "local";

/** The MCP server name each kind takes once names have to be distinct. */
const MULTI_NAMES = {
  box: "computer_box",
  vps: "computer_shared_vm",
  vm: "computer_local_vm",
  local: "computer_host",
} satisfies Record<ComputerKind, string>;

/** Label for a kind. Only the host label is platform-dependent, because the
 * agent reasons about it explicitly ("does this need macOS?"). */
export function computerLabel(kind: ComputerKind, hostPlatform: NodeJS.Platform): string {
  switch (kind) {
    case "box":
      return "ASCII.dev Box";
    case "vps":
      return "Shared VM";
    case "vm":
      return "Local VM";
    case "local":
      return hostPlatform === "darwin" ? "This Mac" : "This Computer";
  }
}

/** Assign MCP server names across the granted set. One computer keeps the
 * historical name; two or more each get a distinct, self-describing one. */
export function nameMounts(mounts: ComputerMount[]): ComputerMount[] {
  if (mounts.length <= 1) return mounts.map((m) => ({ ...m, name: "computer" }));
  return mounts.map((m) => ({ ...m, name: MULTI_NAMES[m.kind] }));
}

/** True when this mount can click on the person's own desktop. Host control is
 * the one kind that routes every call through BotFleet's permission broker. */
export function isHostMount(mount: ComputerMount): boolean {
  return mount.kind === "local";
}

const SINGLE_PROMPTS = {
  vm: " You have a shared, isolated Cua sandbox: a Linux desktop in a container on this machine. Only /home/cua/workspace is durable; save downloads, repositories, working files, and browser profiles there because everything else inside the VM is disposable. No other host folder is mounted. Use the computer tools for desktop, accessibility, window, and shell work. Inspect the desktop state before acting, prefer accessibility targets over raw coordinates, and work carefully.",
  box: " You have your own cloud computer. In Chrome, prefer browser_snapshot with browser_click/browser_fill for semantic, trusted actions; use screenshot/click/type_text for visual or non-browser UI, open_url for navigation, and computer_exec for Linux tasks. Every action already returns the resulting screen, so don't follow it with screenshot; batch predictable pixel actions with computer_batch.",
  vps: " You have your own self-hosted remote Linux computer through the official Cua tools. Its filesystem is disposable: everything on it is wiped whenever its container is recreated, so keep long-lived work somewhere durable — push it to a remote, or hand the results back in chat — instead of leaving it only on that computer. Inspect the desktop state before acting, prefer accessibility targets over raw coordinates, and act carefully.",
  local: " You can act on the user's computer through the computer tools — take a screenshot or read the desktop state first, prefer accessibility actions over raw coordinates, and act carefully.",
} satisfies Record<ComputerKind, string>;

/** One line per computer when several are mounted, naming the tool prefix so
 * the agent can tell them apart at the point of use. */
function multiLine(mount: ComputerMount): string {
  const tools = `\`${mount.name}\` tools (prefixed \`mcp__${mount.name}__\`)`;
  switch (mount.kind) {
    case "vm":
      return `${mount.label} — an isolated Linux desktop in a container on this machine, through the ${tools}. Only /home/cua/workspace survives a rebuild.`;
    case "box":
      return `${mount.label} — your own cloud Linux desktop, through the ${tools}. In Chrome prefer browser_snapshot with browser_click/browser_fill; use computer_exec for shell work.`;
    case "vps":
      return `${mount.label} — a self-hosted remote Linux desktop shared with the other bots, through the ${tools}. Its filesystem is disposable, so push long-lived work to a remote instead of leaving it there.`;
    case "local":
      return `${mount.label} — the user's own machine, through the ${tools}. Every action here is brokered for the user's approval, so it is slower and more intrusive than a remote desktop.`;
  }
}

/** The selection rule, in the owner's terms: the remote desktop is the default
 * for everything, and this machine is reserved for work that genuinely needs
 * it. Both halves of the speed exception must hold — a 2x win on a short task
 * is not a reason to take over someone's desktop. */
function selectionPolicy(remote: ComputerMount, host: ComputerMount): string {
  return (
    ` Default to ${remote.label} for everything. Use ${host.label} only when the task genuinely requires it —` +
    ` Xcode, an iOS simulator, a macOS-only application, or the user's own files, credentials, and signed-in` +
    ` desktop apps — or when running on this hardware would be more than twice as fast AND would save at least` +
    ` five minutes of real time. Both conditions must hold: a 2x speedup that saves less than five minutes is` +
    ` not a reason to use ${host.label}. When you do choose ${host.label}, say so and say why.`
  );
}

/** System-prompt fragment describing the bot's computers.
 *
 * With one computer this returns exactly the text BotFleet has always sent, so
 * a single-computer bot's prompt does not move. With several it names each one
 * and states the selection rule. */
export function computerSystemPrompt(
  mounts: ComputerMount[],
  opts: { boxAgent?: boolean; hostPlatform?: NodeJS.Platform } = {},
): string {
  if (mounts.length === 0) return "";

  const protectedInput =
    " At a sign-in, password, MFA, CAPTCHA, or other protected-input step, stop and ask the user to complete it" +
    " on the visible computer. Never type their password or ask them to paste a password or one-time code into chat.";

  if (mounts.length === 1) {
    const [only] = mounts;
    // The box-native agent already runs on its box; describing the box to it
    // as a separate computer only confuses the agent about where it is.
    const body = only.kind === "box" && opts.boxAgent ? "" : SINGLE_PROMPTS[only.kind];
    return body + protectedInput;
  }

  const host = mounts.find(isHostMount);
  const remote = mounts.find((m) => !isHostMount(m));
  const lines = mounts.map((m) => `- ${multiLine(m)}`).join("\n");
  const policy = host && remote ? selectionPolicy(remote, host) : "";
  return (
    ` You have ${mounts.length} computers, each with its own separate set of tools:\n${lines}\n` +
    `They are separate machines: a file, a browser session, or an application on one is not on the other.` +
    policy +
    protectedInput
  );
}

/** The computers a turn actually carries.
 *
 * New callers set `integrations.computers`. Anything that still builds a turn
 * with only the legacy single-computer fields — older call sites and a good
 * many tests — is normalized to the same shape here, under the historical
 * server name, so drivers have exactly one code path to implement. */
export function turnComputerMounts(integrations: {
  computers?: ComputerMount[];
  computer?: ComputerMount["box"];
  localComputer?: ComputerMount["stdio"];
} | undefined): ComputerMount[] {
  if (integrations?.computers?.length) return integrations.computers;
  if (integrations?.computer) {
    return [{ name: "computer", label: "ASCII.dev Box", kind: "box", box: integrations.computer }];
  }
  if (integrations?.localComputer) {
    const stdio = integrations.localComputer;
    // The legacy field cannot say whether a stdio computer is a sandbox, a
    // VPS, or the host — only host control carries a scope. Drivers never
    // read `kind`, so the guess only affects prompt wording for old callers.
    const kind: ComputerKind = stdio.scope === "local-computer" ? "local" : "vm";
    return [{ name: "computer", label: computerLabel(kind, process.platform), kind, stdio }];
  }
  return [];
}

/** MCP tool prefix of the granted host computer, if the bot has one.
 *
 * Approval scoping must key off the host's OWN tools, not any tool whose name
 * happens to start with "computer": clicking inside a disposable Linux
 * container is not the same act as clicking on the person's desktop, and only
 * the latter belongs behind a permission card. */
export function hostToolPrefix(mounts: ComputerMount[]): string | null {
  const host = mounts.find(isHostMount);
  return host ? `mcp__${host.name}` : null;
}
