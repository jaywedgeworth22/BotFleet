// Skins are pure CSS. Every one of them is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS.

export const SKIN_IDS = [
  "system",
  "studio",
  "porcelain",
  "nordic",
  "sandstone",
  "solarized",
  "titanium",
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "custom",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "system", name: "System Auto", tagline: "Matches macOS Dark/Light appearance" },
  { id: "studio", name: "Studio Clean", tagline: "Pure white, crisp modern macOS daylight." },
  { id: "porcelain", name: "Porcelain Light", tagline: "Ultra-clean Apple White minimalism with soft neutral shadows." },
  { id: "nordic", name: "Nordic Glacier", tagline: "Sub-arctic ice-white, frost cards, fjord navy ink, azure cyan." },
  { id: "sandstone", name: "Warm Sandstone", tagline: "Sunlit cream stone, warm natural linen surfaces, amber warmth." },
  { id: "solarized", name: "Solarized Daylight", tagline: "Soft cream ivory, deep olive slate typography, refined teal." },
  { id: "titanium", name: "Titanium Frost", tagline: "Brushed titanium and cool slate silver." },
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
  { id: "custom", name: "Custom Palette", tagline: "Your tailored ground, surface, ink, and accent tones." },
];

export const ACCENT_PRESETS = [
  { name: "Royal Blue", hex: "#0969da" },
  { name: "Electric Blue", hex: "#1084fe" },
  { name: "Sky Cyan", hex: "#0284c7" },
  { name: "Nordic Teal", hex: "#0077cc" },
  { name: "Indigo", hex: "#4f46e5" },
  { name: "Violet", hex: "#7c3aed" },
  { name: "Emerald", hex: "#059669" },
  { name: "Warm Amber", hex: "#d97706" },
  { name: "Sandstone Rust", hex: "#c05621" },
  { name: "Crimson Rose", hex: "#e11d48" },
  { name: "Titanium Slate", hex: "#475569" },
] as const;

export type CustomThemeConfig = {
  appBg: string;
  panelBg: string;
  cardBg: string;
  inkColor: string;
  inkSecondaryColor: string;
  accentColor: string;
  hairlineColor: string;
};

export const DEFAULT_CUSTOM_THEME: CustomThemeConfig = {
  appBg: "#f8fafc",
  panelBg: "#ffffff",
  cardBg: "#ffffff",
  inkColor: "#0f172a",
  inkSecondaryColor: "#64748b",
  accentColor: "#0284c7",
  hairlineColor: "#e2e8f0",
};

export function getDefaultSkin(): SkinId {
  return "studio";
}

const KEY = "omb-skin";
const ACCENT_KEY = "omb-custom-accent";
const CUSTOM_THEME_KEY = "omb-custom-palette";

function isSkinId(value: unknown): value is SkinId {
  return SKIN_IDS.includes(value as SkinId);
}

function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readSkin(): SkinId {
  try {
    const stored = getStore()?.getItem(KEY);
    return isSkinId(stored) ? stored : getDefaultSkin();
  } catch {
    return getDefaultSkin();
  }
}

export function readCustomAccent(): string | null {
  try {
    return getStore()?.getItem(ACCENT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function readCustomTheme(): CustomThemeConfig {
  try {
    const raw = getStore()?.getItem(CUSTOM_THEME_KEY);
    if (!raw) return DEFAULT_CUSTOM_THEME;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CUSTOM_THEME, ...parsed };
  } catch {
    return DEFAULT_CUSTOM_THEME;
  }
}

export function saveCustomTheme(theme: CustomThemeConfig): void {
  try {
    getStore()?.setItem(CUSTOM_THEME_KEY, JSON.stringify(theme));
  } catch {
    // ignore
  }
  applyCustomTheme(theme);
}

export function applyCustomTheme(theme: CustomThemeConfig): void {
  const root = document.documentElement;
  root.style.setProperty("--color-app", theme.appBg);
  root.style.setProperty("--color-panel", theme.panelBg);
  root.style.setProperty("--color-card", theme.cardBg);
  root.style.setProperty("--color-raised", theme.cardBg);
  root.style.setProperty("--color-raised-hover", theme.appBg);
  root.style.setProperty("--color-inset", theme.appBg);
  root.style.setProperty("--color-control", theme.hairlineColor);
  root.style.setProperty("--color-hairline", theme.hairlineColor);
  root.style.setProperty("--color-ink", theme.inkColor);
  root.style.setProperty("--color-ink-secondary", theme.inkSecondaryColor);
  root.style.setProperty("--color-accent", theme.accentColor);
  root.style.setProperty("--color-accent-border", theme.accentColor);
  root.style.setProperty("--color-accent-text", theme.accentColor);
  root.style.setProperty("--color-focus", theme.accentColor);
  root.style.setProperty("--color-accent-ink", "#ffffff");
  root.style.setProperty("--color-bubble-user", `${theme.accentColor}20`);
}

export function applyCustomAccent(hex: string | null): void {
  const root = document.documentElement;
  if (!hex) {
    try {
      getStore()?.removeItem(ACCENT_KEY);
    } catch {
      // ignore
    }
    root.style.removeProperty("--color-accent");
    root.style.removeProperty("--color-accent-border");
    root.style.removeProperty("--color-accent-text");
    root.style.removeProperty("--color-focus");
    return;
  }

  try {
    getStore()?.setItem(ACCENT_KEY, hex);
  } catch {
    // ignore
  }

  root.style.setProperty("--color-accent", hex);
  root.style.setProperty("--color-accent-border", hex);
  root.style.setProperty("--color-accent-text", hex);
  root.style.setProperty("--color-focus", hex);
}

export function applySkin(id: SkinId): void {
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }

  let resolvedId = id;
  if (id === "system") {
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      resolvedId = "midnight";
    } else {
      resolvedId = "studio";
    }
  }

  document.documentElement.dataset.skin = resolvedId;

  if (resolvedId === "custom") {
    const customTheme = readCustomTheme();
    applyCustomTheme(customTheme);
  } else {
    // Clear custom palette overrides if switching back to preset skin
    const root = document.documentElement;
    root.style.removeProperty("--color-app");
    root.style.removeProperty("--color-panel");
    root.style.removeProperty("--color-card");
    root.style.removeProperty("--color-raised");
    root.style.removeProperty("--color-raised-hover");
    root.style.removeProperty("--color-inset");
    root.style.removeProperty("--color-control");
    root.style.removeProperty("--color-hairline");
    root.style.removeProperty("--color-ink");
    root.style.removeProperty("--color-ink-secondary");
    root.style.removeProperty("--color-bubble-user");

    const customAccent = readCustomAccent();
    if (customAccent) {
      applyCustomAccent(customAccent);
    }
  }
  
  try {
    void window.ogb?.applySkin?.(resolvedId)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
}
