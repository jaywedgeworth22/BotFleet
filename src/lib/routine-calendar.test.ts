import { describe, expect, it } from "vitest";

import type { Routine } from "./routines";
import {
  calendarDayLabel,
  calendarMinuteOfDay,
  editedDailySchedule,
  nextCalendarRunLabel,
  projectedRoutineItems,
  routineScheduleLabel,
  timeZoneLabel,
} from "./routine-calendar";

function routine(schedule: Routine["schedule"]): Routine {
  return {
    id: "routine",
    name: "Fixture",
    prompt: "Check",
    botId: "bot",
    runOn: "maus",
    enabled: true,
    schedule,
    durationMinutes: 30,
    nextRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("routine calendar timezone", () => {
  it("places an explicit recurrence by its own weekday and the resulting Central instant", () => {
    const from = Date.parse("2026-09-13T05:00:00.000Z");
    const to = Date.parse("2026-09-14T05:00:00.000Z");
    const items = projectedRoutineItems([
      routine({ type: "daily", time: "00:30", weekdays: [1], timeZone: "Asia/Tokyo" }),
    ], [], from, to);

    expect(items.map((item) => item.at)).toEqual([Date.parse("2026-09-13T15:30:00.000Z")]);
    expect(calendarDayLabel(items[0].at)).toEqual({ weekday: "Sun", day: 13 });
    expect(calendarMinuteOfDay(items[0].at)).toBe(10 * 60 + 30);
  });

  it("does not project a second card when a run receipt already owns the occurrence", () => {
    const scheduledFor = Date.parse("2026-09-14T14:00:00.000Z");
    const definition = routine({ type: "daily", time: "09:00", weekdays: [1], timeZone: "America/Chicago" });
    const runs = [{
      id: "run",
      routineId: definition.id,
      routineName: definition.name,
      botId: definition.botId,
      runOn: definition.runOn,
      scheduledFor,
      status: "completed" as const,
      manual: false,
      createdAt: scheduledFor,
    }];
    const items = projectedRoutineItems([definition], runs, Date.parse("2026-09-14T05:00:00.000Z"), Date.parse("2026-09-15T05:00:00.000Z"));
    expect(items.map((item) => item.id)).toEqual(["run-run"]);
  });

  it("names both the Central calendar policy and a preserved legacy host zone", () => {
    expect(timeZoneLabel("America/Chicago", Date.parse("2026-07-01T12:00:00Z"))).toBe("Central Time (CDT)");
    const legacy = routine({ type: "daily", time: "09:00", weekdays: [1], timeZone: "Europe/Athens" });
    expect(routineScheduleLabel(legacy)).toMatch(/^Mon at 9:00 AM (GMT\+3|EEST)$/);
  });

  it("omits a display-only host zone when an existing legacy recurrence is edited", () => {
    const legacy = {
      ...routine({ type: "daily", time: "09:00", weekdays: [1], timeZone: "Europe/Athens" }),
      scheduleTimeZoneSource: "host" as const,
    };
    const explicit = { ...legacy, scheduleTimeZoneSource: "stored" as const };

    expect(editedDailySchedule(legacy, "10:00", [2], "Europe/Athens")).toEqual({
      type: "daily",
      time: "10:00",
      weekdays: [2],
    });
    expect(editedDailySchedule(explicit, "10:00", [2], "Europe/Athens")).toEqual({
      type: "daily",
      time: "10:00",
      weekdays: [2],
      timeZone: "Europe/Athens",
    });
  });

  it("labels the next run by the Central calendar date instead of the browser date", () => {
    const now = Date.parse("2026-09-13T04:45:00.000Z");
    const at = Date.parse("2026-09-13T04:55:00.000Z");
    expect(nextCalendarRunLabel(at, now)).toBe("Today, 11:55 PM CDT");
  });
});
