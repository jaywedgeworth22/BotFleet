import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SIDEBAR_THREAD_COUNT,
  MAX_SIDEBAR_THREAD_COUNT,
  MIN_SIDEBAR_THREAD_COUNT,
  SIDEBAR_COLLAPSED_ROOMS_KEY,
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_THREAD_COUNT_KEY,
  loadCollapsedRooms,
  loadCollapsedSections,
  loadCollapsedSectionsWithBotChatsDefault,
  saveCollapsedSections,
  orderSectionNames,
  BOT_CHATS_SECTION,
  SIDEBAR_COLLAPSED_SECTIONS_KEY,
  loadSidebarThreadCount,
  parseCollapsedRooms,
  parseSidebarThreadCount,
  saveCollapsedRooms,
  saveSidebarThreadCount,
  loadSidebarDensity,
  parseSidebarDensity,
  saveSidebarDensity,
  partitionSidebarGroups,
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

describe("collapsed roster sections", () => {
  it("starts every section open, so a new one is never hidden", () => {
    expect(loadCollapsedSections(null).size).toBe(0);
    expect(loadCollapsedSections({ getItem: () => null }).size).toBe(0);
  });

  it("round-trips the collapsed names", () => {
    const setItem = vi.fn();
    saveCollapsedSections(new Set(["Apps", "Bots"]), { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_SECTIONS_KEY, '["Apps","Bots"]');
  });

  it("keeps its own key, so a section and a channel of the same name never collide", () => {
    expect(SIDEBAR_COLLAPSED_SECTIONS_KEY).not.toBe(SIDEBAR_COLLAPSED_ROOMS_KEY);
  });

  it("survives a blocked store the way every other preference does", () => {
    expect(loadCollapsedSections({ getItem: () => { throw new Error("blocked"); } }).size).toBe(0);
    expect(() => saveCollapsedSections(new Set(["Apps"]), { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });
});

describe("partitionSidebarGroups", () => {
  it("keeps bot-to-bot DMs out of Apps even when a leftover section is set", () => {
    const { botChats, sectionedRooms, unsectionedRooms } = partitionSidebarGroups([
      { name: "Apps room", section: undefined },
      { name: "Work room", section: "Work" },
      { name: "Compiler ⇄ Designer", dm: true, section: "Apps" },
      { name: "New DM", dm: true },
    ]);
    expect(BOT_CHATS_SECTION).toBe("Bot Chats");
    expect(botChats.map((g) => g.name)).toEqual(["Compiler ⇄ Designer", "New DM"]);
    expect(unsectionedRooms.map((g) => g.name)).toEqual(["Apps room"]);
    expect(sectionedRooms.map((g) => g.name)).toEqual(["Work room"]);
  });
});

describe("sidebar section order and Bot Chats", () => {
  it("keeps stored context order and parks unknown names after", () => {
    expect(orderSectionNames(["Work", "Home", "Apps"], ["Apps", "Work"])).toEqual(["Apps", "Work", "Home"]);
  });

  it("never treats Bot Chats as a user-reorderable context", () => {
    expect(orderSectionNames(["Work", BOT_CHATS_SECTION], ["Work"])).toEqual(["Work"]);
  });

  it("collapses Bot Chats the first time the sidebar loads", () => {
    const store: Record<string, string> = {};
    const memory = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const first = loadCollapsedSectionsWithBotChatsDefault(memory);
    expect(first.has(BOT_CHATS_SECTION)).toBe(true);
    first.delete(BOT_CHATS_SECTION);
    saveCollapsedSections(first, memory);
    const second = loadCollapsedSectionsWithBotChatsDefault(memory);
    expect(second.has(BOT_CHATS_SECTION)).toBe(false);
  });
});
