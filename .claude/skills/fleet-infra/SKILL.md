---
name: fleet-infra
description: Access private fleet infrastructure inventory (host IPs, Tailscale mesh IPs, Coolify container UUIDs, Infisical project IDs, and SSH keys) maintained in jaywedgeworth22/fleet-ops:ATTACK-MAP.md. Use when locating production servers, configuring environment variables, verifying edge routing, or handling infrastructure secrets without leaking them into public repos.
---

# Fleet Infrastructure & Private Inventory Access (ALL AGENTS)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


All fleet repositories except `fleet-ops` are **public**.  To protect origin infrastructure from direct attacks, scanning, and DDoS, production host IPs, Tailscale IPs, Coolify container/server UUIDs, hardware serials, and secret keys must **never** be committed to public repositories or printed to chat/logs.

## Canonical Inventory Location

- **Local Workstation Agents (Mac/Terminal):**
  Read directly from `/Users/jay/Code/fleet-ops/ATTACK-MAP.md`.
  GitHub repo: [`jaywedgeworth22/fleet-ops:ATTACK-MAP.md`](https://github.com/jaywedgeworth22/fleet-ops/blob/main/ATTACK-MAP.md) (private).

- **Cloud / Remote Agents (without direct repo access):**
  Fetch securely from the Mac agent relay using `MAC_COLLAB_TOKEN`:
  ```bash
  curl -fsS -H "Authorization: Bearer ${MAC_COLLAB_TOKEN}" https://mac.jays.services/files/ATTACK-MAP.md
  ```

## What Lives in `fleet-ops:ATTACK-MAP.md`

1. **Host Topology & IP Addresses:**
   - Production Hetzner Linux host public IP, Tailscale MagicDNS (`server.boa-roygbiv.ts.net`), and mesh IP (`100.69.77.26`).
   - Mac workstation local relay Tailscale IP (`100.113.106.39`).
   - iPhone operator client Tailscale IP (`100.100.72.76`).
   - Retired Oracle server references and transition logs.

2. **Coolify Container & Server UUIDs:**
   - Server UUIDs for Hetzner (`fleet-hetzner-nbg1`).
   - Application UUIDs for `Socratic.Trade`, `Congress.Trade`, and `Usage-Monitor`.

3. **Infisical Project IDs:**
   - Project workspace IDs for ST, CT, Shared, and UM scopes.

4. **Edge & Access Control Rules:**
   - Cloudflare origin isolation rules (blocking non-CF traffic on `:80`/`:443`).
   - SSH `:22` access restricted to Tailscale mesh (`macbook` and `iphone`).
   - Coolify control plane `:8000` bound to Tailscale IP.

## Invariants for Public Repositories

1. **Never Hardcode Infrastructure IDs in Public Repos:**
   Always read values from environment variables (`INFISICAL_PROJECT_ID`, `COOLIFY_ST_APP_UUID`, `HETZNER_HOST_IP`, etc.) or query them dynamically via authenticated APIs.

2. **Secrets Handoff Protection:**
   Read credentials from `~/.secrets/global-api-keys` or Infisical.  Never `cat`, `grep -E '^[A-Z0-9_]+='`, or log secret values into transcripts.

3. **Mock Data in Tests & Documentation:**
   Use RFC 5737 documentation ranges (`192.0.2.1`, `198.51.100.1`, `203.0.113.1`) and generic mock UUIDs (`mock-app-uuid`, `mock-project-id`) in test fixtures and public rollouts.
