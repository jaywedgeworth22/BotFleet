// Stock `@deepseek-ai/dsh-acp` rejects non-empty session/new mcpServers.
// BotFleet still builds the same stdio mounts every other ACP engine gets.
// For a stock `dsh` binary this module:
//   1. writes those mounts as a `dsh --patch` overlay of dsh-mcp-client rows
//   2. sits `dsh-acp-bridge` in front so the wire can keep sending mcpServers
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import type { SendTurnInput } from "../../contracts.ts";
import { acpMcpServers, type AcpSpawnRewrite, type AcpStdioMcpServer } from "./core.ts";

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const DSH_MCP_PATCH_PREFIX = "botfleet-dsh-mcp-";

export function isStockDshCli(cli: string): boolean {
  const stem = basename(cli).toLowerCase().replace(/\.(sh|bash|js|mjs|cjs|ts)$/u, "");
  return stem === "dsh";
}

export function dshMcpServerName(name: string, used: Set<string>): string {
  let cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  if (!SERVER_NAME_PATTERN.test(cleaned)) cleaned = "mcp";
  if (!used.has(cleaned)) {
    used.add(cleaned);
    return cleaned;
  }
  for (let index = 2; index < 100; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${cleaned.slice(0, 32 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `mcp_${used.size}`;
  used.add(fallback);
  return fallback;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlEnv(env: AcpStdioMcpServer["env"]): string {
  const entries = env.filter((item) => item.name.length > 0);
  if (entries.length === 0) return " {}";
  const lines = entries.map((item) => {
    const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) ? item.name : JSON.stringify(item.name);
    return `          ${key}: ${yamlString(item.value)}`;
  });
  return `\n${lines.join("\n")}`;
}

/** Cordis `--patch` overlay that loads one dsh-mcp-client instance per stdio mount. */
export function dshMcpPatchYaml(servers: AcpStdioMcpServer[]): string {
  const used = new Set<string>();
  const rows = servers.map((server, index) => {
    const serverName = dshMcpServerName(server.name, used);
    const argsYaml =
      server.args.length === 0
        ? " []"
        : `\n${server.args.map((arg) => `          - ${yamlString(arg)}`).join("\n")}`;
    return `    - id: ${DSH_MCP_PATCH_PREFIX}${index}-${serverName}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ${yamlString(serverName)}
        transport: stdio
        command: ${yamlString(server.command)}
        args:${argsYaml}
        env:${yamlEnv(server.env)}
        failOnStartupError: false`;
  });
  return `# BotFleet session/new mcpServers, delivered through dsh-mcp-client.\n- insert:\n${rows.join("\n")}\n`;
}

/** Write the overlay somewhere only this user can read it.
 *
 * The YAML carries every mount's environment verbatim, so for BotFleet's own
 * mounts it holds OMB_COMMS_TOKEN, OMB_CONTROL_TOKEN and any Composio key —
 * the same values treated as secrets everywhere else in the codebase.  Written
 * at the process umask into a shared temp directory it would sit there
 * world-readable for the whole DSH session, so it gets the pattern
 * `server/drivers/antigravity.ts` already uses for a private file: a 0700
 * directory of its own, and 0600 on the file.
 *
 * `mkdtemp(3)` both picks the name atomically — no window in which another
 * user can win the path — and creates the directory 0700 on POSIX.  The chmod
 * behind each write is the fallback for a platform or filesystem that ignores
 * the mode; both are best-effort because Windows has no POSIX mode bits to
 * set, and a per-user temp directory there is already private.
 *
 * The directory keeps the same prefix as the file so the bridge's cleanup can
 * tell one BotFleet minted from any other directory it is handed.
 */
export function writeDshMcpPatch(servers: AcpStdioMcpServer[]): string {
  const directory = mkdtempSync(join(tmpdir(), DSH_MCP_PATCH_PREFIX));
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* no POSIX mode bits on this platform */
  }
  const path = join(directory, `${DSH_MCP_PATCH_PREFIX}${randomUUID()}.yml`);
  try {
    writeFileSync(path, dshMcpPatchYaml(servers), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* no POSIX mode bits on this platform */
    }
  } catch (error) {
    // A failed write must not leave the directory behind holding a partial
    // overlay — the same guard `server/drivers/pi.ts` keeps over its own MCP
    // config, and nothing downstream gets a path to clean up when the caller
    // never receives one.
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return path;
}

export function dshWrapSpawn(
  cli: string,
  args: string[],
  turn: Pick<SendTurnInput, "integrations">,
): AcpSpawnRewrite {
  if (!isStockDshCli(cli)) return { cli, args };
  const servers = acpMcpServers(turn);
  if (servers.length === 0) return { cli, args };
  const patch = writeDshMcpPatch(servers);
  return {
    cli: process.execPath,
    args: [SPAWNED_PROXIES.dshAcpBridge, "--", cli, ...args, "--patch", patch],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}
