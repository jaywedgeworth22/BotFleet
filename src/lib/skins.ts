// Skins are pure CSS. Every one of them is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS.

export const SKIN_IDS = [
  "system",
  "studio",
  "titanium",
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "system", name: "System", tagline: "Matches macOS Dark/Light Mode" },
  { id: "studio", name: "Studio Clean", tagline: "Pure white, crisp modern macOS daylight." },
  { id: "titanium", name: "Titanium Frost", tagline: "Brushed titanium and cool slate silver." },
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
];

export const ACCENT_PRESETS = [
  { name: "Royal Blue", hex: "#0969da" },
  { name: "Electric Blue", hex: "#1084fe" },
  { name: "Indigo", hex: "#4f46e5" },
  { name: "Violet", hex: "#7c3aed" },
  { name: "Emerald", hex: "#059669" },
  { name: "Warm Amber", hex: "#d97706" },
  { name: "Crimson Rose", hex: "#e11d48" },
  { name: "Titanium Slate", hex: "#475569" },
] as const;

export function getDefaultSkin(): SkinId {
  return "system";
}

const KEY = "omb-skin";
const ACCENT_KEY = "omb-custom-accent";

// The input is whatever localStorage handed back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from a renamed
// skin. The list is the schema.
function isSkinId(value: unknown): value is SkinId {
  return SKIN_IDS.includes(value as SkinId);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` alone doesn't shield it.
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

/**
 * Point the document at a skin and remember it. Called once before the first
 * paint (main.tsx) and again on every change from the picker — a stamped
 * attribute rather than a class so it can never collide with Tailwind.
 */
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

  const customAccent = readCustomAccent();
  if (customAccent) {
    applyCustomAccent(customAccent);
  }
  
  // The one surface CSS cannot reach: on Windows the caption buttons sit in a
  // native overlay the main process paints. Left at the default it stays
  // Midnight-black on a light skin — the "black block in the top-right
  // corner" of issue #454. Best-effort: a browser tab or an older desktop
  // build has no bridge, and the skin still applies without it.
  try {
    void window.ogb?.applySkin?.(resolvedId)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
}
