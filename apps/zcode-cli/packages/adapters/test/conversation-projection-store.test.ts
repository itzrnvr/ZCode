import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import type { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { CONV_PROJECTION_SCHEMA_VERSION } from "../src/storage/session-store/migrations/0024-conversation-projection.js";
import type { StoredProjectionRow } from "../src/storage/session-store/repositories/conversation-projection.js";
import type { MessageId, PartId, ProjectId, SessionId } from "@zcode/contracts";

/**
 * conversation projection（0024）的**存储层**回归。
 *
 * 与 session-store-side-chat-query.test.ts 同一条纪律：用真库真迁移，不手搓 CREATE TABLE。
 * `createSqliteSessionStore` 会跑完整 migration，于是「0024 的 DDL 与线上逐字节一致」这件事
 * 是被验证的，而不是被假设的。断言一律走 store 的公开只读面（readConversationProjectionView），
 * 不碰 private 的 db 句柄——测的是端口契约，不是内部实现。
 *
 * 这里钉住的是四件容易悄悄坏掉的事：
 * 1. 水位覆盖**删除**。removeMessage / removePart 今天不 touchSession，所以光靠
 *    session.time_updated 会对「行变少了」保持沉默 —— 那正是把已删分支当最新投影发出去的形状。
 * 2. 同毫秒原地更新也会推进水位。max(id) / max(sequence) / time_updated 对它全是盲的，
 *    而那恰好就是 persistAssistantMessage 写 time.completed 的那次 turn 收尾更新；漏掉即 false-fresh。
 * 3. 乐观提交的丢弃语义。折叠不持锁，所以「折叠期间水位被推进」必须导致**丢弃**，
 *    而不是用新 revision 盖旧行 —— 盖上去就是把 false-fresh 写进库里。
 * 4. schema_version 升位强制整表重写。后缀 diff 只比 payload 字节，两版格式恰好相同的行
 *    会被留下，于是「升位即让旧行失效」会有漏洞。
 */

const PROJECT = "proj_conv_projection" as ProjectId;
const DIRECTORY = "C:/proj";
const ALL_ROWS = 10_000;

function sid(value: string): SessionId {
  return value as SessionId;
}

function mid(value: string): MessageId {
  return value as MessageId;
}

function pid(value: string): PartId {
  return value as PartId;
}

async function withStore(run: (store: SqliteSessionStore, dbPath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-conv-projection-"));
  const dbPath = join(dir, "db.sqlite");
  const store = createSqliteSessionStore({ dbPath });
  try {
    await run(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 与 withStore 的区别：只负责临时目录，store 的开/关交给用例自己。
 * 迁移幂等那条用例必须真的关掉再重开同一个库（重开才会重跑 migration runner），
 * 而 withStore 的 finally 会再关一次，于是撞上 ERR_INVALID_STATE。
 */
async function withDbPath(run: (dbPath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-conv-projection-"));
  try {
    await run(join(dir, "db.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sessionInput(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: sid(id),
    projectID: PROJECT,
    slug: id,
    directory: DIRECTORY,
    title: id,
    version: "3.14.3",
    ...overrides,
  };
}

function messageInput(id: string, sessionID: string, role: "user" | "assistant", created: number) {
  return {
    id: mid(id),
    sessionID: sid(sessionID),
    role,
    time: { created },
  };
}

function textPart(id: string, sessionID: string, messageID: string, text: string) {
  return {
    id: pid(id),
    sessionID: sid(sessionID),
    messageID: mid(messageID),
    type: "text",
    text,
  };
}

function row(rowId: number, payload: string): StoredProjectionRow {
  return { rowId, turnId: `hydrate-turn-${rowId}`, kind: "assistantText", payload };
}

async function storedPayloads(store: SqliteSessionStore, sessionID: string): Promise<string[]> {
  const view = await store.readConversationProjectionView(sid(sessionID), { limit: ALL_ROWS });
  return view.rows.map((candidate) => candidate.payload);
}

async function commitRows(
  store: SqliteSessionStore,
  sessionID: string,
  rows: readonly StoredProjectionRow[],
  schemaVersion: number = CONV_PROJECTION_SCHEMA_VERSION,
) {
  const seq = await store.readConversationProjectionWatermark(sid(sessionID));
  return store.commitConversationProjection({
    sessionID: sid(sessionID),
    expectedSeq: seq,
    revision: `${seq}:${seq}:${schemaVersion}`,
    schemaVersion,
    rows,
  });
}

test("0024 applies, is idempotent, and an unfolded session reads back as no-meta/no-rows", async () => {
  await withDbPath(async (dbPath) => {
    const store = createSqliteSessionStore({ dbPath });
    try {
      // 表不存在的话这几条会直接 no such table，所以它们同时就是「DDL 已生效」的证明。
      const empty = await store.readConversationProjectionView(sid("sess_none"), { limit: 10 });
      assert.equal(empty.meta, null);
      assert.deepEqual(empty.rows, []);
      assert.equal(empty.hasMore, false);
      assert.equal(await store.readConversationProjectionWatermark(sid("sess_none")), 0);

      await store.createSession(sessionInput("sess_a") as never);
      await store.saveMessage(messageInput("msg_a1", "sess_a", "user", 1_000) as never);
    } finally {
      store.close();
    }

    // 同一个库再开一次 = 迁移重跑。已应用的迁移必须被 checksum 判定为 no-op，
    // 且第一次写入的水位要活下来。
    const reopened = createSqliteSessionStore({ dbPath });
    try {
      assert.equal(await reopened.readConversationProjectionWatermark(sid("sess_a")), 1);
      const view = await reopened.readConversationProjectionView(sid("sess_a"), { limit: 10 });
      assert.equal(view.meta, null, "还没折叠过，就不该有 meta 行");
    } finally {
      reopened.close();
    }
  });
});

test("watermark advances by exactly one for each of the four message/part mutators", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_w") as never);
    const sessionID = sid("sess_w");
    assert.equal(await store.readConversationProjectionWatermark(sessionID), 0);

    await store.saveMessage(messageInput("msg_w1", "sess_w", "user", 1_000) as never);
    assert.equal(await store.readConversationProjectionWatermark(sessionID), 1);

    await store.savePart(textPart("part_w1", "sess_w", "msg_w1", "hello") as never);
    assert.equal(await store.readConversationProjectionWatermark(sessionID), 2);

    // 删除是这条测试的重点：removeMessage / removePart 不 touchSession，
    // 只有 0024 的水位能让「行变少了」推进 revision。
    await store.removePart({ sessionID, messageID: mid("msg_w1"), partID: pid("part_w1") });
    assert.equal(await store.readConversationProjectionWatermark(sessionID), 3);

    await store.removeMessage({ sessionID, messageID: mid("msg_w1") });
    assert.equal(await store.readConversationProjectionWatermark(sessionID), 4);
  });
});

test("in-place saveMessage in the same millisecond still advances the watermark", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_samems") as never);
    const sessionID = sid("sess_samems");
    const created = 1_700_000_000_000;
    // 同一个 time.created / time.completed，于是 session.time_updated 完全不动。
    const assistant = {
      ...messageInput("msg_asst", "sess_samems", "assistant", created),
      time: { created, completed: created },
    };
    await store.saveMessage(assistant as never);
    const afterFirst = await store.readConversationProjectionWatermark(sessionID);
    const sessionBefore = await store.getSession(sessionID);

    await store.saveMessage(assistant as never);
    const afterSecond = await store.readConversationProjectionWatermark(sessionID);
    const sessionAfter = await store.getSession(sessionID);

    // 这就是 max(id) / max(sequence) / time_updated 全都看不见的那次写入：
    // turn 收尾把 time.completed 补上去，行 id 与 sequence 都不变，毫秒也没变。
    assert.equal(sessionAfter?.time.updated, sessionBefore?.time.updated, "time_updated 确实没动");
    assert.equal(afterSecond, afterFirst + 1, "水位必须仍然 +1，否则 revision 会 false-fresh");
  });
});

test("commit is optimistic: a watermark move during the fold discards instead of overwriting", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_opt") as never);
    const sessionID = sid("sess_opt");
    await store.saveMessage(messageInput("msg_o1", "sess_opt", "user", 1_000) as never);
    const seq0 = await store.readConversationProjectionWatermark(sessionID);

    // 折叠进行中：另一处写入落地（跨进程写入就是这条路径——它推得动水位，
    // 却到不了本进程的 sink，所以只能靠这里的 seq 比对兜住）。
    await store.savePart(textPart("part_o1", "sess_opt", "msg_o1", "late") as never);

    const discarded = await store.commitConversationProjection({
      sessionID,
      expectedSeq: seq0,
      revision: `1:${seq0}:${CONV_PROJECTION_SCHEMA_VERSION}`,
      schemaVersion: CONV_PROJECTION_SCHEMA_VERSION,
      rows: [row(1, '{"rowId":1}')],
    });
    assert.equal(discarded.committed, false);
    assert.equal(discarded.rewritten, 0);
    const afterDiscard = await store.readConversationProjectionView(sessionID, { limit: 10 });
    assert.equal(afterDiscard.meta, null, "丢弃就绝不能留下 meta，否则旧行会被当成最新投影");
    assert.deepEqual(afterDiscard.rows, []);

    // 用当前水位重折叠就能落盘。
    const seq1 = await store.readConversationProjectionWatermark(sessionID);
    const committed = await store.commitConversationProjection({
      sessionID,
      expectedSeq: seq1,
      revision: `1:${seq1}:${CONV_PROJECTION_SCHEMA_VERSION}`,
      schemaVersion: CONV_PROJECTION_SCHEMA_VERSION,
      rows: [row(1, '{"rowId":1}'), row(2, '{"rowId":2}')],
    });
    assert.equal(committed.committed, true);
    assert.equal(committed.rewritten, 2);
    const view = await store.readConversationProjectionView(sessionID, { limit: 10 });
    assert.equal(view.meta?.revision, `1:${seq1}:${CONV_PROJECTION_SCHEMA_VERSION}`);
    assert.deepEqual(
      view.rows.map((candidate) => candidate.rowId),
      [1, 2],
    );
  });
});

test("suffix diff rewrites only what changed", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_diff") as never);
    const base = [row(1, '{"rowId":1}'), row(2, '{"rowId":2}'), row(3, '{"rowId":3}')];
    assert.equal((await commitRows(store, "sess_diff", base)).rewritten, 3);
    // 完全相同的重折叠：0 行重写。流式追加只碰尾部，这是「只重算受影响的行」的可观察证据。
    assert.equal((await commitRows(store, "sess_diff", base)).rewritten, 0);
    // 追加一行：只重写 1 行。
    assert.equal(
      (await commitRows(store, "sess_diff", [...base, row(4, '{"rowId":4}')])).rewritten,
      1,
    );
    // 改第 0 行：其后全部重写（行序是数组序，早期变化会顺移后面所有行）。
    const changedFirst = [
      row(1, '{"rowId":1,"v":2}'),
      row(2, '{"rowId":2}'),
      row(3, '{"rowId":3}'),
      row(4, '{"rowId":4}'),
    ];
    assert.equal((await commitRows(store, "sess_diff", changedFirst)).rewritten, 4);

    assert.deepEqual(await storedPayloads(store, "sess_diff"), [
      '{"rowId":1,"v":2}',
      '{"rowId":2}',
      '{"rowId":3}',
      '{"rowId":4}',
    ]);
  });
});

test("a schema_version bump forces a full rewrite instead of keeping byte-identical old rows", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_schema") as never);
    const sessionID = sid("sess_schema");
    const rows = [row(1, '{"rowId":1}'), row(2, '{"rowId":2}')];

    await commitRows(store, "sess_schema", rows, 99);
    // payload 逐字节相同，只有 schema_version 不同。后缀 diff 只比字节，
    // 所以必须显式强制整表重写，否则「升位即让旧行失效」这条规则就有了漏洞。
    const rewritten = await commitRows(store, "sess_schema", rows);
    assert.equal(rewritten.rewritten, 2);
    const view = await store.readConversationProjectionView(sessionID, { limit: 10 });
    assert.equal(view.meta?.schemaVersion, CONV_PROJECTION_SCHEMA_VERSION);
  });
});

test("paging: tail page, beforeRowId cursor, hasMore and limit", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_page") as never);
    const sessionID = sid("sess_page");
    await commitRows(
      store,
      "sess_page",
      [1, 2, 3, 4, 5].map((rowId) => row(rowId, `{"rowId":${rowId}}`)),
    );

    // 尾页：最新的两行，仍按 rowId 升序返回。
    const tail = await store.readConversationProjectionView(sessionID, { limit: 2 });
    assert.deepEqual(
      tail.rows.map((candidate) => candidate.rowId),
      [4, 5],
    );
    assert.equal(tail.hasMore, true);

    // 游标向上翻页：严格更旧，不与上一页重叠。
    const older = await store.readConversationProjectionView(sessionID, {
      beforeRowId: tail.rows[0]!.rowId,
      limit: 2,
    });
    assert.deepEqual(
      older.rows.map((candidate) => candidate.rowId),
      [2, 3],
    );
    assert.equal(older.hasMore, true);

    const oldest = await store.readConversationProjectionView(sessionID, {
      beforeRowId: older.rows[0]!.rowId,
      limit: 2,
    });
    assert.deepEqual(
      oldest.rows.map((candidate) => candidate.rowId),
      [1],
    );
    assert.equal(oldest.hasMore, false, "到顶之后必须明确说没有更早的行");

    // 空库：hasMore 恒 false，不给尾页开特例。
    const empty = await store.readConversationProjectionView(sid("sess_page_missing"), { limit: 5 });
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.hasMore, false);
  });
});

test("deleteConversationProjection drops meta and rows but keeps the watermark", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_del") as never);
    const sessionID = sid("sess_del");
    await store.saveMessage(messageInput("msg_d1", "sess_del", "user", 1_000) as never);
    const seq = await store.readConversationProjectionWatermark(sessionID);
    await commitRows(store, "sess_del", [row(1, '{"rowId":1}')]);

    await store.deleteConversationProjection(sessionID);
    const view = await store.readConversationProjectionView(sessionID, { limit: 10 });
    assert.equal(view.meta, null);
    assert.deepEqual(view.rows, []);
    // 水位必须活下来：revision 不能倒退，否则客户端手里的 minRevision 永远满足不了。
    assert.equal(await store.readConversationProjectionWatermark(sessionID), seq);
  });
});

test("setRevert and clearRevert both invalidate through the store funnel", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_rev") as never);
    const sessionID = sid("sess_rev");
    await store.saveMessage(messageInput("msg_r1", "sess_rev", "user", 1_000) as never);
    await commitRows(store, "sess_rev", [row(1, '{"rowId":1}')]);

    // 走 store 方法而不是 repository 函数：被测的就是那个唯一漏斗
    // （setRevert / clearRevert 是端口的必需成员，唯一的外部调用方 rewind-message.ts 也走端口）。
    await store.setRevert({ sessionID, revert: { messageID: mid("msg_r1") } });
    let view = await store.readConversationProjectionView(sessionID, { limit: 10 });
    assert.equal(view.meta, null, "revert 之后活跃分支不可由有界尾部重建，必须 delete-on-uncertain");
    assert.deepEqual(view.rows, []);
    const afterRevert = await store.readConversationProjectionWatermark(sessionID);

    await store.clearRevert(sessionID);
    view = await store.readConversationProjectionView(sessionID, { limit: 10 });
    assert.equal(view.meta, null, "清空 revert 也要删，否则会把按已撤销分支折出来的行当最新投影");
    assert.equal(
      await store.readConversationProjectionWatermark(sessionID),
      afterRevert,
      "两次失效都不许动水位",
    );
    const session = await store.getSession(sessionID);
    assert.equal(session?.revert, undefined);
  });
});

test("the dirty notification forwards to the registered sink and stays inert without one", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_sink") as never);
    const sessionID = sid("sess_sink");

    // 没有 sink 时不得抛：core 的写入路径是同步转发，异常会打断 agent 落库。
    store.notifyConversationProjectionDirty({ sessionID, phase: "part" });

    const seen: Array<{ sessionID: SessionId; phase: string }> = [];
    store.setConversationProjectionSink((input) => {
      seen.push({ sessionID: input.sessionID, phase: input.phase });
    });
    store.notifyConversationProjectionDirty({ sessionID, phase: "turn-finalized" });
    assert.deepEqual(seen, [{ sessionID, phase: "turn-finalized" }]);

    store.setConversationProjectionSink(null);
    store.notifyConversationProjectionDirty({ sessionID, phase: "message" });
    assert.equal(seen.length, 1, "注销之后不该再收到通知");

    // store 这一层刻意**不**吞异常：吞错属于 core 的 notifyConversationProjectionDirty helper
    // （它在 agent 写入路径上，不能让折叠侧的故障打断落库）。这里断言透传，
    // 于是「谁负责吞错」这条分工被测试钉住，而不是靠注释。
    store.setConversationProjectionSink(() => {
      throw new Error("sink exploded");
    });
    assert.throws(() => store.notifyConversationProjectionDirty({ sessionID, phase: "part" }));
  });
});
