import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionChildTree,
  type SessionChildTreeInput,
  type SessionChildTreeNode,
} from "../src/lib/sessionChildTree.js";

function meta(taskId: string, overrides?: Partial<SessionChildTreeInput>): SessionChildTreeInput {
  return {
    taskId,
    workspacePath: "C:/proj",
    title: taskId,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SessionChildTreeInput;
}

function flatten(nodes: SessionChildTreeNode[]): Array<{ id: string; depth: number }> {
  const out: Array<{ id: string; depth: number }> = [];
  const walk = (list: SessionChildTreeNode[], depth: number) => {
    for (const node of list) {
      out.push({ id: node.task.taskId, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

test("children attach under their forkedFrom parent and orphans stay top-level", () => {
  const tree = buildSessionChildTree([
    meta("parent"),
    meta("child", { forkedFromTaskId: "parent" }),
    meta("orphan", { forkedFromTaskId: "missing" }),
  ]);
  assert.deepEqual(flatten(tree), [
    { id: "parent", depth: 0 },
    { id: "child", depth: 1 },
    { id: "orphan", depth: 0 },
  ]);
});

test("a parent keeps its own row position while grandchildren nest one level deeper", () => {
  const tree = buildSessionChildTree([
    meta("root"),
    meta("mid", { forkedFromTaskId: "root" }),
    meta("leaf", { forkedFromTaskId: "mid" }),
    meta("other"),
  ]);
  assert.deepEqual(flatten(tree), [
    { id: "root", depth: 0 },
    { id: "mid", depth: 1 },
    { id: "leaf", depth: 2 },
    { id: "other", depth: 0 },
  ]);
});

test("cycles and self-parents cannot trap the render walk", () => {
  const tree = buildSessionChildTree([
    meta("a", { forkedFromTaskId: "b" }),
    meta("b", { forkedFromTaskId: "a" }),
    meta("solo", { forkedFromTaskId: "solo" }),
  ]);
  const flat = flatten(tree);
  assert.equal(flat.length, 3);
  assert.ok(flat.every((entry) => entry.depth <= 1));
});
