import { expect, it } from "vitest";
import { retainRoutineRuns } from "./routine-retention";

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
