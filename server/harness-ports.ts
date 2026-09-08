/** Hint names for loopback ports that often belong to other Mac services.
 * 8791 xcode-health, 8792 mac-collab, 8793 seat-mcp.  Do not refuse these
 * numbers before a bind: Windows, Linux, and a Mac without those services
 * may use them via OMB_PORT / OMB_WEBHOOK_PORT.  Sentry BOTFLEET-2 was an
 * uncaught EADDRINUSE on 8793; name the collision after listen fails. */

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
    return `botfleet ${who}: 127.0.0.1:${port} is already in use (often ${owner} on the fleet Mac)`;
  }
  return `botfleet ${who}: 127.0.0.1:${port} is already in use`;
}

export function isListenInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}
