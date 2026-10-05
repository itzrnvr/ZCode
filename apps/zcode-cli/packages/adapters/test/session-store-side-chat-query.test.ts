import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import type { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import type { ProjectId, SessionId } from "@zcode/contracts";

/**
 * 副屏目录的**存储层**回归（issue #38 的另一半）。
 *
 * `bootstrap/test/session-side-chats.test.ts` 覆盖了 handler，但它的 `sessionStore.listSessions`
 * 是手写的假实现，永远返回喂进去的数组——所以 PR #39 把 `repositories/sessions.ts` 里两处
 * `parent_id` 写成 `parent` + U+1D62 + `d`（下标 i，肉眼与 `_i` 几乎无差）时，那一整套测试全绿，
 * 而生产里 `listSessions({parentID})` 直接 `no such column`，副屏目录死了一整个版本。
 * 这里用**真库真迁移**跑同一条查询：`createSqliteSessionStore` 会执行完整 migration，
 * schema 与线上逐字节一致，没有手搓 CREATE TABLE。
 */

const here = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = resolve(here, "../src/storage/session-store");

const PROJECT = "proj_sidechat" as ProjectId;
const DIRECTORY = "C:/proj";

function sid(value: string): SessionId {
  return value as SessionId;
}

async function withStore(run: (store: SqliteSessionStore) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-sidechat-store-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "db.sqlite") });
  try {
    await run(store);
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

test("listSessions({parentID, taskTypes}) returns the parented side chats, newest first", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_parent", { taskType: "interactive" }) as never);
    await store.createSession(
      sessionInput("sess_child_old", {
        parentID: sid("sess_parent"),
        taskType: "selection_side_chat",
        time: { created: 50, updated: 100 },
      }) as never,
    );
    await store.createSession(
      sessionInput("sess_child_new", {
        parentID: sid("sess_parent"),
        taskType: "selection_side_chat",
        time: { created: 80, updated: 900 },
      }) as never,
    );
    // 噪声：别的父会话的副屏、同父会话的非副屏子会话。两者都不许出现。
    await store.createSession(sessionInput("sess_other", { taskType: "interactive" }) as never);
    await store.createSession(
      sessionInput("sess_foreign_child", {
        parentID: sid("sess_other"),
        taskType: "selection_side_chat",
        time: { created: 10, updated: 9999 },
      }) as never,
    );
    await store.createSession(
      sessionInput("sess_subagent_child", {
        parentID: sid("sess_parent"),
        taskType: "subagent_child",
        time: { created: 10, updated: 8000 },
      }) as never,
    );
    // 归档的副屏：`time_archived is null` 那条 clause 也要真的生效。
    await store.createSession(
      sessionInput("sess_archived_child", {
        parentID: sid("sess_parent"),
        taskType: "selection_side_chat",
        time: { created: 5, updated: 7000 },
      }) as never,
    );
    await store.updateSession({ id: sid("sess_archived_child"), timeArchived: 1234 } as never);

    const rows = await store.listSessions({
      parentID: sid("sess_parent"),
      taskTypes: ["selection_side_chat"],
      limit: 20,
    });

    assert.deepEqual(
      rows.map((row) => String(row.id)),
      ["sess_child_new", "sess_child_old"],
      "only this parent's unarchived selection_side_chat children, newest first",
    );
    assert.equal(rows[0]?.title, "sess_child_new");
    assert.equal(rows[0]?.time?.updated, 900);
  });
});

test("listSessions({roots}) uses parent_id is null and excludes every child", async () => {
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_root_a", { taskType: "interactive" }) as never);
    await store.createSession(sessionInput("sess_root_b", { taskType: "interactive" }) as never);
    await store.createSession(
      sessionInput("sess_child", {
        parentID: sid("sess_root_a"),
        taskType: "selection_side_chat",
      }) as never,
    );

    const roots = await store.listSessions({ roots: true });
    const ids = roots.map((row) => String(row.id)).sort();
    assert.deepEqual(ids, ["sess_root_a", "sess_root_b"]);
    assert.ok(!ids.includes("sess_child"), "a parented session is not a root");
  });
});

test("the side chat directory query is not empty for a parent that owns side chats", async () => {
  // 生产里这条查询抛 `no such column`，handler 侧表现为整个副屏目录恒空。
  await withStore(async (store) => {
    await store.createSession(sessionInput("sess_parent", { taskType: "interactive" }) as never);
    await store.createSession(
      sessionInput("sess_child", {
        parentID: sid("sess_parent"),
        taskType: "selection_side_chat",
      }) as never,
    );
    const rows = await store.listSessions({
      parentID: sid("sess_parent"),
      taskTypes: ["selection_side_chat"],
    });
    assert.equal(rows.length, 1);
  });
});

/**
 * 廉价护栏：下标/上标字母区（U+1D00–U+1D7F、U+2080–U+209C）在这个仓库里**永远**不该出现。
 * 注释是中文（U+4E00 起）、标点是全角（U+3000/U+FF00 段），都不落在这两个区间，所以整目录扫描
 * 零误报；而 `_i` / `_u` / `_t` / `_a` 被写成 U+1D62 / U+1D64 / U+209C / U+2090 恰好就是这次
 * 事故的形状（本行故意只写码位、不写字形：护栏文件自己带着违禁码位就是个坏味道）。
 */
const FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x1d00, 0x1d7f],
  [0x2080, 0x209c],
];


function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("no session-store source carries subscript look-alike codepoints", () => {
  const offenders: string[] = [];
  for (const file of collectSourceFiles(STORE_DIR)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const ch of line) {
        const codePoint = ch.codePointAt(0) ?? 0;
        if (FORBIDDEN_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)) {
          offenders.push(
            `${file}:${index + 1} U+${codePoint.toString(16).toUpperCase()} in ${JSON.stringify(line.trim().slice(0, 80))}`,
          );
          break;
        }
      }
    });
  }
  assert.deepEqual(offenders, [], "SQL identifiers must be plain ASCII");
});
