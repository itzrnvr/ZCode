import assert from "node:assert/strict";
import test from "node:test";

interface PinnedRow {
  taskId: string;
}

function movePinnedRow(rows: PinnedRow[], fromTaskId: string, toIndex: number): PinnedRow[] {
  const fromIndex = rows.findIndex((row) => row.taskId === fromTaskId);
  assert.ok(fromIndex >= 0, `row ${fromTaskId} must exist before moving`);
  const bounded = Math.max(0, Math.min(toIndex, rows.length - 1));
  const next = [...rows];
  const [moved] = next.splice(fromIndex, 1);
  assert.ok(moved);
  next.splice(bounded, 0, moved!);
  return next;
}

test("a pinned row moves to an explicit index without dropping siblings", () => {
  const next = movePinnedRow(
    [{ taskId: "a" }, { taskId: "b" }, { taskId: "c" }],
    "c",
    0,
  );
  assert.deepEqual(
    next.map((row) => row.taskId),
    ["c", "a", "b"],
  );
});

test("a move target outside the list clamps to the nearest end", () => {
  const rows = [{ taskId: "a" }, { taskId: "b" }, { taskId: "c" }];
  assert.deepEqual(
    movePinnedRow(rows, "a", 99).map((row) => row.taskId),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    movePinnedRow(rows, "c", -5).map((row) => row.taskId),
    ["c", "a", "b"],
  );
});

test("a move that names an unknown row fails instead of corrupting order", () => {
  assert.throws(() => movePinnedRow([{ taskId: "a" }], "missing", 0));
});
