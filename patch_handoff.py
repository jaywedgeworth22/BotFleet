import re

with open('/Users/jay/Code/ai-fleet-coordinator/skills/secret-handoff/SKILL.md', 'r') as f:
    content = f.read()

replacement = """## BotFleet Secret Request Card (2026-09-01)
If you are operating within a BotFleet environment and need an API key or custom token (e.g. `GITHUB_TOKEN`, `AWS_ACCESS_KEY_ID`), you MUST use the `request_credential` MCP tool. 
- The tool accepts `credential_id` or `custom_secret_name` and an optional `reason`.
- This triggers an interactive UI card (`SecretRequestCard`) where the user can securely type the key.
- The key is securely saved to `~/.botfleet/vault.json` and automatically injected into your tool environment variables.
- NEVER ask the user to paste a secret directly into the chat transcript.

## One canonical handoff file"""

content = content.replace("## One canonical handoff file", replacement)

with open('/Users/jay/Code/ai-fleet-coordinator/skills/secret-handoff/SKILL.md', 'w') as f:
    f.write(content)
