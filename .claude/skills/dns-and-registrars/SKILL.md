---
name: dns-and-registrars
description: Fleet DNS and registrar playbook.  Cloudflare is DNS for every fleet domain; registrar and Cloudflare account are separate.  Usage.Jays.Services is a Cloudflare account name, not the hostname usage.jays.services.  Create a new zone for each app apex on that account.  Use when adding a domain, linking a host, choosing a Cloudflare account, or touching nameservers.  Do not buy domains, mint accounts, or enable paid Cloudflare products without Jay.
---

# Fleet DNS and Registrars (ALL AGENTS)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Cloudflare is the DNS manager for every fleet domain.  Registrar and Cloudflare account are separate.

**Canonical:** `docs/DNS-AND-REGISTRARS.md` in `ai-fleet-coordinator`.

Do not change DNS, buy domains, mint Cloudflare accounts, install products, or spend without Jay.

## Account vs zone vs hostname

**Usage.Jays.Services is a Cloudflare account name** (login `mail@jays.services`).  It is not a zone and not a hostname.  `usage.jays.services` is an already-live hostname.  `jays.services` is an existing DNS-only zone on that same account.

A new app such as ContactLogo gets its **own** new Cloudflare zone for that apex (`contactlogo.com`), created on account Usage.Jays.Services.  Do not put ContactLogo — or any new app — records on `usage.jays.services` or `jays.services`.

| Term | Example |
|------|---------|
| **Account** | Usage.Jays.Services |
| **New zone** | `contactlogo.com` on that account |
| **Do not use as the new-app zone** | `usage.jays.services`, `jays.services` |

## Default for a new DNS-only zone

App hosted on Vercel, Coolify, or elsewhere, with no Workers / R2 / WAF / other Cloudflare products: create a **new zone for that app's apex** on the **Usage.Jays.Services** account.  That account already holds Usage-Monitor plus DNS-only zones `jaywedgeworth.com` and `jays.services`.

Example (ContactLogo): add zone `contactlogo.com` on account Usage.Jays.Services, then move Namecheap nameservers (`dns1.registrar-servers.com` / `dns2.registrar-servers.com`) to the nameservers Cloudflare shows for that new zone.

If an app later needs extra Cloudflare services, create a dedicated Cloudflare account for that app and migrate its zone(s) there.  Do not pile product services onto the Usage.Jays.Services account.

## Cloudflare accounts

| Account | Login | Holds | Do not |
|---------|-------|-------|--------|
| Usage.Jays.Services | `mail@jays.services` | Usage-Monitor + DNS-only zones + **new app zones** (each app's own apex) | Put ST/CT product services here.  Do not attach new-app records to `usage.jays.services` or `jays.services`. |
| SocraticTrade.com | `socratic.trade@jays.services` | ST registrar for SocraticTrade.com and Socratic.Trade, ST DNS, ST R2 weekly backups | Move unrelated new zones here |
| Congress.Trade | `congress.trade@jays.services` | CT DNS, CT R2 weekly backups | Move unrelated new zones here |
| old | unused Gmail login (do not print it) | unused | Create or move anything here.  Leave it. |

## Registrars

| Registrar | Use for |
|-----------|---------|
| Namecheap | Default for most domains.  `NAMECHEAP_API_KEY` lives in global API keys (do not print or commit it). |
| UnstoppableDomains | `jays.services` only |
| Cloudflare registrar | SocraticTrade.com and Socratic.Trade only (the ST Cloudflare account) |

After registration, point nameservers at Cloudflare and manage records in the **app's own zone** on the correct Cloudflare account.  Do not leave a live product on Namecheap parking / URL Forward.

## Linking a domain

1. Confirm host + required records on the **app's own zone**.
2. Confirm that zone is on the right Cloudflare **account** (Usage.Jays.Services unless the app already has a dedicated account).
3. Change DNS at Cloudflare unless nameservers are still at the registrar (then move NS first).
4. On an NS move, copy existing MX onto the new Cloudflare zone (Namecheap mail is often `eforward*.registrar-servers.com`).  Missing MX kills mail.  Do not copy URL Forward or parking CNAMEs (`parkingpage.namecheap.com`).
5. Cloudflare orange-cloud (proxied) hides the origin from HTTP-01.  Issue the first cert grey-cloud (DNS only) or use a Cloudflare origin cert, then proxy.  Preferred end state: proxied A/CNAME like `host.jays.services`.

Do not mint Cloudflare accounts, buy domains, or enable paid Cloudflare products without Jay.  Env/secrets stay with Meteorologist.
