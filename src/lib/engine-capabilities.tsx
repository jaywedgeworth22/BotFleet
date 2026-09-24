// Engine capability + pricing registry.  The settings panel, the Usage tab,
// the new "API vs subscription" projection, and the capability matrix all
// read from a single source — adding a new engine is one row here, not four.
//
// Sources for every entry:
//   - `server/contracts.ts` for the canonical DriverKind ids
//   - `server/quota-window-map.ts` for which engines have a real quota window
//   - `server/drivers/{grok,claude,codex,minimax,antigravity}.ts` and the
//     acp/{cursor,deepseek,grok}.ts shims for the model + driver-kind surface
//   - `src/components/ProviderIcons.tsx` for the badge accent colors
//   - the fleet-recall "Coding-seat tiers (2026-09-16)" + "Coding-seat tiers
//     correction (2026-09-18)" notes for subscription pricing
//
// Fields marked "MARKED: needs Jay's confirmation" are the ones where I
// could not find a hard source inside the repo.  Do not silently rewrite
// them — Jay's correction on 2026-09-18 swapped a Plus for a Pro Lite, so
// a wrong subscription tier here would surface wrong numbers in three
// different panels.

import * as React from "react";

export type CapabilityKey =
  | "files"
  | "terminal"
  | "thisComputer"
  | "webAccess"
  | "imageAttachments"
  | "connectedApps"
  | "crossBotCoordination"
  | "roomCoordination"
  | "voiceChat"
  | "computerUse"
  | "longContext"
  | "liveResearch";

export type CapabilityState = "yes" | "no" | "limited" | "yes-pro-only";

export interface ApiRates {
  /** USD per 1k input tokens. */
  inputPer1k: number;
  /** USD per 1k output tokens. */
  outputPer1k: number;
  /** USD per 1k cached-input tokens when the provider bills them separately. */
  cachedInputPer1k?: number;
  /** Long-context tier: a request whose prompt reaches `minPromptTokens` is
   *  billed at these rates for all of its tokens (xAI's "≥ 200k prompt
   *  tokens" rows). */
  longContext?: {
    minPromptTokens: number;
    inputPer1k: number;
    outputPer1k: number;
    cachedInputPer1k?: number;
  };
  notes?: string;
}

export interface SubscriptionTier {
  tierLabel: string;
  costPerMonth: number | null;
  /** Human-readable quota line, e.g. "20x usage", "100 messages / 5h". */
  includedQuota?: string;
  notes?: string;
}

export type PricingMode =
  | { kind: "subscription"; subscription: SubscriptionTier; notes?: string }
  | { kind: "api"; api: ApiRates; notes?: string }
  | {
      kind: "subscription+api";
      subscription: SubscriptionTier;
      api: ApiRates;
      notes?: string;
    }
  | { kind: "free"; notes?: string }
  | { kind: "unknown"; notes?: string };

export interface EngineModel {
  id: string;
  display: string;
  ctxTokens?: number;
}

export interface WhyThisEngine {
  headline: string;
  /** Multi-paragraph prose; rendered in <p> blocks. */
  prose: string[];
}

export interface EngineCapabilityEntry {
  id: string;
  displayName: string;
  /** Tailwind utility classes for the badge chip — matched to ProviderIcons. */
  capabilityBadgeColor: string;
  /** Group label shown by `<EngineCapabilitiesMatrix>`. */
  group: "Cloud" | "Local Computer";
  pricing: PricingMode;
  capabilities: Partial<Record<CapabilityKey, CapabilityState>>;
  whyThisEngine: WhyThisEngine;
  /** Default model ids surfaced by the Usage section when no per-session
   *  override exists.  Always at least one entry — registry invariants
   *  enforce this in `engine-capabilities.test.ts`. */
  defaultModels: EngineModel[];
}

// MARKED: needs Jay's confirmation — Cursor Ultra monthly price. The
// fleet-recall note "Coding-seat tiers (2026-09-16)" bundles Cursor Ultra
// into the SuperGrok Heavy subscription.  Cursor.com sells Cursor Ultra
// independently too; if Jay pays for it separately, the costPerMonth here
// duplicates the spend.  Until confirmed, costPerMonth is `null` and the
// "What-if API" projection does not surface a Cursor subscription line.
const CURSOR_ULTRA_NOTE =
  "Cursor Ultra quota is bundled into this seat's xAI SuperGrok Heavy subscription per fleet-recall 2026-09-16 — the standalone price below is the public catalog number, not what is actually billed.";

const CLAUDE_MAX_NOTE =
  "Claude Max 20x per fleet-recall 2026-09-16 ($213.20/mo).  Subscription is the only billing mode available — no Anthropic API key is configured for this engine.";

const CODEX_PRO_LITE_NOTE =
  "ChatGPT Pro Lite per fleet-recall correction 2026-09-18 ($100/mo).  Pro was canceled 2026-06; Pro Lite replaced it and the Codex JWT now resolves to 'prolite'.";

const MINIMAX_TOKEN_PLAN_NOTE =
  "MiniMax Token Plan Max ($55/mo per fleet-recall 2026-09-16).  The PAYG API rates below are what the registry uses for the 'what-if API' projection; the daily UI never charges against them unless the user explicitly opts into API mode.";

const GROK_SUPER_NOTE =
  "xAI SuperGrok Heavy per fleet-recall 2026-09-16 ($99/mo after the 67% promo on the $300 list price — switches mid-October to the plain $100 SuperGrok plan).  Cursor Ultra and Grok Bot bundles are folded in for this seat.";

const ANTIGRAVITY_ULTRA_NOTE =
  "Google AI Ultra per fleet-recall 2026-09-16 — $105.79/mo, renewing 2026-10-05 at $50/mo.  Antigravity access is the agent-approval lane behind PR #516.";

const DEEPSEEK_HARNESS_NOTE =
  "DeepSeek Harness (DSH) is bundled with Claude Max per fleet-recall 2026-09-16 — there is no separate subscription tier for this seat, the standalone catalog number is what the registry would charge for a PAYG API key.";

export const ENGINE_CAPABILITIES: Record<string, EngineCapabilityEntry> = {
  grok: {
    id: "grok",
    displayName: "Grok",
    capabilityBadgeColor: "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        tierLabel: "xAI SuperGrok Heavy",
        costPerMonth: 99,
        includedQuota: "Bundled Cursor Ultra + Grok Bot on this seat",
        notes: GROK_SUPER_NOTE,
      },
      api: {
        inputPer1k: 0.002,
        cachedInputPer1k: 0.0005,
        outputPer1k: 0.006,
        // Grok 4.7 API rates: $2 input / $0.50 cached / $6 output per million tokens
        // under 200k prompt tokens; $4 / $1 / $12 at or above 200k (xAI's
        // long-context tier, billed on every token of that request).  xAI's
        // pricing page lists the grok-4.6 card; 4.7 uses the same rates.
        // Keep these API projections separate from Grok Build subscription billing.
        longContext: {
          minPromptTokens: 200_000,
          inputPer1k: 0.004,
          cachedInputPer1k: 0.001,
          outputPer1k: 0.012,
        },
        notes:
          "Grok 4.7 xAI API rates from https://docs.x.ai/developers/models/grok-4.7; " +
          "prompts at or above 200k tokens use the long-context rates per https://docs.x.ai/developers/pricing.",
      },
      notes: "Subscription is the primary path; API rates exist only for the 'what-if API' projection.",
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      longContext: "yes",
      liveResearch: "yes",
      crossBotCoordination: "limited",
    },
    whyThisEngine: {
      headline: "Grok 4.7 + live research in one subscription.",
      prose: [
        "Grok 4.7 brings long-context work and live research to the SuperGrok Heavy subscription.",
        "Live web research is a first-class tool — when a bot needs the latest docs, the news, or a fresh pricing page, Grok is the engine that fetches and answers without a separate tool chain.",
        "On this seat, Grok quota is bundled with Cursor Ultra and Grok Bot under SuperGrok Heavy, so the same subscription covers three of the seven engines.",
      ],
    },
    defaultModels: [
      { id: "grok-4.7", display: "Grok 4.7", ctxTokens: 500_000 },
      { id: "grok-4.6", display: "Grok 4.6" },
      // The Grok Build (ACP) catalog id — see server/drivers/acp/grok.ts.
      { id: "grok-4.7-build-fast", display: "Grok 4.7 Build Fast" },
      { id: "grok-3-mini", display: "Grok 3 mini", ctxTokens: 131_072 },
      // Retired id kept so legacy tasks banked as model "grok-4" (no engine
      // metadata) still attribute to Grok via uniqueModelToEngineId.
      { id: "grok-4", display: "Grok 4", ctxTokens: 1_000_000 },
    ],
  },

  cursor: {
    id: "cursor",
    displayName: "Cursor",
    capabilityBadgeColor: "bg-amber-500 text-black",
    group: "Cloud",
    pricing: {
      kind: "subscription",
      subscription: {
        tierLabel: "Cursor Ultra (bundled)",
        costPerMonth: null,
        includedQuota: "Bundled into this seat's SuperGrok Heavy",
        notes: CURSOR_ULTRA_NOTE,
      },
      // No outer `notes`: UsageSection shows `pricing.notes` ahead of the
      // subscription note, and the open costPerMonth question is tracked in
      // the MARKED comment above CURSOR_ULTRA_NOTE, not in UI copy.
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      longContext: "yes",
      crossBotCoordination: "yes",
    },
    whyThisEngine: {
      headline: "Cursor Ultra quota without paying for Cursor twice.",
      prose: [
        "Cursor's CLI is the same tool the Cursor desktop app exposes — BotFleet just drives it over ACP.",
        "On this seat the Cursor Ultra quota is bundled into the xAI SuperGrok Heavy subscription, so the same plan covers Grok and Cursor.",
        "Cross-bot coordination is reliable here: Cursor Agent participates in groups and rooms, unlike older MCP-only shells.",
      ],
    },
    defaultModels: [
      { id: "cursor-default", display: "Cursor Default", ctxTokens: 200_000 },
      { id: "claude-sonnet-4.5", display: "Claude Sonnet 4.5 (via Cursor)", ctxTokens: 200_000 },
    ],
  },

  claude: {
    id: "claude",
    displayName: "Claude",
    capabilityBadgeColor: "bg-orange-500 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription",
      subscription: {
        tierLabel: "Claude Max 20x",
        costPerMonth: 213.2,
        includedQuota: "20x plan usage on Anthropic's Max tier",
        notes: CLAUDE_MAX_NOTE,
      },
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      // Driver declares composioMcp (server/drivers/claude.ts) — the
      // matrix used to render "-" here because the registry omitted it.
      connectedApps: "yes",
      longContext: "yes",
      crossBotCoordination: "yes",
      roomCoordination: "yes",
      voiceChat: "yes",
      computerUse: "yes",
    },
    whyThisEngine: {
      headline: "Budget tier with voice, computer use, and full room coordination.",
      prose: [
        "Claude Max 20x is the only BotFleet engine today that exposes every capability — files, terminal, this-computer, web, images, long context, cross-bot calls, rooms, voice, and computer use.",
        "The computer-use settings lane surfaces through Claude first because the Anthropic driver is the most complete.  Voice cloning stays out of this pitch: it is a planned MiniMax lane (EFFORT-LOG), not something Claude ships today.",
        "If you need one engine that handles every class of task, Claude is the safest default on this seat.",
      ],
    },
    defaultModels: [
      { id: "claude-opus-4", display: "Claude Opus 4", ctxTokens: 200_000 },
      { id: "claude-sonnet-4.5", display: "Claude Sonnet 4.5", ctxTokens: 200_000 },
      { id: "claude-haiku-4", display: "Claude Haiku 4", ctxTokens: 200_000 },
    ],
  },

  codex: {
    id: "codex",
    displayName: "Codex",
    capabilityBadgeColor: "bg-emerald-600 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription",
      subscription: {
        tierLabel: "ChatGPT Pro Lite",
        costPerMonth: 100,
        includedQuota: "Codex CLI quota on OpenAI's Pro Lite tier",
        notes: CODEX_PRO_LITE_NOTE,
      },
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      // Driver declares composioMcp (server/drivers/codex.ts) — the
      // matrix used to render "-" here because the registry omitted it.
      connectedApps: "yes",
      longContext: "yes",
      computerUse: "yes",
    },
    whyThisEngine: {
      headline: "Code-tuned model that pairs with the Xcode / iOS lane.",
      prose: [
        "Codex is the OpenAI coding model and the only BotFleet engine with first-class support for the iOS TestFlight lane — `xcodegen generate`, simulator screenshots, and unsigned `xcodebuild` all run through it.",
        "Pro Lite is the active tier per the 2026-09-18 JWT correction; the older ChatGPT Plus records are stale.",
        "Computer-use is reliable here even on the lower-tier quota.",
      ],
    },
    defaultModels: [
      { id: "gpt-5-codex", display: "GPT-5 Codex", ctxTokens: 400_000 },
      { id: "gpt-5", display: "GPT-5", ctxTokens: 400_000 },
    ],
  },

  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    capabilityBadgeColor: "bg-blue-600 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        tierLabel: "Google AI Ultra",
        costPerMonth: 105.79,
        includedQuota: "Includes Antigravity approval (PR #516) — renews 2026-10-05 at $50/mo",
        notes: ANTIGRAVITY_ULTRA_NOTE,
      },
      api: {
        // MARKED: needs Jay's confirmation — Gemini 2.5 Pro API rates from
        // the public Google AI Studio pricing page; cached-input rate is the
        // public "context caching" tier.
        inputPer1k: 0.00125,
        outputPer1k: 0.01,
        cachedInputPer1k: 0.00031,
        notes: "Gemini 2.5 Pro PAYG rates — reference only; subscription is the primary billing mode.",
      },
      notes: "Subscription is the primary billing path; the API block exists for the 'what-if API' projection only.",
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      // Driver declares composioMcp (server/drivers/antigravity.ts) —
      // the matrix used to render "-" here because the registry omitted it.
      connectedApps: "yes",
      liveResearch: "yes",
    },
    whyThisEngine: {
      headline: "Google's multimodal + Antigravity's bot approval lane.",
      prose: [
        "Antigravity is the Google AI bot lane behind PR #516 — it has its own four-window quota model (Gemini Models + Third-Party Models across 5h and weekly periods) and its own session-start signals.",
        "Google's image and document tools are the strongest in the fleet; when a bot needs to read a PDF, render a chart, or watch a video, Antigravity is the first engine to try.",
        "The subscription drops from $105.79 to $50 on 2026-10-05 — the renewal is the closest upcoming cost change in the fleet.",
      ],
    },
    defaultModels: [
      { id: "gemini-2.5-pro", display: "Gemini 2.5 Pro", ctxTokens: 1_000_000 },
      { id: "gemini-2.5-flash", display: "Gemini 2.5 Flash", ctxTokens: 1_000_000 },
    ],
  },

  "deepseek-harness": {
    id: "deepseek-harness",
    displayName: "DeepSeek Harness",
    capabilityBadgeColor: "bg-rose-600 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        tierLabel: "Bundled with Claude Max",
        costPerMonth: null,
        includedQuota: "DSH CLI runs on the same Claude Max seat",
        notes: DEEPSEEK_HARNESS_NOTE,
      },
      api: {
        inputPer1k: 0.00027,
        outputPer1k: 0.0011,
        cachedInputPer1k: 0.00007,
        notes: "DeepSeek PAYG API rates — reference for the 'what-if API' projection.",
      },
      notes: "Subscription is bundled; API rates exist only for the projection.",
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      // DSH driver's adapter contract (`server/drivers/acp/dsh.test.ts`)
      // pins `instance.adapter.capabilities.images` to `false`, so the
      // composer rejects image input.  Render "no" rather than "yes" so
      // the matrix doesn't overclaim — Codex caught this in the review.
      imageAttachments: "no",
      // The DSH ACP adapter declares composioMcp
      // (server/drivers/acp/dsh.test.ts) — the matrix used to render
      // "-" here because the registry omitted it.
      connectedApps: "yes",
      crossBotCoordination: "yes",
    },
    whyThisEngine: {
      headline: "Small / fast models on the bundled Claude Max seat.",
      prose: [
        "DSH runs DeepSeek's small and fast models through the harness ACP bridge, with cheap tokens and the same cross-bot coordination as Claude.",
        "It is the right tool for short, mechanical turns — a code search, a reformat, a one-line edit — where Opus would burn quota for no quality gain.",
        "DSH pairs well with Claude for connected-app turns: DSH does the file work, Claude drives the apps.  The MiniMax driver wires no Composio channel.",
      ],
    },
    defaultModels: [
      { id: "deepseek-chat", display: "DeepSeek Chat", ctxTokens: 64_000 },
      { id: "deepseek-reasoner", display: "DeepSeek Reasoner", ctxTokens: 64_000 },
    ],
  },

  minimax: {
    id: "minimax",
    displayName: "MiniMax",
    capabilityBadgeColor: "bg-violet-600 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        tierLabel: "Mavis Token Plan Max",
        costPerMonth: 55,
        includedQuota: "4–5 agent seats on Mavis's Token Plan Max tier",
        notes: MINIMAX_TOKEN_PLAN_NOTE,
      },
      api: {
        inputPer1k: 0.001,
        outputPer1k: 0.004,
        cachedInputPer1k: 0.0002,
        notes:
          "MiniMax M3 PAYG API rates from the public platform pricing page. " +
          "Prompts over 512K input tokens use 2x these rates per the model's own pricing footnote.",
      },
      notes:
        "Subscription is the primary path for BotFleet. " +
        "API rates are surfaced ONLY inside the 'what-if API' projection — never in the daily cost breakdown.",
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      crossBotCoordination: "yes",
      roomCoordination: "yes",
      voiceChat: "yes",
      // Connected Apps is the Composio bridge, and the MiniMax driver's
      // declared capabilities (server/drivers/minimax.ts) carry no
      // composioMcp — unlike Claude, Codex, Antigravity, pi, and the DSH
      // ACP adapter, which all declare it.  Driving THIS Mac is the
      // "thisComputer" row above (localComputerMcp + the tool loop), a
      // different thing from Connected Apps.  Render "no" so the matrix
      // stops claiming a channel the driver does not wire.
      connectedApps: "no",
      longContext: "yes",
    },
    whyThisEngine: {
      headline: "Cross-bot coordination + room chats + voice, all on the Token Plan.",
      prose: [
        "MiniMax is the strongest choice for cross-bot coordination and room chats — `server/group-routing.ts` was designed around the MiniMax driver's call semantics, so room turn reliability is highest here.",
        "Voice chat is supported through the Mavis voice channel; voice minutes are part of the Token Plan Max bundle rather than billed as PAYG minutes.",
        "Connected apps are not wired on MiniMax: the direct driver does not advertise `composioMcp`, `computerMcp`, or `phoneMcp` (see `server/drivers/minimax.ts`), so the matrix shows `no` — bots needing a real MCP channel pick Claude or Cursor.",
        "On the Mavis Token Plan Max subscription the engine is metered as included; the PAYG API block in the registry is reference data for the what-if projection only.",
      ],
    },
    defaultModels: [
      { id: "MiniMax-M3", display: "MiniMax M3", ctxTokens: 1_000_000 },
      { id: "MiniMax-H3", display: "MiniMax H3", ctxTokens: 256_000 },
    ],
  },
};

/** Every capability key the matrix exposes, in display order. */
export const CAPABILITY_KEYS: CapabilityKey[] = [
  "files",
  "terminal",
  "thisComputer",
  "webAccess",
  "imageAttachments",
  "connectedApps",
  "crossBotCoordination",
  "roomCoordination",
  "voiceChat",
  "computerUse",
  "longContext",
  "liveResearch",
];

/** Display labels for the matrix header cells. */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  files: "Files",
  terminal: "Terminal",
  thisComputer: "This Computer",
  webAccess: "Web Access",
  imageAttachments: "Image Attachments",
  connectedApps: "Connected Apps",
  crossBotCoordination: "Cross-Bot Coordination",
  roomCoordination: "Rooms",
  voiceChat: "Voice Chat",
  computerUse: "Computer Use",
  longContext: "Long Context",
  liveResearch: "Live Research",
};

/** Engine ids in display order (Cloud group first, then Local Computer). */
export const ENGINE_DISPLAY_ORDER: string[] = [
  "grok",
  "cursor",
  "claude",
  "codex",
  "antigravity",
  "deepseek-harness",
  "minimax",
];

/** Resolve the engine id from a driver-kind string when the registry and
 *  the runtime disagree.  Examples:
 *    "grokAgent"  → "grok"
 *    "claudeAgent" → "claude"
 *    "dshAgent"    → "deepseek-harness"
 *    "antigravityAgent" → "antigravity"
 *    "deepseekAgent" → "deepseek-harness"  (legacy alias — the old
 *    `deepseekAgent` driver predates the Harness bridge and ships on
 *    users who haven't updated)
 *  Unknown driver kinds return `null` so the caller can decide whether to
 *  fall back to a generic entry instead of crashing on `undefined`. */
export function engineIdFromDriverKind(driverKind: string | undefined | null): string | null {
  if (!driverKind) return null;
  const normalized = driverKind.replace(/Agent$/i, "").toLowerCase();
  // Aliases the driver layer uses today:
  if (normalized === "dsh") return "deepseek-harness";
  if (normalized === "deepseek") return "deepseek-harness";
  if (normalized === "minimax") return "minimax";
  // antigravity / cursor / claude / codex / grok / deepseek all collapse
  // to their registry id after the Agent suffix strip.
  if (ENGINE_CAPABILITIES[normalized]) return normalized;
  return null;
}

/** Lookup helper with a friendly fallback — used by `<EngineCallout>` when
 *  the engine id is not in the registry yet.  Falls through to MiniMax's
 *  capability set so the panel still renders something useful instead of
 *  crashing on a newer engine the registry does not yet know. */
export function engineCapability(id: string): EngineCapabilityEntry {
  return (
    ENGINE_CAPABILITIES[id] ??
    {
      id,
      displayName: id,
      capabilityBadgeColor: "bg-control text-ink-secondary",
      group: "Cloud" as const,
      pricing: { kind: "unknown" as const },
      capabilities: {},
      whyThisEngine: {
        headline: "Engine not in the capability registry yet.",
        prose: [
          "This engine id is not registered in `src/lib/engine-capabilities.tsx`.",
          "Add an entry there before shipping a new engine — the settings panel, the Usage tab, and the API-vs-subscription projection all read from the same registry.",
        ],
      },
      defaultModels: [],
    }
  );
}

/** Pretty label for a pricing mode — used by both `<EngineCallout>` and
 *  `<EngineCapabilitiesMatrix>` so the wording is consistent everywhere. */
export function pricingModeLabel(pricing: PricingMode): string {
  switch (pricing.kind) {
    case "subscription": {
      const cost =
        typeof pricing.subscription.costPerMonth === "number"
          ? `$${pricing.subscription.costPerMonth.toFixed(2)}/mo`
          : "bundled";
      return `Subscription · ${cost}`;
    }
    case "api":
      return `API · $${pricing.api.inputPer1k.toFixed(5)}/1k in`;
    case "subscription+api": {
      const cost =
        typeof pricing.subscription.costPerMonth === "number"
          ? `$${pricing.subscription.costPerMonth.toFixed(2)}/mo`
          : "bundled";
      return `Subscription + API · ${cost}`;
    }
    case "free":
      return "Free";
    case "unknown":
      return "Pricing unknown";
  }
}

/** Cell text for the matrix — keeps the wording identical to what the
 *  legacy `<MiniMaxCallout>` used (yes / no / limited / pro only) so the
 *  visual vocabulary of the panel stays familiar. */
export function capabilityCellLabel(state: CapabilityState | undefined): string {
  switch (state) {
    case "yes":
      return "✓";
    case "no":
      return "✗";
    case "limited":
      return "limited";
    case "yes-pro-only":
      return "pro only";
    default:
      return "—";
  }
}

/** `<EngineCallout>` prose component — extracted so the matrix can also use
 *  the same `<strong>` headline + paragraph copy the legacy MiniMax callout
 *  used, instead of inventing a second block of wording. */
export function EngineCalloutBody(props: {
  entry: EngineCapabilityEntry;
  className?: string;
}): React.ReactElement {
  const { entry, className } = props;
  return (
    <div
      className={className ?? "rounded-xl border border-hairline/30 bg-inset/30 p-3 text-[12.5px] leading-relaxed text-ink-secondary"}
    >
      <p className="mb-1.5 text-ink">
        <strong>Why This Engine?</strong> {entry.whyThisEngine.headline}
      </p>
      {entry.whyThisEngine.prose.map((line, index) => (
        <p key={index} className="mb-1 last:mb-0">
          {line}
        </p>
      ))}
      <p className="mt-1.5 text-[11px] text-ink-secondary/80">
        Pricing: {pricingModeLabel(entry.pricing)}.
      </p>
    </div>
  );
}

/** Model id -> engine id for ids listed under exactly ONE engine's
 *  defaultModels list.  A model id shared across engines (for example
 *  claude-sonnet-4.5, listed under Cursor AND Claude) is left unmapped:
 *  first-wins would credit the wrong engine with a legacy task's usage,
 *  so ambiguous ids fall through to the unattributed total instead. */
export function uniqueModelToEngineId(): Map<string, string> {
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [engineId, entry] of Object.entries(ENGINE_CAPABILITIES)) {
    for (const m of entry.defaultModels ?? []) {
      if (seen.has(m.id)) {
        if (seen.get(m.id) !== engineId) ambiguous.add(m.id);
      } else {
        seen.set(m.id, engineId);
      }
    }
  }
  for (const id of ambiguous) seen.delete(id);
  return seen;
}
