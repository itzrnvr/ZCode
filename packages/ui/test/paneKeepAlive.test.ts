import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PANE_KEEP_ALIVE_MAX_HIDDEN,
  createPaneKeepAliveStack,
} from "../src/v4/paneKeepAlive.js";

function createStack(maxHidden = DEFAULT_PANE_KEEP_ALIVE_MAX_HIDDEN): {
  stack: ReturnType<typeof createPaneKeepAliveStack>;
  evicted: string[];
  now: () => number;
  advance(ms: number): void;
} {
  let current = 1_000;
  const evicted: string[] = [];
  const stack = createPaneKeepAliveStack({
    maxHidden,
    now: () => current,
    onEvict: (sessionId) => evicted.push(sessionId),
  });
  return {
    stack,
    evicted,
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test("默认保留 4 个隐藏 pane（规格里那个 N），第 5 个会话把最久未用的挤出去", () => {
  const { stack, evicted } = createStack();
  stack.touch("A");
  stack.touch("B");
  stack.touch("C");
  stack.touch("D");
  assert.deepEqual(stack.entries(), ["A", "B", "C", "D"]);
  assert.deepEqual(evicted, []);

  const order = stack.touch("E");
  assert.deepEqual(order, ["B", "C", "D", "E"], "最久未用的 A 被淘汰，顺序保持 LRU");
  assert.deepEqual(evicted, ["A"]);
  assert.equal(stack.size(), 4);
});

test("淘汰顺序严格按最久未用，重新 touch 会把会话提到最新端", () => {
  const { stack, evicted } = createStack();
  for (const sessionId of ["A", "B", "C", "D"]) stack.touch(sessionId);
  // A 本来会被淘汰，重新打开它之后应该改淘汰 B。
  stack.touch("A");
  assert.deepEqual(stack.entries(), ["B", "C", "D", "A"]);
  stack.touch("E");
  assert.deepEqual(stack.entries(), ["C", "D", "A", "E"]);
  assert.deepEqual(evicted, ["B"]);
});

test("当前活跃会话不会被淘汰，即使保留集已经满了", () => {
  const { stack, evicted } = createStack(1);
  stack.touch("A");
  // maxHidden = 1：touch B 之后 A 出局，但 B 是活跃项，必须留下。
  const order = stack.touch("B");
  assert.deepEqual(order, ["B"]);
  assert.deepEqual(evicted, ["A"]);
  stack.touch("B");
  assert.deepEqual(stack.entries(), ["B"], "重复 touch 活跃项不产生淘汰");
  assert.deepEqual(evicted, ["A"]);
});

test("草稿（null）永不保留：草稿 pane 的身份是 workspace 而不是会话", () => {
  const { stack, evicted } = createStack();
  stack.touch("A");
  const order = stack.touch(null);
  assert.deepEqual(order, ["A"], "切到草稿不会把已保留的会话清掉");
  assert.deepEqual(evicted, []);
  stack.touch("");
  assert.deepEqual(stack.entries(), ["A"], "空串同样按草稿处理");
});

test("已由别的 leaf 承载的会话从保留集剔除，活跃项除外", () => {
  const { stack, evicted } = createStack();
  for (const sessionId of ["A", "B", "C"]) stack.touch(sessionId);
  stack.touch("C");
  const order = stack.exclude(new Set(["A", "C"]));
  assert.deepEqual(order, ["B", "C"], "A 被剔除；C 是当前活跃项，exclude 不能把活跃 pane 剔掉");
  assert.deepEqual(evicted, ["A"]);
});

test("drop 主动丢弃（会话被删除 / pane 关闭），并清掉活跃标记", () => {
  const { stack } = createStack();
  stack.touch("A");
  stack.touch("B");
  stack.drop("A");
  assert.deepEqual(stack.entries(), ["B"]);
  stack.drop("B");
  assert.deepEqual(stack.entries(), []);
  // B 是活跃项，drop 之后再 touch null 不该把它复活。
  assert.equal(stack.size(), 0);
});

test("touchedAt 只用于诊断，淘汰看的是插入序", () => {
  const harness = createStack();
  harness.stack.touch("A");
  harness.advance(5_000);
  harness.stack.touch("B");
  assert.deepEqual(harness.stack.entries(), ["A", "B"], "时间推进本身不改变顺序");
  harness.stack.touch("A");
  assert.deepEqual(harness.stack.entries(), ["B", "A"], "touch 才改变顺序");
});
