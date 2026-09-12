import { expect, it } from "vitest";
import { retainRoutineRuns, stripStalePromptSnapshots } from "./routine-retention";

it("keeps an old active execution and its receipts beyond 2,000 newer terminal records", () => {
  const owner = { id: "owner", status: "running", createdAt: 1 };
  const child = { id: "child", status: "running", createdAt: 2, coalescedInto: "owner" };
  const history = Array.from({ length: 2001 }, (_, i) => ({ id: `done-${i}`, status: "completed", createdAt: i + 3 }));
  const input = [owner, child, ...history];
  const result = retainRoutineRuns(input, 2000);
  expect(result).toHaveLength(2002);
  expect(result.slice(0, 2)).toEqual([owner, child]);
  expect(result.some((run) => run.id === "done-0")).toBe(false);
  expect(input).toHaveLength(2003);
  expect(result[0]).toBe(owner);

  const settled = result.map((run) => ["owner", "child"].includes(run.id)
    ? { ...run, status: "failed", finishedAt: 4000 } : run);
  const pruned = retainRoutineRuns(settled, 2000);
  expect(pruned).toHaveLength(2000);
  expect(pruned.slice(0, 2).map((run) => run.id)).toEqual(["owner", "child"]);
});

it("preserves a referenced owner and every queued or waiting receipt without expanding admission", () => {
  const runs = [
    { id: "owner", status: "completed", createdAt: 1 },
    { id: "child", status: "waiting", createdAt: 2, coalescedInto: "owner" },
    { id: "queued", status: "queued", createdAt: 3 },
    { id: "old", status: "cancelled", createdAt: 4 },
    { id: "new", status: "failed", createdAt: 5 },
  ];
  expect(retainRoutineRuns(runs, 1).map((run) => run.id)).toEqual(["owner", "child", "queued", "new"]);
});

it("drops prompt snapshots from settled runs beyond the newest N and leaves everything else intact", () => {
  const runs = [
    { id: "running", status: "running", createdAt: 1, prompt: "keep: active" },
    { id: "queued", status: "queued", createdAt: 2, prompt: "keep: queued" },
    { id: "old", status: "completed", createdAt: 3, finishedAt: 10, prompt: "drop: oldest settled" },
    { id: "mid", status: "failed", createdAt: 4, finishedAt: 20, prompt: "keep: second newest" },
    { id: "new", status: "completed", createdAt: 5, finishedAt: 30, prompt: "keep: newest" },
    { id: "receipt", status: "completed", createdAt: 0, finishedAt: 1, prompt: "keep: run_now receipt" },
    { id: "bare", status: "cancelled", createdAt: 6, finishedAt: 40 },
  ];
  expect(stripStalePromptSnapshots(runs, 2, ["receipt"])).toBe(1);
  expect(runs).toHaveLength(7);
  expect(runs.find((run) => run.id === "old")).toEqual({ id: "old", status: "completed", createdAt: 3, finishedAt: 10 });
  expect(runs.filter((run) => run.prompt !== undefined).map((run) => run.id)).toEqual(["running", "queued", "mid", "new", "receipt"]);
});

it("orders settled runs by finish time, falls back to creation, and rejects a negative limit", () => {
  const runs = [
    { id: "a", status: "completed", createdAt: 100, prompt: "a" },
    { id: "b", status: "completed", createdAt: 1, finishedAt: 50, prompt: "b" },
    { id: "c", status: "completed", createdAt: 2, finishedAt: 200, prompt: "c" },
  ];
  expect(stripStalePromptSnapshots(runs, 1)).toBe(2);
  expect(runs.filter((run) => run.prompt !== undefined).map((run) => run.id)).toEqual(["c"]);
  expect(stripStalePromptSnapshots(runs, 0)).toBe(1);
  expect(runs.every((run) => run.prompt === undefined)).toBe(true);
  expect(stripStalePromptSnapshots(runs, 0)).toBe(0);
  expect(() => stripStalePromptSnapshots(runs, -1)).toThrow(RangeError);
});

it("keeps the prompt on a settled owner while a waiting run still folds into it", () => {
  const runs = [
    { id: "owner", status: "completed", createdAt: 1, finishedAt: 1, prompt: "owner" },
    { id: "child", status: "waiting", createdAt: 2, coalescedInto: "owner", prompt: "child" },
    { id: "later", status: "completed", createdAt: 3, finishedAt: 3, prompt: "later" },
  ];
  expect(stripStalePromptSnapshots(runs, 0)).toBe(1);
  expect(runs.map((run) => run.prompt)).toEqual(["owner", "child", undefined]);
});
