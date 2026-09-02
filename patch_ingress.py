import sys

with open('server/webhook-ingress.ts', 'r') as f:
    code = f.read()

replacement = """function eventName(req: IncomingMessage): string | undefined {
  return (
    header(req, "x-botfleet-event") ??
    header(req, "x-github-event") ??
    header(req, "x-webhook-event") ??
    header(req, "x-event-type") ??
    header(req, "ce-type")
  )?.trim() || undefined;
}"""

old_str = """function eventName(req: IncomingMessage): string | undefined {
  return (
    header(req, "x-github-event") ??
    header(req, "x-webhook-event") ??
    header(req, "x-event-type") ??
    header(req, "ce-type")
  )?.trim() || undefined;
}"""

if old_str in code:
    with open('server/webhook-ingress.ts', 'w') as f:
        f.write(code.replace(old_str, replacement))
    print("Patched webhook ingress!")
else:
    print("Could not find eventName function")
