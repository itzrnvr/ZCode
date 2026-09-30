import assert from "node:assert/strict";
import test from "node:test";
import { listSessionSideChats } from "../src/zcode-protocol/server-operations.js";
import type { SessionInfo, SessionTaskType } from "@zcode/contracts";

/**
 * 副屏目录查询（issue #38）。
 *
 * 左侧任务列表按 `TASK_LIST_SESSION_TYPES` 排除 `selection_side_chat`，副屏自己的目录投影
 * 此前没实现，于是这些会话在 UI 里没有任何入口。实测后果：DB 里 7 个副屏会话，
 * tasks-index 0 个，`listSessions` 也因 taskTypes 过滤全部不可见——包括重启后"副屏不见了"：
 * 数据一直在，只是没人列得出。
 */

type StoredSession = {
  id: string;
  title?: string;
  taskType?: SessionTaskType;
  parentID?: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
};

function toSessionInfo(entry: StoredSession): SessionInfo {
  return {
    id: entry.id as SessionInfo["id"],
    taskType: entry.taskType ?? "interactive",
    parentID: entry.parentID as SessionInfo["parentID"],
    directory: "C:/proj",
    path: "C:/proj",
    title: entry.title ?? "t",
    time: {
      created: entry.createdAt ?? 0,
      updated: entry.updatedAt ?? 0,
      ...(entry.archived === undefined ? {} : { archived: entry.archived }),
    },
  } as unknown as SessionInfo;
}

function makeContext(stored: StoredSession[], live: Record<string, unknown>[] = []) {
  const listCalls: unknown[] = [];
  return {
    listCalls,
    context: {
      deps: {
        sessionStore: {
          listSessions: async (input: unknown) => {
            listCalls.push(input);
            return stored.map(toSessionInfo);
          },
        },
      },
      sessions: new Map(live.map((record) => [record.id as string, record])),
    } as never,
  };
}

test("lists persisted side chats newest-first with the parent filter applied", async () => {
  const { context, listCalls } = makeContext([
    { id: "sess-a", parentID: "sess-parent", taskType: "selection_side_chat", updatedAt: 100 },
    { id: "sess-b", parentID: "sess-parent", taskType: "selection_side_chat", updatedAt: 900 },
    { id: "sess-c", parentID: "sess-parent", taskType: "selection_side_chat", updatedAt: 500 },
  ]);
  const result = await listSessionSideChats(context, { sessionId: "sess-parent" });
  assert.deepEqual(
    result.sideChats.map((entry) => entry.sessionId),
    ["sess-b", "sess-c", "sess-a"],
  );
  assert.equal(listCalls.length, 1);
  assert.deepEqual(listCalls[0], {
    parentID: "sess-parent",
    taskTypes: ["selection_side_chat"],
    limit: 20,
  });
});

test("live side chats appear even before they are persisted, and are flagged active", async () => {
  const { context } = makeContext([{ id: "sess-old", parentID: "sess-parent", taskType: "selection_side_chat", updatedAt: 100 }], [
    {
      id: "sess-live",
      persistence: "normal",
      taskType: "selection_side_chat",
      parentSessionId: "sess-parent",
    },
  ]);
  const result = await listSessionSideChats(context, { sessionId: "sess-parent" });
  const live = result.sideChats.find((entry) => entry.sessionId === "sess-live");
  assert.ok(live, "a live side chat must be listed before it hits the store");
  assert.equal(live.isActive, true);
  assert.equal(result.sideChats.find((entry) => entry.sessionId === "sess-old")?.isActive, false);
});

test("a persisted side chat is active when it also has a live runtime record", async () => {
  const { context } = makeContext(
    [{ id: "sess-both", parentID: "sess-parent", taskType: "selection_side_chat", title: "Titled", updatedAt: 10 }],
    [{ id: "sess-both", persistence: "normal", taskType: "selection_side_chat", parentSessionId: "sess-parent" }],
  );
  const result = await listSessionSideChats(context, { sessionId: "sess-parent" });
  assert.equal(result.sideChats.length, 1, "live and persisted views must merge, not duplicate");
  assert.equal(result.sideChats[0]?.isActive, true);
  assert.equal(result.sideChats[0]?.title, "Titled", "persisted title wins over the fallback");
});

test("deferred records are not treated as active", async () => {
  const { context } = makeContext([], [
    {
      id: "sess-deferred",
      persistence: "deferred",
      taskType: "selection_side_chat",
      parentSessionId: "sess-parent",
    },
  ]);
  const result = await listSessionSideChats(context, { sessionId: "sess-parent" });
  assert.deepEqual(result.sideChats, []);
});

test("live side chats belonging to another parent are not leaked", async () => {
  const { context } = makeContext([], [
    { id: "sess-foreign", persistence: "normal", taskType: "selection_side_chat", parentSessionId: "sess-other" },
    { id: "sess-untasked", persistence: "normal", taskType: "interactive", parentSessionId: "sess-parent" },
  ]);
  const result = await listSessionSideChats(context, { sessionId: "sess-parent" });
  assert.deepEqual(result.sideChats, []);
});

test("missing store degrades to live records instead of throwing", async () => {
  const context = {
    deps: {},
    sessions: new Map([
      [
        "sess-live",
        { id: "sess-live", persistence: "normal", taskType: "selection_side_chat", parentSessionId: "sess-parent" },
      ],
    ]),
  } as never;
  const result = await listSessionSideChats(context, { sessionId: "sess-parent" });
  assert.deepEqual(
    result.sideChats.map((entry) => entry.sessionId),
    ["sess-live"],
  );
});

test("limit is honoured and passed through", async () => {
  const { context, listCalls } = makeContext([
    { id: "sess-1", parentID: "sess-parent", taskType: "selection_side_chat", updatedAt: 3 },
    { id: "sess-2", parentID: "sess-parent", taskType: "selection_side_chat", updatedAt: 2 },
    { id: "sess-3", parentID: "sess-parent", taskType: "selection_side_chat", updatedAt: 1 },
  ]);
  const result = await listSessionSideChats(context, { sessionId: "sess-parent", limit: 2 });
  assert.equal(result.sideChats.length, 2);
  assert.deepEqual(listCalls[0], {
    parentID: "sess-parent",
    taskTypes: ["selection_side_chat"],
    limit: 2,
  });
});
