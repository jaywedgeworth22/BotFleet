import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SIDEBAR_THREAD_COUNT,
  MAX_SIDEBAR_THREAD_COUNT,
  MIN_SIDEBAR_THREAD_COUNT,
  SIDEBAR_COLLAPSED_ROOMS_KEY,
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_THREAD_COUNT_KEY,
  loadCollapsedRooms,
  loadSidebarThreadCount,
  parseCollapsedRooms,
  parseSidebarThreadCount,
  saveCollapsedRooms,
  saveSidebarThreadCount,
  loadSidebarDensity,
  parseSidebarDensity,
  saveSidebarDensity,
} from "./sidebar-preferences";

describe("sidebar density preferences", () => {
  it("accepts the three supported layouts and rejects stale values", () => {
    expect(parseSidebarDensity("comfortable")).toBe("comfortable");
    expect(parseSidebarDensity("compact")).toBe("compact");
    expect(parseSidebarDensity("icons")).toBe("icons");
    expect(parseSidebarDensity("tiny")).toBe("comfortable");
    expect(parseSidebarDensity(null)).toBe("comfortable");
  });

  it("loads and saves without making storage availability a launch dependency", () => {
    const setItem = vi.fn();
    saveSidebarDensity("icons", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_DENSITY_KEY, "icons");
    expect(loadSidebarDensity({ getItem: () => "compact" })).toBe("compact");
    expect(loadSidebarDensity({ getItem: () => { throw new Error("blocked"); } })).toBe("comfortable");
  });
});

describe("how many conversations a channel shows", () => {
  it("clamps to a sane range and survives nonsense", () => {
    expect(parseSidebarThreadCount("8")).toBe(8);
    expect(parseSidebarThreadCount("0")).toBe(MIN_SIDEBAR_THREAD_COUNT);
    expect(parseSidebarThreadCount("999")).toBe(MAX_SIDEBAR_THREAD_COUNT);
    expect(parseSidebarThreadCount("many")).toBe(DEFAULT_SIDEBAR_THREAD_COUNT);
    expect(parseSidebarThreadCount(null)).toBe(DEFAULT_SIDEBAR_THREAD_COUNT);
    expect(parseSidebarThreadCount("6.4")).toBe(6);
  });

  it("saves the clamped number, not the typed one", () => {
    const setItem = vi.fn();
    saveSidebarThreadCount(999, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_THREAD_COUNT_KEY, "20");
  });

  it("falls back when storage is unavailable", () => {
    expect(loadSidebarThreadCount({ getItem: () => { throw new Error("blocked"); } })).toBe(
      DEFAULT_SIDEBAR_THREAD_COUNT,
    );
  });
});

describe("which channels are collapsed", () => {
  it("starts every channel open, including ones it has never seen", () => {
    expect(parseCollapsedRooms(null).size).toBe(0);
    expect(parseCollapsedRooms("not json").size).toBe(0);
    expect(parseCollapsedRooms('{"grp_1":true}').size).toBe(0);
    expect(loadCollapsedRooms({ getItem: () => { throw new Error("blocked"); } }).size).toBe(0);
  });

  it("round-trips the collapsed ids and ignores junk entries", () => {
    const setItem = vi.fn();
    saveCollapsedRooms(new Set(["grp_1", "grp_2"]), { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_ROOMS_KEY, '["grp_1","grp_2"]');
    expect([...parseCollapsedRooms('["grp_1",7,null,"grp_2"]')]).toEqual(["grp_1", "grp_2"]);
  });
});
