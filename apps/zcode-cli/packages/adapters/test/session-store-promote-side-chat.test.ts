import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import type { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import type { ProjectId, SessionId } from "@zcode/contracts";

/**
 * 「把框选副屏提升为正式会话」的**存储层**回归。
 *
 * 与 session-store-side-chat-query.test.ts 同一个理由：handler 层的测试用手写假 store，
 * 永远返回喂进去的数组，所以 PR #39 把 `parent_id` 写成下标 i 时那一整套测试全绿。
 * 这里用 `createSqliteSessionStore` 跑完整 migration，并且在断言时**用裸 DatabaseSync
 * 重新打开同一个文件**读原始列——确保断的是真正落盘的 SQL 结果，而不是 store 的解码。
 *
 * 三条不变量是本用例存在的理由：
 *  1. CAS：`where task_type = 'selection_side_chat'` 使提升幂等，重复调用返回 promoted:false；
 *  2. `parent_id` 必须清空，否则它仍会被 listSessions({parentID}) 当成副屏列出来；
 *  3. **`time_updated` 必须不变**：conversation projection 的 revision 是
 *     `time_updated:watermark:schemaVersion`，提升不碰任何 message/part，动它就会让下一次
 *     v4/conversation/rows 快路径白返回一次 stale 并触发一次整会话重折叠。
 */

const PROJECT = "proj_promote" as ProjectId;
const DIRECTORY = "C:/proj";
const SIDE_CHAT_TITLE = "Selection side chat";

function sid(value: string): SessionId {
  return value as SessionId;
}

async function withStore(run: (store: SqliteSessionStore, dbPath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-promote-store-"));
  const dbPath = join(dir, "db.sqlite");
  const store = createSqliteSessionStore({ dbPath });
  try {
    await run(store, dbPath);
  } finally {
    store.close();
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
    version: "3.14.0",
    ...overrides,
  };
}

/** 绕过 store 直接读原始列：断的是落盘事实，不是解码路径。 */
function readRawSession(dbPath: string, id: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("select id, task_type, parent_id, title, time_updated from session where id = ?")
      .get(id) as
      | {
          id: string;
          task_type: string;
          parent_id: string | null;
          title: string;
          time_updated: number;
        }
      | undefined;
  } finally {
    db.close();
  }
}

async function seedSideChat(store: SqliteSessionStore, childId = "sess_child") {
  await store.createSession(
    sessionInput("sess_parent", { taskType: "interactive", title: "parent" }) as never,
  );
  await store.createSession(
    sessionInput(childId, {
      taskType: "selection_side_chat",
      parentID: sid("sess_parent"),
      title: SIDE_CHAT_TITLE,
    }) as never,
  );
}

test("promote flips task_type, clears parent_id and keeps time_updated untouched", async () => {
  await withStore(async (store, dbPath) => {
    await seedSideChat(store);
    const before = readRawSession(dbPath, "sess_child");
    assert.equal(before?.task_type, "selection_side_chat");
    assert.equal(before?.parent_id, "sess_parent");

    const result = await store.promoteSelectionSideChat({ id: sid("sess_child") });
    assert.equal(result.promoted, true);
    assert.equal(result.session?.taskType, "interactive");
    assert.ok(result.session);

    const after = readRawSession(dbPath, "sess_child");
    assert.equal(after?.task_type, "interactive");
    assert.equal(after?.parent_id, null, "parent_id must be cleared, not left pointing at the parent");
    assert.equal(after?.title, SIDE_CHAT_TITLE, "without a title argument the title is preserved");
    assert.equal(
      after?.time_updated,
      before?.time_updated,
      "time_updated must not move: the projection revision embeds it",
    );
    // 父会话不受影响。
    assert.equal(readRawSession(dbPath, "sess_parent")?.task_type, "interactive");
  });
});

test("promote writes the supplied title in the same statement", async () => {
  await withStore(async (store, dbPath) => {
    await seedSideChat(store);
    const result = await store.promoteSelectionSideChat({
      id: sid("sess_child"),
      title: "explain the retry logic",
    });
    assert.equal(result.promoted, true);
    assert.equal(result.session?.title, "explain the retry logic");
    const after = readRawSession(dbPath, "sess_child");
    assert.equal(after?.title, "explain the retry logic");
    assert.equal(after?.task_type, "interactive");
  });
});

test("promote is idempotent: a second call misses the CAS and changes nothing", async () => {
  await withStore(async (store, dbPath) => {
    await seedSideChat(store);
    const first = await store.promoteSelectionSideChat({
      id: sid("sess_child"),
      title: "promoted title",
    });
    assert.equal(first.promoted, true);
    const afterFirst = readRawSession(dbPath, "sess_child");

    // 重复点击 / 并发点击落在这里：不是错误，但绝不能把标题再改一次。
    const second = await store.promoteSelectionSideChat({
      id: sid("sess_child"),
      title: "second title",
    });
    assert.equal(second.promoted, false);
    assert.equal(second.session?.taskType, "interactive");
    const afterSecond = readRawSession(dbPath, "sess_child");
    assert.deepEqual(afterSecond, afterFirst, "a missed CAS must be a no-op");
  });
});

test("promoting a non-side-chat session is a no-op", async () => {
  await withStore(async (store, dbPath) => {
    await store.createSession(
      sessionInput("sess_regular", {
        taskType: "interactive",
        parentID: sid("sess_origin"),
        title: "regular",
      }) as never,
    );
    const before = readRawSession(dbPath, "sess_regular");
    const result = await store.promoteSelectionSideChat({
      id: sid("sess_regular"),
      title: "should not stick",
    });
    assert.equal(result.promoted, false);
    assert.deepEqual(readRawSession(dbPath, "sess_regular"), before);
  });
});

test("promoting an unknown session reports null instead of inventing a row", async () => {
  await withStore(async (store) => {
    const result = await store.promoteSelectionSideChat({ id: sid("sess_ghost") });
    assert.equal(result.promoted, false);
    assert.equal(result.session, null);
  });
});

test("a promoted side chat leaves the parent side-chat directory", async () => {
  await withStore(async (store) => {
    await seedSideChat(store, "sess_child_a");
    await seedSideChat(store, "sess_child_b");
    // 第二个 seed 会重复创建 sess_parent；createSession 的 ON CONFLICT 让它保持原样。
    const before = await store.listSessions({
      parentID: sid("sess_parent"),
      taskTypes: ["selection_side_chat"],
    });
    assert.deepEqual(
      before.map((session) => String(session.id)).sort(),
      ["sess_child_a", "sess_child_b"],
    );

    await store.promoteSelectionSideChat({ id: sid("sess_child_a") });

    const after = await store.listSessions({
      parentID: sid("sess_parent"),
      taskTypes: ["selection_side_chat"],
    });
    assert.deepEqual(
      after.map((session) => String(session.id)),
      ["sess_child_b"],
      "the promoted session must stop appearing in the side-chat directory",
    );
    const roots = await store.listSessions({ roots: true, taskTypes: ["interactive"] });
    assert.ok(
      roots.some((session) => String(session.id) === "sess_child_a"),
      "and start appearing as a root task",
    );
  });
});
