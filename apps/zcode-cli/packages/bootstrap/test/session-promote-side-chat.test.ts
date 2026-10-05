import assert from "node:assert/strict";
import test from "node:test";
import { promoteSessionSideChat } from "../src/zcode-protocol/session-promote-operation.js";
import { ProtocolRequestError } from "../src/zcode-protocol/server-types.js";
import type { PromoteSelectionSideChatResult, SessionInfo } from "@zcode/contracts";

/**
 * `session/promoteSideChat` handler 回归。
 *
 * 存储层由 adapters/test/session-store-promote-side-chat.test.ts 用真库覆盖；这里覆盖的是
 * handler 独有的那半：**存储层翻完之后，活记录也必须翻**。不同步的后果是三处继续把它当副屏：
 *  - v4-bridge.getSessionWorkspaceId 用 isTaskListSessionType(record.taskType) 决定
 *    sessions-index 归属（不翻 ⇒ 提升后的会话进不了索引）；
 *  - commands/executor.ts 的 SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS 用 record.taskType
 *    挡 forkAssistant / retryTurn（不翻 ⇒ 用户提升完还是不能 fork）；
 *  - listSessionSideChats 用 record.taskType + parentSessionId 列副屏目录
 *    （不翻 ⇒ 它同时出现在副屏目录和任务列表里）。
 * 外加 persistence：CAS 命中就证明 session 行存在，deferred 必须落定为 immediate，
 * 否则 v4-bridge.isDraftSession 会把它当草稿，sessions-index 直接跳过。
 */

interface FakeRecord {
  taskType?: string;
  parentSessionId?: string;
  persistence: string;
  stateRevision: number;
  updatedAt: number;
}

interface FakeStore {
  promoteSelectionSideChat?(input: {
    id: string;
    title?: string;
  }): Promise<PromoteSelectionSideChatResult>;
}

function makeContext(options: {
  /** undefined = 默认（有能力的假 store）；null = 宿主没有 store；对象 = 原样使用。 */
  store?: FakeStore | null;
  records?: Record<string, FakeRecord>;
  result?: PromoteSelectionSideChatResult;
}) {
  const calls: { id: string; title?: string }[] = [];
  const session = {
    id: "sess_child",
    taskType: "interactive",
    parentID: null,
    title: "explain the retry logic",
  } as unknown as SessionInfo;
  const result = options.result ?? { promoted: true, session };
  const defaultStore: FakeStore = {
    promoteSelectionSideChat: async (input) => {
      calls.push(input);
      return result;
    },
  };
  const store = options.store === undefined ? defaultStore : options.store;
  return {
    calls,
    context: {
      deps: { ...(store ? { sessionStore: store } : {}) },
      sessions: new Map(Object.entries(options.records ?? {})),
    } as never,
  };
}

function sideChatRecord(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    taskType: "selection_side_chat",
    parentSessionId: "sess_parent",
    persistence: "immediate",
    stateRevision: 7,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("flips the live record alongside the store and bumps the revision once", async () => {
  const record = sideChatRecord({ persistence: "deferred" });
  const { context, calls } = makeContext({ records: { sess_child: record } });

  const result = await promoteSessionSideChat(context, {
    sessionId: "sess_child",
    title: "explain the retry logic",
  });

  assert.deepEqual(calls, [{ id: "sess_child", title: "explain the retry logic" }]);
  assert.equal(result.promoted, true);
  assert.equal(result.sessionId, "sess_child");
  assert.equal(result.title, "explain the retry logic");
  assert.equal(result.taskType, "interactive");

  assert.equal(record.taskType, "interactive");
  assert.equal(
    "parentSessionId" in record,
    false,
    "the parent link must be dropped, not left pointing at the old parent",
  );
  assert.equal(record.persistence, "immediate", "a persisted row can no longer be a draft");
  assert.equal(record.stateRevision, 8, "exactly one revision bump");
  assert.equal(
    record.updatedAt,
    1_700_000_000_000,
    "updatedAt feeds sessions-index lastActivityAt; promoting is not user activity",
  );
});

test("a missed CAS leaves the live record completely alone", async () => {
  const record = sideChatRecord();
  const { context } = makeContext({
    records: { sess_child: record },
    result: { promoted: false, session: null },
  });

  const result = await promoteSessionSideChat(context, { sessionId: "sess_child" });

  assert.equal(result.promoted, false);
  assert.equal(result.title, null);
  assert.equal(result.taskType, null);
  assert.deepEqual(record, sideChatRecord(), "the record must not be touched on a missed CAS");
});

test("omitting the title keeps the stored one (no title key is sent at all)", async () => {
  const { context, calls } = makeContext({ records: { sess_child: sideChatRecord() } });

  await promoteSessionSideChat(context, { sessionId: "sess_child" });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0] && "title" in calls[0],
    false,
    "an undefined title must not be forwarded: the store treats a present title as an overwrite",
  );
});

test("works without a live record (the session is only in the store)", async () => {
  const { context } = makeContext({});
  const result = await promoteSessionSideChat(context, { sessionId: "sess_child" });
  assert.equal(result.promoted, true);
  assert.equal(result.taskType, "interactive");
});

test("a host without the store capability gets a structured -32003, not a crash", async () => {
  // 没有 store。
  const { context: noStore } = makeContext({ store: null });
  await assert.rejects(
    promoteSessionSideChat(noStore, { sessionId: "sess_child" }),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolRequestError);
      assert.equal(error.code, -32003);
      return true;
    },
  );

  // 存储面在场但没有这个方法（旧宿主）：同一条结构化错误，绝不能 TypeError。
  const { context: legacy } = makeContext({ store: {} });
  await assert.rejects(
    promoteSessionSideChat(legacy, { sessionId: "sess_child" }),
    (error: unknown) => error instanceof ProtocolRequestError && error.code === -32003,
  );
});

test("params are validated by the shared schema", async () => {
  const { context } = makeContext({ records: { sess_child: sideChatRecord() } });
  await assert.rejects(promoteSessionSideChat(context, {}));
  await assert.rejects(promoteSessionSideChat(context, { sessionId: "" }));
  // .strict()：未知字段必须被拒，否则调用方拼错字段名会静默变成 "不改标题"。
  await assert.rejects(promoteSessionSideChat(context, { sessionId: "sess_child", titel: "x" }));
});
