import assert from "node:assert/strict";
import test from "node:test";
import { createFastRowsLayer } from "../src/v4/conversationFastRowsLayer.js";
import type { ConversationRowsFastOutcome } from "../src/v4/conversationRowsFastPath.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

// 播种只看 rowId / revision / hasMore，其余字段不参与判定；给最小可辨识的行即可。
function rowAt(rowId: number): ConversationRow {
  return { kind: "turnHeader", rowId, turnId: `turn-${rowId}` } as ConversationRow;
}

function ok(
  rowIds: readonly number[],
  revision = "1:1:1",
  hasMore = false,
): ConversationRowsFastOutcome {
  return {
    ok: true,
    revision,
    rows: rowIds.map(rowAt),
    hasMore,
  };
}

test("成功结果落地后可读，并标记为临时态", () => {
  const layer = createFastRowsLayer();
  assert.equal(layer.isProvisional(), false);
  assert.equal(layer.read(), null);
  assert.equal(layer.seed(ok([1, 2, 3], "7:2:1", true), 1_000), true);
  assert.equal(layer.isProvisional(), true);
  const seeded = layer.read();
  assert.equal(seeded?.revision, "7:2:1");
  assert.equal(seeded?.hasMore, true);
  assert.equal(seeded?.seededAt, 1_000);
  assert.deepEqual(
    seeded?.rows.map((row) => row.rowId),
    [1, 2, 3],
  );
});

test("重复播种是整体替换而不是拼接：快绘 rowId 会与权威 rowId 错位，合并会拼出谁都不认的投影", () => {
  const layer = createFastRowsLayer();
  layer.seed(ok([1, 2]), 1_000);
  layer.seed(ok([1, 2, 3, 4]), 1_500);
  const seeded = layer.read();
  assert.equal(seeded?.rows.length, 4, "第二次播种完全取代第一次");
  assert.equal(seeded?.seededAt, 1_500);
});

test("失败结果与空窗口都不落地：空窗口画出来和今天的空状态一样，却会白白降级行级能力", () => {
  const layer = createFastRowsLayer();
  for (const reason of ["missing", "building", "stale", "partial", "unsupported", "unavailable"] as const) {
    assert.equal(layer.seed({ ok: false, reason }, 1_000), false, `${reason} 不该落地`);
  }
  assert.equal(layer.seed(ok([]), 1_000), false);
  assert.equal(layer.read(), null);
  assert.equal(layer.isProvisional(), false);
});

test("权威 snapshot 落地即清空，并且本实例永久拒绝再播种", () => {
  const layer = createFastRowsLayer();
  layer.seed(ok([1, 2]), 1_000);
  layer.markAuthoritative();
  assert.equal(layer.read(), null);
  assert.equal(layer.isProvisional(), false);
  // 这条是竞态防线：projection 的后台折叠是 coalesced + single-flighted，写突发会推迟它，
  // 所以一次读取完全可能在首个 snapshot 之后才 resolve。那时它在时间上更新，
  // 但用临时数据覆盖权威状态是错的。
  assert.equal(layer.seed(ok([9, 10], "9:9:9"), 5_000), false);
  assert.equal(layer.read(), null, "迟到的快绘结果必须被忽略");
});

test("没有临时行时 markAuthoritative 也是安全的（首绘就走权威路径的会话）", () => {
  const layer = createFastRowsLayer();
  layer.markAuthoritative();
  assert.equal(layer.read(), null);
  assert.equal(layer.seed(ok([1]), 1_000), false);
});

test("clear 只清空不标记权威：store 关闭后新实例仍能重新播种", () => {
  const layer = createFastRowsLayer();
  layer.seed(ok([1, 2]), 1_000);
  layer.clear();
  assert.equal(layer.read(), null);
  assert.equal(layer.isProvisional(), false);
  assert.equal(layer.seed(ok([5]), 2_000), true, "clear 不是永久拒绝");
  assert.equal(layer.read()?.rows.length, 1);
});

test("临时态不改变读取结果的内容：revision 原样保留，供后续 minRevision 回传", () => {
  const layer = createFastRowsLayer();
  layer.seed(ok([1], "123:45:3"), 1_000);
  // revision 是 3 段字符串，只能 !== 比较；这里断言它没有被解析或改写。
  assert.equal(layer.read()?.revision, "123:45:3");
});
