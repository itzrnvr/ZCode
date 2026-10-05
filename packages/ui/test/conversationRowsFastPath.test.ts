import assert from "node:assert/strict";
import test from "node:test";
import {
  FAST_PATH_MAX_ATTEMPTS,
  FAST_PATH_RETRY_DELAYS_MS,
  FAST_PATH_ROW_LIMIT,
  PREFETCH_CACHE_MAX_ENTRIES,
  PREFETCH_TTL_MS,
  createConversationRowsFastReader,
  createPrefetchCache,
  decideConversationRowsOutcome,
  inspectConversationRows,
} from "../src/v4/conversationRowsFastPath.js";
import type { ConversationRowsFastOutcome } from "../src/v4/conversationRowsFastPath.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "../src/v4/transport.js";

// 被测路径只读 transport.conversationRows 一个成员；ConversationTransport 其余 20+
// 成员在快绘路径上不可达。本仓库的 "no mocks" 口径是手写内存 double（先例：
// packages/rpc/test/messagePortProtocol.test.ts:8-33 的 createFakePort），
// 所以这里给一个只含所需成员的最小实现，再按名字断言成传输面。
interface RecordedCall {
  sessionId: string;
  limit?: number;
  minRevision?: string;
  beforeRowId?: number;
}

function createTransportDouble(outcomes: readonly ConversationRowsFastOutcome[] | null): {
  transport: ConversationTransport;
  calls: RecordedCall[];
  throwOnce: boolean;
} {
  const calls: RecordedCall[] = [];
  const conversationRows =
    outcomes === null
      ? undefined
      : (params: RecordedCall): Promise<ConversationRowsFastOutcome> => {
          calls.push(params);
          if (harness.throwOnce) {
            harness.throwOnce = false;
            return Promise.reject(new Error("boom"));
          }
          const index = Math.min(calls.length - 1, outcomes.length - 1);
          return Promise.resolve(outcomes[index]);
        };
  const double = conversationRows === undefined ? {} : { conversationRows };
  // harness 在自己的闭包里被引用：conversationRows 只可能在 read() 之后被调用，
  // 那时 harness 已赋值完成。
  const harness = {
    transport: double as ConversationTransport,
    calls,
    throwOnce: false,
  };
  return harness;
}

// 行序/唯一性自检只看 rowId，其余字段不参与判定；这里给最小可辨识的行。
function rowAt(rowId: number): ConversationRow {
  return { kind: "turnHeader", rowId, turnId: `turn-${rowId}` } as ConversationRow;
}

function okOutcome(
  rows: readonly ConversationRow[],
  revision = "1:1:1",
): ConversationRowsFastOutcome {
  return { ok: true, revision, rows: [...rows], hasMore: false };
}

function createNoDelay(): { delay: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    delay: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

test("transport 缺席 conversationRows 时降级为 unavailable，且判定为回落而不是重试", async () => {
  const harness = createTransportDouble(null);
  const reader = createConversationRowsFastReader(harness.transport);
  const outcome = await reader.read({ sessionId: "sess_a" });
  assert.deepEqual(outcome, { ok: false, reason: "unavailable" });
  assert.equal(harness.calls.length, 0, "缺席时不应该发出任何调用");
  assert.equal(decideConversationRowsOutcome(outcome, 0), "fallback");
});

test("building 与 stale 按时刻表退避重试，用尽次数后回落，绝不无限重试", async () => {
  for (const reason of ["building", "stale"] as const) {
    const harness = createTransportDouble([
      { ok: false, reason },
      { ok: false, reason },
      { ok: false, reason },
    ]);
    const { delay, waits } = createNoDelay();
    const events: string[] = [];
    const reader = createConversationRowsFastReader(harness.transport, {
      delay,
      onEvent: (event) => events.push(event.kind),
    });
    const outcome = await reader.read({ sessionId: "sess_a" });
    assert.deepEqual(outcome, { ok: false, reason });
    assert.equal(
      harness.calls.length,
      FAST_PATH_MAX_ATTEMPTS,
      `${reason} 应该恰好尝试 ${FAST_PATH_MAX_ATTEMPTS} 次`,
    );
    assert.equal(
      waits.length,
      FAST_PATH_MAX_ATTEMPTS - 1,
      "只在相邻两次尝试之间等待，等待次数 = 重试次数",
    );
    assert.deepEqual(
      waits,
      [...FAST_PATH_RETRY_DELAYS_MS],
      "重试必须按时刻表退避，而不是固定间隔连发",
    );
    assert.deepEqual(
      events,
      [
        "requested",
        ...Array<string>(FAST_PATH_MAX_ATTEMPTS - 1).fill("retried"),
        "fallback",
      ],
      "每次重试各发一个事件，最后一次才回落",
    );
  }
});

test("missing / partial / unsupported / unavailable 一次就回落，不重试", async () => {
  for (const reason of ["missing", "partial", "unsupported", "unavailable"] as const) {
    const harness = createTransportDouble([{ ok: false, reason }]);
    const { delay, waits } = createNoDelay();
    const reader = createConversationRowsFastReader(harness.transport, { delay });
    const outcome = await reader.read({ sessionId: "sess_a" });
    assert.deepEqual(outcome, { ok: false, reason });
    assert.equal(harness.calls.length, 1, `${reason} 不应该重试`);
    assert.equal(waits.length, 0);
    assert.equal(decideConversationRowsOutcome(outcome, 0), "fallback");
  }
});

test("成功结果按原样返回，并带上与权威 snapshot 同宽的 limit", async () => {
  const harness = createTransportDouble([okOutcome([rowAt(1), rowAt(2)], "9:3:1")]);
  const reader = createConversationRowsFastReader(harness.transport, {
    delay: () => Promise.resolve(),
  });
  const outcome = await reader.read({ sessionId: "sess_a" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.revision, "9:3:1");
  assert.equal(outcome.rows.length, 2);
  assert.deepEqual(harness.calls[0], { sessionId: "sess_a", limit: FAST_PATH_ROW_LIMIT });
});

test("minRevision 与 beforeRowId 原样透传，缺省时不出现在参数里", async () => {
  const harness = createTransportDouble([okOutcome([]), okOutcome([])]);
  const reader = createConversationRowsFastReader(harness.transport, {
    delay: () => Promise.resolve(),
  });
  await reader.read({ sessionId: "sess_a", minRevision: "9:3:1", beforeRowId: 42 });
  await reader.read({ sessionId: "sess_a" });
  assert.deepEqual(harness.calls[0], {
    sessionId: "sess_a",
    minRevision: "9:3:1",
    beforeRowId: 42,
    limit: FAST_PATH_ROW_LIMIT,
  });
  assert.deepEqual(harness.calls[1], { sessionId: "sess_a", limit: FAST_PATH_ROW_LIMIT });
});

test("同一 session 的并发读取合流为一次 in-flight", async () => {
  const harness = createTransportDouble([okOutcome([rowAt(1)])]);
  const reader = createConversationRowsFastReader(harness.transport, {
    delay: () => Promise.resolve(),
  });
  const [first, second] = await Promise.all([
    reader.read({ sessionId: "sess_a" }),
    reader.read({ sessionId: "sess_a" }),
  ]);
  assert.equal(harness.calls.length, 1);
  assert.equal(first, second, "合流后应是同一个结果对象");
});

test("不同 session 的并发读取各自成一条 in-flight", async () => {
  const harness = createTransportDouble([okOutcome([])]);
  const reader = createConversationRowsFastReader(harness.transport, {
    delay: () => Promise.resolve(),
  });
  await Promise.all([
    reader.read({ sessionId: "sess_a" }),
    reader.read({ sessionId: "sess_b" }),
  ]);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(
    harness.calls.map((call) => call.sessionId).sort(),
    ["sess_a", "sess_b"],
  );
});

test("重复 rowId 与乱序都按 partial 回落，不把畸形行送进 virtualizer", async () => {
  const duplicated = createTransportDouble([okOutcome([rowAt(1), rowAt(1)])]);
  const duplicatedEvents: string[] = [];
  const duplicatedOutcome = await createConversationRowsFastReader(duplicated.transport, {
    delay: () => Promise.resolve(),
    onEvent: (event) => duplicatedEvents.push(event.kind),
  }).read({ sessionId: "sess_a" });
  assert.deepEqual(duplicatedOutcome, { ok: false, reason: "partial" });
  assert.ok(duplicatedEvents.includes("malformed"));
  assert.equal(duplicated.calls.length, 1, "partial 不重试");

  const unordered = createTransportDouble([okOutcome([rowAt(2), rowAt(1)])]);
  assert.deepEqual(await inspectConversationRows([rowAt(2), rowAt(1)]), { ok: false });
  assert.deepEqual(
    await createConversationRowsFastReader(unordered.transport, {
      delay: () => Promise.resolve(),
    }).read({ sessionId: "sess_a" }),
    { ok: false, reason: "partial" },
  );
  assert.deepEqual(await inspectConversationRows([rowAt(1), rowAt(2)]), { ok: true });
});

test("RPC 抛出被吞成 unavailable，读取面永不 reject", async () => {
  const harness = createTransportDouble([okOutcome([])]);
  harness.throwOnce = true;
  const outcome = await createConversationRowsFastReader(harness.transport, {
    delay: () => Promise.resolve(),
  }).read({ sessionId: "sess_a" });
  assert.deepEqual(outcome, { ok: false, reason: "unavailable" });
});

test("预取缓存：TTL 到期即丢弃，命中刷新 LRU 顺序，超上限淘汰最久未用", () => {
  let current = 1_000;
  const cache = createPrefetchCache(() => current);
  const make = (sessionId: string) => ({
    sessionId,
    revision: `${sessionId}:1:1`,
    rows: [],
    hasMore: false,
    storedAt: current,
  });

  cache.put(make("sess_a"));
  assert.equal(cache.size(), 1);
  assert.equal(cache.peek("sess_a")?.revision, "sess_a:1:1");

  current += PREFETCH_TTL_MS - 1;
  assert.notEqual(cache.peek("sess_a"), null, "TTL 内仍然新鲜");
  current += 1;
  assert.equal(cache.peek("sess_a"), null, "到期即丢弃，不自动刷新");
  assert.equal(cache.size(), 0, "过期条目在读取时就被清掉");

  for (let index = 0; index < PREFETCH_CACHE_MAX_ENTRIES; index++) {
    cache.put(make(`sess_${index}`));
  }
  assert.equal(cache.size(), PREFETCH_CACHE_MAX_ENTRIES);
  // 命中最旧的一条会把它移到最新端，于是下一次溢出淘汰的是 sess_1 而不是 sess_0。
  assert.notEqual(cache.peek("sess_0"), null);
  cache.put(make("sess_overflow"));
  assert.equal(cache.size(), PREFETCH_CACHE_MAX_ENTRIES);
  assert.equal(cache.peek("sess_0")?.sessionId, "sess_0", "被 touch 过的条目不该被淘汰");
  assert.equal(cache.peek("sess_1"), null, "最久未用的那条被淘汰");
});

test("预取缓存：consume 取走即删除，invalidate 支持单条与全清", () => {
  const cache = createPrefetchCache(() => 5_000);
  const make = (sessionId: string) => ({
    sessionId,
    revision: `${sessionId}:1:1`,
    rows: [],
    hasMore: false,
    storedAt: 5_000,
  });
  cache.put(make("sess_a"));
  cache.put(make("sess_b"));
  assert.equal(cache.consume("sess_a")?.sessionId, "sess_a");
  assert.equal(cache.peek("sess_a"), null, "consume 之后不该还能 peek 到");
  assert.equal(cache.consume("sess_a"), null);
  cache.invalidate("sess_b");
  assert.equal(cache.size(), 0);
  cache.put(make("sess_c"));
  cache.invalidate();
  assert.equal(cache.size(), 0, "runtime 换代走无参全清");
});
