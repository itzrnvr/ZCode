import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONV_PROJECTION_SCHEMA_VERSION,
  createSqliteSessionStore,
  type SqliteSessionStore,
} from "@zcode/adapters/storage";
import type { MessageId, PartId, ProjectId, SessionId } from "@zcode/contracts";
import { getConversationRows } from "../src/zcode-protocol/conversation-rows-operation.js";

/**
 * `v4/conversation/rows` handler 的行为回归。
 *
 * 用**真库真迁移**而不是手写假 store：session-store-side-chat-query.test.ts 的注释记着教训 ——
 * 假 store 让 PR #39 的 `parent_id` 下标损坏整整一个版本全绿，而生产里直接 no such column。
 * 这里唯一被替换的是 store 上的一个方法，且替换只是为了**观测落盘信号**与注入并发写入，
 * 底层仍然走真 SQL。
 *
 * 钉住的核心性质是「车道占用」：transport.ts:186-195 把每条非 response 消息串到同一个 FIFO 上，
 * 只有 sessionStop / workspaceCancelGenerateText 旁路。renderer 必须先发本方法再发 subscribe，
 * 所以 handler 只要 await 一次折叠就会把整条车道占住 0.7~2s，把冷视图物化挤到后面 ——
 * 首屏更早出行而权威快照更晚，是伪装成优化的回退。于是断言的是**顺序**（commit 严格晚于
 * handler 返回），而不是耗时阈值：顺序不会抖，阈值会。
 *
 * 等待后台折叠一律 await 真实的落盘信号（nextCommit），不用轮询 + 睡眠：
 * 固定延迟既慢又会把竞态藏到负载下面去。
 */

const PROJECT = "proj_conv_rows" as ProjectId;
const DIRECTORY = "C:/proj";
/** 折叠次数的硬上限：只用于把「信号永不到来」变成一条可读的失败，而不是挂死。 */
const MAX_FOLD_WAITS = 12;

function sid(value: string): SessionId {
  return value as SessionId;
}

function mid(value: string): MessageId {
  return value as MessageId;
}

function pid(value: string): PartId {
  return value as PartId;
}

type CommitResult = { committed: boolean; rewritten: number };

interface Harness {
  store: SqliteSessionStore;
  context: never;
  /** 每次折叠尝试落盘（含被丢弃的那次）时按顺序记 "commit"，用于顺序断言。 */
  commits: string[];
  sessions: Map<string, unknown>;
  gatewayTouches: number;
  /**
   * 在下一次 commit 之前插入一次写入，模拟「折叠进行中有外来进程落了地」。
   * 只触发一次，用完即清 —— 持续干扰会一路撞到 MAX_CONSECUTIVE_DISCARDS。
   */
  interfereNextCommit(write: () => Promise<void>): void;
  /** 绕过观测包装直接落盘，用来注入畸形状态而不污染 commits 信号。 */
  commitDirect(input: Parameters<SqliteSessionStore["commitConversationProjection"]>[0]): Promise<{
    committed: boolean;
    rewritten: number;
  }>;
  /** 等下一次折叠的 commit 结束，拿到它的乐观提交结果。 */
  nextCommit(): Promise<CommitResult>;
  /** 等到有一次折叠**真的落盘**（丢弃的不算），返回该次结果。 */
  waitForLandedFold(): Promise<CommitResult>;
  close(): void;
}

async function makeHarness(sessionId: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "zcode-conv-rows-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "db.sqlite") });
  await store.createSession({
    id: sid(sessionId),
    projectID: PROJECT,
    slug: sessionId,
    directory: DIRECTORY,
    title: sessionId,
    version: "3.14.3",
  } as never);

  const commits: string[] = [];
  const queued: CommitResult[] = [];
  const waiting: Array<(value: CommitResult) => void> = [];
  let interference: (() => Promise<void>) | null = null;
  const originalCommit = store.commitConversationProjection.bind(store);
  store.commitConversationProjection = async (input) => {
    commits.push("commit");
    const pending = interference;
    interference = null;
    if (pending) await pending();
    const result = await originalCommit(input);
    const waiter = waiting.shift();
    if (waiter) waiter(result);
    else queued.push(result);
    return result;
  };

  const sessions = new Map<string, unknown>();
  const context = {
    deps: { sessionStore: store },
    sessions,
    // 快路径绝不许碰 gateway：碰到就计数并抛。走 requireV4Gateway() 就意味着
    // ensureResumed -> app.resume()，那正是本方法要绕开的 4663ms 运行时构造。
    get v4Gateway(): never {
      harness.gatewayTouches += 1;
      throw new Error("conversationRows must never touch the v4 gateway");
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };

  const harness: Harness = {
    store,
    context: context as never,
    commits,
    sessions,
    gatewayTouches: 0,
    interfereNextCommit(write) {
      interference = write;
    },
    commitDirect(input) {
      return originalCommit(input);
    },
    nextCommit() {
      const settled = queued.shift();
      if (settled) return Promise.resolve(settled);
      const { promise, resolve } = Promise.withResolvers<CommitResult>();
      waiting.push(resolve);
      return promise;
    },
    async waitForLandedFold() {
      for (let attempt = 0; attempt < MAX_FOLD_WAITS; attempt += 1) {
        const result = await harness.nextCommit();
        if (result.committed) return result;
      }
      throw new Error("no fold landed within the bounded number of commit signals");
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/**
 * 一轮真实对话。两处细节都是**必须**的，少一个测的就不是线上那条路：
 * 1. `semantics`：transcript-hydration 用它判定 inputSource，只有真实用户轮的那条 TurnStarted
 *    分支会带 `messageId`（:1908），event-normalizer 再据此把 product turn 身份钉到持久
 *    messageId 上（:220-228）。缺了它 turnId 会退回 `hydrate-turn-N` fallback。
 * 2. user 消息也要有 part：`messagesTail` 是**按 part** 取尾的（先 `ORDER BY id DESC LIMIT ?`
 *    取最后 N 个 part，再只加载这些 part 的父消息，messagesTail.ts:20-49）。没有 part 的消息
 *    根本不在返回集里，于是整轮消失。线上 user 消息的正文就是一个 text part，所以这里照做。
 */
async function writeTurn(store: SqliteSessionStore, sessionId: string, n: number) {
  const base = 1_700_000_000_000 + n * 10_000;
  await store.saveMessage({
    id: mid(`msg_u${n}`),
    sessionID: sid(sessionId),
    role: "user",
    time: { created: base },
    semantics: { origin: "real_user", kind: "user_prompt" },
  } as never);
  await store.savePart({
    id: pid(`part_u${n}`),
    sessionID: sid(sessionId),
    messageID: mid(`msg_u${n}`),
    type: "text",
    text: `question ${n}`,
  } as never);
  await store.saveMessage({
    id: mid(`msg_a${n}`),
    sessionID: sid(sessionId),
    role: "assistant",
    time: { created: base + 1_000, completed: base + 6_000 },
    semantics: { origin: "agent_runtime", kind: "assistant_response" },
  } as never);
  await store.savePart({
    id: pid(`part_a${n}`),
    sessionID: sid(sessionId),
    messageID: mid(`msg_a${n}`),
    type: "text",
    text: `answer ${n}`,
  } as never);
}

test("first read returns building immediately and the fold lands afterwards", async () => {
  const harness = await makeHarness("sess_build");
  try {
    await writeTurn(harness.store, "sess_build", 1);

    const first = await getConversationRows(harness.context, { sessionId: "sess_build" });
    harness.commits.push("handler-returned");
    assert.deepEqual(first, { ok: false, reason: "building" });
    // 顺序断言，不是耗时断言：handler 返回时一次 commit 都还没发生，
    // 于是「handler 从不 await 折叠」这条硬约束被钉住（阈值会抖，顺序不会）。
    // 折叠此刻才刚起步——它还要读水位、读 session、读尾读、折三段，才轮到 commit。
    assert.deepEqual(harness.commits, ["handler-returned"]);
    assert.equal(harness.gatewayTouches, 0);
    assert.equal(harness.sessions.size, 0, "快路径绝不创建 runtime record");

    assert.equal((await harness.waitForLandedFold()).committed, true);
    const second = await getConversationRows(harness.context, { sessionId: "sess_build" });
    assert.equal(second.ok, true);
    if (second.ok !== true) return;
    const meta = await harness.store.readConversationProjectionView(sid("sess_build"), { limit: 1 });
    assert.equal(second.revision, meta.meta?.revision);
    assert.equal(second.hasMore, false);
    assert.ok(second.rows.length > 0, "折叠出的行必须真的能读回来");
    const kinds = new Set(second.rows.map((row) => row.kind));
    assert.ok(kinds.has("turnHeader") && kinds.has("userInput") && kinds.has("assistantText"));
    // rowId 升序，与 rowsRange 同一条全序。
    second.rows.forEach((row, index) => {
      if (index === 0) return;
      assert.ok(row.rowId > second.rows[index - 1]!.rowId);
    });
    assert.equal(harness.gatewayTouches, 0);
  } finally {
    harness.close();
  }
});

test("a write between reads makes the next read stale, then fresh after the re-fold", async () => {
  const harness = await makeHarness("sess_stale");
  try {
    await writeTurn(harness.store, "sess_stale", 1);
    assert.equal((await getConversationRows(harness.context, { sessionId: "sess_stale" })).ok, false);
    await harness.waitForLandedFold();
    const before = await harness.store.readConversationProjectionView(sid("sess_stale"), { limit: 1 });

    await writeTurn(harness.store, "sess_stale", 2);
    assert.deepEqual(await getConversationRows(harness.context, { sessionId: "sess_stale" }), {
      ok: false,
      reason: "stale",
    });

    await harness.waitForLandedFold();
    const after = await harness.store.readConversationProjectionView(sid("sess_stale"), { limit: 1 });
    assert.notEqual(after.meta?.revision, before.meta?.revision);
    const fresh = await getConversationRows(harness.context, { sessionId: "sess_stale" });
    assert.equal(fresh.ok, true);
    if (fresh.ok !== true) return;
    assert.equal(fresh.revision, after.meta?.revision);
    assert.deepEqual(
      [...new Set(fresh.rows.map((row) => row.turnId))],
      ["msg_u1", "msg_u2"],
      "重折叠之后第二轮必须在",
    );
  } finally {
    harness.close();
  }
});

test("minRevision is compared verbatim and an unmet one reads as stale", async () => {
  const harness = await makeHarness("sess_minrev");
  try {
    await writeTurn(harness.store, "sess_minrev", 1);
    await getConversationRows(harness.context, { sessionId: "sess_minrev" });
    await harness.waitForLandedFold();
    const view = await harness.store.readConversationProjectionView(sid("sess_minrev"), { limit: 1 });
    const revision = view.meta?.revision;
    assert.ok(revision);

    assert.equal(
      (await getConversationRows(harness.context, { sessionId: "sess_minrev", minRevision: revision }))
        .ok,
      true,
    );
    assert.deepEqual(
      await getConversationRows(harness.context, {
        sessionId: "sess_minrev",
        minRevision: `${revision}:newer`,
      }),
      { ok: false, reason: "stale" },
    );
  } finally {
    harness.close();
  }
});

test("unknown session reads as missing and never activates anything", async () => {
  const harness = await makeHarness("sess_present");
  try {
    assert.deepEqual(await getConversationRows(harness.context, { sessionId: "sess_absent" }), {
      ok: false,
      reason: "missing",
    });
    assert.equal(harness.gatewayTouches, 0);
    assert.equal(harness.sessions.size, 0);
    assert.deepEqual(harness.commits, [], "会话都不存在，不该起任何折叠");
  } finally {
    harness.close();
  }
});

test("a reverted session reads as unsupported and its projection is dropped", async () => {
  const harness = await makeHarness("sess_rev");
  try {
    await writeTurn(harness.store, "sess_rev", 1);
    await getConversationRows(harness.context, { sessionId: "sess_rev" });
    await harness.waitForLandedFold();

    // revert 之后活跃分支不可由有界尾部重建（bridge 因此拒绝 messagesTail，
    // 实测 2703-part 会话被截成 6 条消息 -> 空会话）：delete-on-uncertain。
    await harness.store.setRevert({
      sessionID: sid("sess_rev"),
      revert: { messageID: mid("msg_u1") },
    });
    assert.deepEqual(await getConversationRows(harness.context, { sessionId: "sess_rev" }), {
      ok: false,
      reason: "unsupported",
    });

    // 清空 revert 之后从 building 重新进入，而不是把按已撤销分支折出来的行当最新投影。
    await harness.store.clearRevert(sid("sess_rev"));
    assert.deepEqual(await getConversationRows(harness.context, { sessionId: "sess_rev" }), {
      ok: false,
      reason: "building",
    });
    await harness.waitForLandedFold();
    assert.equal((await getConversationRows(harness.context, { sessionId: "sess_rev" })).ok, true);
    assert.equal(harness.gatewayTouches, 0);
  } finally {
    harness.close();
  }
});

test("a store without the 0024 members reads as unavailable", async () => {
  const harness = await makeHarness("sess_shape");
  try {
    // 端口允许非 Sqlite 的实现；那种实现没有 0024 的成员，必须干净地退回而不是抛。
    const context = {
      deps: { sessionStore: { getSession: async () => null } },
      sessions: new Map(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    assert.deepEqual(await getConversationRows(context as never, { sessionId: "sess_shape" }), {
      ok: false,
      reason: "unavailable",
    });
    // 完全没有 sessionStore 也一样。
    assert.deepEqual(
      await getConversationRows({ deps: {}, sessions: new Map() } as never, {
        sessionId: "sess_shape",
      }),
      { ok: false, reason: "unavailable" },
    );
  } finally {
    harness.close();
  }
});

test("a corrupt stored payload reads as partial and is rebuilt", async () => {
  const harness = await makeHarness("sess_partial");
  try {
    await writeTurn(harness.store, "sess_partial", 1);
    await getConversationRows(harness.context, { sessionId: "sess_partial" });
    await harness.waitForLandedFold();
    const view = await harness.store.readConversationProjectionView(sid("sess_partial"), { limit: 1 });
    const revision = view.meta?.revision;
    assert.ok(revision);

    // 直接用当前水位写一行畸形 payload：fail-closed 的意思是宁可回 partial 也不外发畸形行。
    const seq = await harness.store.readConversationProjectionWatermark(sid("sess_partial"));
    // 用 commitDirect 绕过观测包装：注入畸形状态不该在 commits 里留下一次「折叠落盘」信号，
    // 否则后面的 waitForLandedFold 会把这个假信号当成真的愈合折叠吃掉。
    await harness.commitDirect({
      sessionID: sid("sess_partial"),
      expectedSeq: seq,
      revision,
      schemaVersion: CONV_PROJECTION_SCHEMA_VERSION,
      rows: [{ rowId: 1, turnId: "msg_u1", kind: "userInput", payload: "{not json" }],
    });

    assert.deepEqual(await getConversationRows(harness.context, { sessionId: "sess_partial" }), {
      ok: false,
      reason: "partial",
    });
    // partial 之后必须能自愈：后台重折叠把畸形行换掉。
    await harness.waitForLandedFold();
    assert.equal(
      (await getConversationRows(harness.context, { sessionId: "sess_partial" })).ok,
      true,
    );
  } finally {
    harness.close();
  }
});

test("concurrent reads coalesce: three misses do not produce three folds", async () => {
  const harness = await makeHarness("sess_coalesce");
  try {
    await writeTurn(harness.store, "sess_coalesce", 1);
    const results = await Promise.all([
      getConversationRows(harness.context, { sessionId: "sess_coalesce" }),
      getConversationRows(harness.context, { sessionId: "sess_coalesce" }),
      getConversationRows(harness.context, { sessionId: "sess_coalesce" }),
    ]);
    harness.commits.push("handler-returned");
    for (const result of results) assert.deepEqual(result, { ok: false, reason: "building" });
    // 三次调用全部在第一次落盘之前返回（车道占用为零）。
    assert.equal(harness.commits[0], "handler-returned");

    await harness.waitForLandedFold();
    // 折叠最多跑两趟：单飞合并整个 burst，收尾时若 pending 被置过就再跑一趟。
    // 3 次调用 -> <=2 次折叠，所以客户端的重试排程不会把折叠成本乘上去。
    const folds = harness.commits.filter((entry) => entry === "commit").length;
    assert.ok(folds >= 1 && folds <= 2, `折叠次数应在 1..2，实际 ${folds}`);
  } finally {
    harness.close();
  }
});

test("a foreign write during the fold discards instead of overwriting, then self-reschedules", async () => {
  const harness = await makeHarness("sess_discard");
  try {
    await writeTurn(harness.store, "sess_discard", 1);

    // 模拟跨进程写入：WAL 下多个 Agent 共享同一个库，外来写入推得动水位却到不了本进程的 sink，
    // 所以只能靠 commit 里的 seq 比对兜住。只在第一次落盘前干扰一次。
    harness.interfereNextCommit(async () => {
      await harness.store.savePart({
        id: pid("part_foreign"),
        sessionID: sid("sess_discard"),
        messageID: mid("msg_a1"),
        type: "text",
        text: "foreign write",
      } as never);
    });

    assert.deepEqual(await getConversationRows(harness.context, { sessionId: "sess_discard" }), {
      ok: false,
      reason: "building",
    });
    // 第一次必须被**丢弃**：把按 seq0 折出来的行盖上 seq1 的 revision 就是 false-fresh，
    // 正是 watermark 存在要防的那件事。
    assert.equal((await harness.nextCommit()).committed, false);
    // 丢弃之后必须自己重排：pending 只由本进程的通知置位，这里一次通知都没有。
    // 只靠 pending 就会停在「投影已过期且无人重排」的状态上。
    assert.equal((await harness.waitForLandedFold()).committed, true);

    const session = await harness.store.getSession(sid("sess_discard"));
    const seq = await harness.store.readConversationProjectionWatermark(sid("sess_discard"));
    const view = await harness.store.readConversationProjectionView(sid("sess_discard"), { limit: 1 });
    assert.equal(
      view.meta?.revision,
      `${session!.time.updated}:${seq}:${CONV_PROJECTION_SCHEMA_VERSION}`,
      "落盘的 revision 必须对应真正折出来的那份水位，不能是旧的 expectedSeq",
    );
    assert.equal((await getConversationRows(harness.context, { sessionId: "sess_discard" })).ok, true);
  } finally {
    harness.close();
  }
});

test("the dirty notification warms the projection without any read", async () => {
  const harness = await makeHarness("sess_sink");
  try {
    await writeTurn(harness.store, "sess_sink", 1);
    // 一次读都没发生时 sink 还没被 lazy 安装，所以先用一次读把它装上
    // （server 构造期那行 install 的等价物；eager 路径由 server.ts 负责）。
    assert.deepEqual(await getConversationRows(harness.context, { sessionId: "sess_sink" }), {
      ok: false,
      reason: "building",
    });
    await harness.waitForLandedFold();

    // 抹掉 meta 制造一个「需要预热」的状态，然后**只发通知、不读**。
    await harness.store.deleteConversationProjection(sid("sess_sink"));
    harness.store.notifyConversationProjectionDirty({ sessionID: sid("sess_sink"), phase: "part" });
    await harness.waitForLandedFold();
    assert.equal(
      (await getConversationRows(harness.context, { sessionId: "sess_sink" })).ok,
      true,
      "通知驱动的预热应当让下一次读直接命中",
    );
  } finally {
    harness.close();
  }
});

test("bad params are rejected as invalid params, not as a data-plane reason", async () => {
  const harness = await makeHarness("sess_params");
  try {
    await assert.rejects(
      () => getConversationRows(harness.context, { sessionId: "sess_params", limit: 0 }),
      /Invalid params/,
    );
    await assert.rejects(
      () => getConversationRows(harness.context, { sessionId: "sess_params", limit: 201 }),
      /Invalid params/,
    );
    await assert.rejects(() => getConversationRows(harness.context, {}), /Invalid params/);
  } finally {
    harness.close();
  }
});
