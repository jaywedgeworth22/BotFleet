export type SidebarDensity = "comfortable" | "compact" | "icons";

export const SIDEBAR_DENSITY_KEY = "botfleet.sidebarDensity";

export function parseSidebarDensity(value: string | null): SidebarDensity {
  switch (value) {
    case "comfortable":
    case "compact":
    case "icons":
      return value;
    default:
      return "comfortable";
  }
}

export function loadSidebarDensity(storage?: Pick<Storage, "getItem"> | null): SidebarDensity {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarDensity(target?.getItem(SIDEBAR_DENSITY_KEY) ?? null);
  } catch {
    return "comfortable";
  }
}

export function saveSidebarDensity(
  density: SidebarDensity,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_DENSITY_KEY, density);
  } catch {
    // Private browsing and locked-down webviews may reject localStorage.
    // The in-memory React state still makes the control useful this session.
  }
}

/** How many of a channel's conversations the sidebar shows before it offers
 * the rest.  A handful is enough to recognise the one you want; the number
 * is a preference because "a handful" differs per person and per screen. */
export const SIDEBAR_THREAD_COUNT_KEY = "botfleet.sidebarThreadCount";
export const DEFAULT_SIDEBAR_THREAD_COUNT = 6;
export const MIN_SIDEBAR_THREAD_COUNT = 1;
export const MAX_SIDEBAR_THREAD_COUNT = 20;

export function parseSidebarThreadCount(value: string | null): number {
  // Nothing stored means the default, not zero: Number(null) is 0, which
  // would otherwise clamp to the minimum and show one conversation.
  if (value === null || value.trim() === "") return DEFAULT_SIDEBAR_THREAD_COUNT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_THREAD_COUNT;
  const whole = Math.round(parsed);
  if (whole < MIN_SIDEBAR_THREAD_COUNT) return MIN_SIDEBAR_THREAD_COUNT;
  if (whole > MAX_SIDEBAR_THREAD_COUNT) return MAX_SIDEBAR_THREAD_COUNT;
  return whole;
}

export function loadSidebarThreadCount(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseSidebarThreadCount(target?.getItem(SIDEBAR_THREAD_COUNT_KEY) ?? null);
  } catch {
    return DEFAULT_SIDEBAR_THREAD_COUNT;
  }
}

export function saveSidebarThreadCount(
  count: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_THREAD_COUNT_KEY, String(parseSidebarThreadCount(String(count))));
  } catch {
    // Same reasoning as the density preference: a blocked store is not a
    // reason to fail, the in-memory state still works this session.
  }
}

/** Which channels are collapsed.  Collapsed is the exception, so the stored
 * value is the list of collapsed ids and an unknown channel starts open. */
export const SIDEBAR_COLLAPSED_ROOMS_KEY = "botfleet.sidebarCollapsedRooms";

export function parseCollapsedRooms(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function loadCollapsedRooms(storage?: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseCollapsedRooms(target?.getItem(SIDEBAR_COLLAPSED_ROOMS_KEY) ?? null);
  } catch {
    return new Set();
  }
}

export function saveCollapsedRooms(
  collapsed: Set<string>,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(SIDEBAR_COLLAPSED_ROOMS_KEY, JSON.stringify([...collapsed]));
  } catch {
    // See above.
  }
}
