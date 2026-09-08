/** Loopback ports that belong to other Mac services, never BotFleet.
 * Binding them is always a collision: 8791 xcode-health, 8792 mac-collab,
 * 8793 seat-mcp.  Sentry BOTFLEET-2 was an uncaught listen on 8793. */

export const FOREIGN_LOOPBACK_PORTS = [8791, 8792, 8793] as const;

export function foreignLoopbackOwner(port: number): string | null {
  if (port === 8791) return "xcode-health";
  if (port === 8792) return "mac-collab";
  if (port === 8793) return "seat-mcp";
  return null;
}

export function formatListenInUse(port: number, role: "harness" | "webhook"): string {
  const owner = foreignLoopbackOwner(port);
  const who = role === "webhook" ? "webhook receiver" : "harness";
  if (owner) {
    return `botfleet ${who}: 127.0.0.1:${port} belongs to ${owner}, not BotFleet`;
  }
  return `botfleet ${who}: 127.0.0.1:${port} is already in use`;
}

export function assertHarnessListenPort(port: number, role: "harness" | "webhook"): void {
  const owner = foreignLoopbackOwner(port);
  if (!owner) return;
  throw Object.assign(new Error(formatListenInUse(port, role)), { status: 500, code: "EADDRINUSE" });
}
