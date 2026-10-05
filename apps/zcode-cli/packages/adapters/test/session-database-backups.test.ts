import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSnapshot,
  listSnapshots,
  readSourceSignature,
  restoreSnapshot,
  runVacuumIntoWorker,
  RECOVERY_NOTE_FILE,
} from "../src/storage/session-store/database-backups.js";
import type {
  CreateSnapshotOptions,
  SnapshotResult,
  VacuumIntoRunner,
} from "../src/storage/session-store/database-backups.js";
import type { LogContext, Logger } from "@zcode/contracts";

/**
 * 会话库世代备份的真实 sqlite 回归。
 *
 * 全部用真库、真 `VACUUM INTO`、真 worker 线程，没有假文件系统：这套代码保护的是用户
 * 2.07 GB 的会话库，任何 "看起来对" 的替身都会把恢复路径的失败留到用户真出事那天。
 * 只有在需要注入**失败**（低空间、vacuum 抛错、并发闸门）时才替换 `runVacuumInto`；
 * primitive 本身由 happy-path 用例证明，替换点之外走的仍是同一条代码。
 *
 * round-trip 用例为什么还要跑一遍 "不删伴生文件" 的对照组：删 `-wal`/`-shm` 这两行是
 * **载荷性**的。实测（1000 行库）：把快照盖回损坏库但留着旧 -wal，行数被回放的 DELETE
 * 清成 0；先删伴生文件再恢复则是 1000 行。只断言 "恢复后行还在" 的话，哪天有人把那两行
 * rm 删掉，用例仍然会绿——对照组让那个改动必然变红。
 */

const SESSION_COUNT = 6;
const PARTS_PER_SESSION = 250;
const SIDE_CHAT_SESSIONS = 2;
const CANARY_PART_ID = "part_5_249";
const CANARY_PAYLOAD = `payload-${CANARY_PART_ID}-${"Z".repeat(64)}`;
const MISSING = { sessions: -1, parts: -1, sideChats: -1 };

interface Fixture {
  dir: string;
  dbPath: string;
  backupsDir: string;
}

function makeFixture(prefix = "zcode-db-backups-"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, "db.sqlite"), backupsDir: join(dir, "backups") };
}

function dropFixture(fixture: Fixture): void {
  rmSync(fixture.dir, { recursive: true, force: true });
}

/** 真 WAL 库：6 个会话（其中 2 个是框选副屏）× 250 个 part，含一个逐字节校验用的 canary。 */
function seedDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
      "create table session (id text primary key, task_type text not null default 'interactive'," +
        " parent_id text, title text, time_updated integer)",
    );
    db.exec("create table part (id text primary key, session_id text not null, data text)");
    // 1506 条插入必须放进一个事务：WAL 下自动提交的每条语句各付一次 fsync，
    // 实测整套用例因此从 ~4 s 涨到 45 s（每个用例固定 ~2.9 s，与 worker 无关）。
    db.exec("begin");
    const insertSession = db.prepare(
      "insert into session (id, task_type, parent_id, title, time_updated) values (?, ?, ?, ?, ?)",
    );
    const insertPart = db.prepare("insert into part (id, session_id, data) values (?, ?, ?)");
    for (let s = 0; s < SESSION_COUNT; s++) {
      const sessionId = `sess_${s}`;
      const isSideChat = s >= SESSION_COUNT - SIDE_CHAT_SESSIONS;
      insertSession.run(
        sessionId,
        isSideChat ? "selection_side_chat" : "interactive",
        isSideChat ? "sess_0" : null,
        `session ${s}`,
        1_700_000_000_000 + s,
      );
      for (let p = 0; p < PARTS_PER_SESSION; p++) {
        const partId = `part_${s}_${p}`;
        insertPart.run(
          partId,
          sessionId,
          partId === CANARY_PART_ID ? CANARY_PAYLOAD : `payload-${partId}`,
        );
      }
    }
    db.exec("commit");
  } finally {
    db.close();
  }
}

function withReadOnlyDb<T>(dbPath: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function scalar(dbPath: string, sql: string): unknown {
  return withReadOnlyDb(dbPath, (db) => {
    const row = db.prepare(sql).get();
    return row ? row[Object.keys(row)[0] ?? ""] : undefined;
  });
}

function cellOf(dbPath: string, sql: string): unknown {
  return withReadOnlyDb(dbPath, (db) => {
    const rows = db.prepare(sql).all();
    const first = rows[0];
    return first ? first[Object.keys(first)[0] ?? ""] : undefined;
  });
}

function counts(dbPath: string): { sessions: number; parts: number; sideChats: number } {
  return withReadOnlyDb(dbPath, (db) => ({
    sessions: Number(db.prepare("select count(*) as n from session").get()?.n ?? -1),
    parts: Number(db.prepare("select count(*) as n from part").get()?.n ?? -1),
    sideChats: Number(
      db.prepare("select count(*) as n from session where task_type = 'selection_side_chat'").get()
        ?.n ?? -1,
    ),
  }));
}

/** 读不出来也是一种 "损坏已生效"，用例需要的是 "不再等于原样"，不是某一种具体损坏。 */
function countsOrMissing(dbPath: string): { sessions: number; parts: number; sideChats: number } {
  try {
    return counts(dbPath);
  } catch {
    return MISSING;
  }
}

/** 把 0x5a 写进主库中段（保住文件头，这样 sqlite 还认得它是库，但页内容已经烂了）。 */
function scribble(file: string, offset: number, bytes: number): void {
  const fd = openSync(file, "r+");
  try {
    writeSync(fd, Buffer.alloc(bytes, 0x5a), 0, bytes, offset);
  } finally {
    closeSync(fd);
  }
}

/**
 * 造出 "损坏库 + 会回放出 DELETE 的陈旧 -wal" 这个线上真实会遇到的状态。
 *
 * 顺序有讲究：先在第二个连接里提交 DELETE（帧进 -wal），**趁连接还开着**把 -wal 复制走
 * （最后一个连接关闭时 sqlite 会 checkpoint 并删掉它），然后 scribble 主库，最后把那份
 * -wal 放回去。之所以用复制而不是让连接一直开着：Windows 上库文件被占用时
 * restoreSnapshot 的 rename 会失败，而恢复本来也要求先退出应用。
 */
function damageDatabase(dbPath: string, staleWalPath: string): void {
  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("delete from part");
    writer.exec("delete from session where task_type = 'selection_side_chat'");
    copyFileSync(`${dbPath}-wal`, staleWalPath);
  } finally {
    writer.close();
  }
  scribble(dbPath, 4_096 * 8, 65_536);
  writeFileSync(`${dbPath}-wal`, readFileSync(staleWalPath));
}

function writeRow(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

interface RecordedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context: Record<string, unknown>;
}

/** 日志记录器：只是观察者，不参与被测行为（bootstrap 的 handler 测试同样用假依赖）。 */
function makeLogger(): { logger: Logger; entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const logger: Logger = {
    debug(message: string, context?: LogContext): void {
      entries.push({ level: "debug", message, context: context ?? {} });
    },
    info(message: string, context?: LogContext): void {
      entries.push({ level: "info", message, context: context ?? {} });
    },
    warn(message: string, context?: LogContext): void {
      entries.push({ level: "warn", message, context: context ?? {} });
    },
    error(message: string, error?: Error, context?: LogContext): void {
      entries.push({ level: "error", message, context: { ...context, error: error?.message } });
    },
    child(): Logger {
      // 备份模块自己不调 child（那是 bootstrap 包装层做的），但 Logger 契约要求它在。
      return logger;
    },
  };
  return { logger, entries };
}

function eventsOf(entries: RecordedLog[], event: string): RecordedLog[] {
  return entries.filter((entry) => entry.context.event === event);
}

/** 注入时钟：每一轮推进 1 s，保证 UTC 时戳文件名互不相同。 */
function makeClock(startMs = 1_800_000_000_000): { now: () => number; advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number): void {
      current += ms;
    },
  };
}

async function snapshotRounds(
  fixture: Fixture,
  rounds: number,
  extra: Partial<CreateSnapshotOptions> = {},
): Promise<SnapshotResult[]> {
  const clock = makeClock();
  const results: SnapshotResult[] = [];
  for (let round = 0; round < rounds; round++) {
    clock.advance(1_000);
    // 每一轮都改一次内容，否则签名相同会被 "unchanged" 跳过（那是另一个用例）。
    writeRow(fixture.dbPath, `update session set title = 'round ${round}' where id = 'sess_0'`);
    results.push(
      await createSnapshot({
        dbPath: fixture.dbPath,
        backupsDir: fixture.backupsDir,
        now: clock.now,
        ...extra,
      }),
    );
  }
  return results;
}

function createdFileOf(result: SnapshotResult): string {
  assert.equal(result.status, "created", JSON.stringify(result));
  return result.status === "created" ? result.file : "";
}

test("snapshot -> corrupt -> restore round-trip recovers every row", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);
  const before = counts(fixture.dbPath);
  assert.deepEqual(before, {
    sessions: SESSION_COUNT,
    parts: SESSION_COUNT * PARTS_PER_SESSION,
    sideChats: SIDE_CHAT_SESSIONS,
  });

  // 真 worker + 真 VACUUM INTO：这一份就是用户真出事时要靠的那一份。
  const created = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
  });
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  assert.ok(created.bytes > 0);
  assert.equal(scalar(created.path, "PRAGMA integrity_check"), "ok");

  const staleWalPath = join(fixture.dir, "stale-wal");
  damageDatabase(fixture.dbPath, staleWalPath);
  const damaged = countsOrMissing(fixture.dbPath);
  assert.notDeepEqual(damaged, before, `fixture was not damaged: ${JSON.stringify(damaged)}`);
  const damagedDb = readFileSync(fixture.dbPath);
  assert.ok(existsSync(staleWalPath), "the stale -wal fixture must exist for the control step");

  // 对照组：把快照盖回损坏库，但**留着**陈旧 -wal。旧 WAL 里的 DELETE 帧会被回放，
  // 恢复出来的库再次被清空——这正是 restoreSnapshot 里那两行 rm 挡住的事故。
  writeFileSync(fixture.dbPath, readFileSync(created.path));
  writeFileSync(`${fixture.dbPath}-wal`, readFileSync(staleWalPath));
  const control = countsOrMissing(fixture.dbPath);
  assert.ok(
    control.parts < before.parts,
    `control expected the stale -wal to damage the restored rows, got ${JSON.stringify(control)}`,
  );

  // 恢复损坏现场，然后走真正的 restoreSnapshot。
  writeFileSync(fixture.dbPath, damagedDb);
  writeFileSync(`${fixture.dbPath}-wal`, readFileSync(staleWalPath));
  const restored = await restoreSnapshot(created.path, fixture.dbPath);
  assert.equal(restored.restored, fixture.dbPath);
  assert.ok(restored.preserved, "the damaged database must be preserved, never blind-deleted");
  assert.ok(existsSync(restored.preserved ?? ""));

  // 伴生文件必须在恢复完成的那一刻就不存在：留着就是上面对照组那个事故。
  // 断言放在任何读操作之前——只读打开一个 WAL 库本身就会重新生成 -wal/-shm。
  assert.equal(existsSync(`${fixture.dbPath}-wal`), false);
  assert.equal(existsSync(`${fixture.dbPath}-shm`), false);

  assert.deepEqual(counts(fixture.dbPath), before);
  assert.equal(scalar(fixture.dbPath, "PRAGMA integrity_check"), "ok");
  // VACUUM INTO 的产物是 rollback-journal 库（实测 journal=delete），migration-runner 期望 WAL。
  assert.equal(scalar(fixture.dbPath, "PRAGMA journal_mode"), "wal");
  assert.equal(
    cellOf(fixture.dbPath, `select data from part where id = '${CANARY_PART_ID}'`),
    CANARY_PAYLOAD,
    "the canary payload must survive byte-identically",
  );
});

test("snapshot is a single self-contained file with no WAL sidecars", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const created = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
  });
  const file = createdFileOf(created);

  assert.deepEqual(readdirSync(fixture.backupsDir).sort(), [
    RECOVERY_NOTE_FILE,
    "backups.json",
    file,
  ].sort());
  assert.equal(
    readdirSync(fixture.backupsDir).some((name) => name.endsWith("-wal") || name.endsWith("-shm")),
    false,
    "VACUUM INTO output must not need sidecars",
  );
  const info = (await listSnapshots(fixture.backupsDir))[0];
  assert.equal(info?.file, file);
  assert.equal(info?.bytes, statSync(join(fixture.backupsDir, file)).size);
});

test("generations are capped and the oldest snapshot is pruned", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const results = await snapshotRounds(fixture, 5, { generations: 3 });
  const files = results.map(createdFileOf);
  assert.equal(new Set(files).size, 5, "each round must produce a distinct generation");

  const onDisk = await listSnapshots(fixture.backupsDir);
  assert.deepEqual(
    onDisk.map((info) => info.file),
    files.slice(2),
  );
  for (const pruned of files.slice(0, 2)) {
    assert.equal(existsSync(join(fixture.backupsDir, pruned)), false, `${pruned} should be gone`);
  }
  const manifest = JSON.parse(readFileSync(join(fixture.backupsDir, "backups.json"), "utf8")) as {
    snapshots: { file: string }[];
  };
  assert.deepEqual(
    manifest.snapshots.map((entry) => entry.file),
    files.slice(2),
    "the manifest must not keep entries for pruned generations",
  );
});

test("an unchanged source is skipped instead of rewriting gigabytes", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const results = await snapshotRounds(fixture, 1);
  const first = createdFileOf(results[0] as SnapshotResult);
  const second = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
  });
  assert.equal(second.status, "skipped");
  if (second.status !== "skipped") return;
  assert.equal(second.reason, "unchanged");
  assert.equal(second.file, first);
  assert.equal((await listSnapshots(fixture.backupsDir)).length, 1);
});

test("an in-place update with no row-count change is still detected as changed", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const first = await createSnapshot({ dbPath: fixture.dbPath, backupsDir: fixture.backupsDir });
  assert.equal(first.status, "created");

  // 行数、id、时间戳全都不变，只有页内容变：这是 data_version / max(id) 类签名的盲点。
  writeRow(fixture.dbPath, `update part set data = 'rewritten' where id = '${CANARY_PART_ID}'`);

  const second = await createSnapshot({ dbPath: fixture.dbPath, backupsDir: fixture.backupsDir });
  assert.equal(second.status, "created", JSON.stringify(second));
  if (second.status !== "created") return;
  assert.equal(
    cellOf(second.path, `select data from part where id = '${CANARY_PART_ID}'`),
    "rewritten",
  );
});

test("the cadence guard refuses a second generation while the newest is still fresh", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const clock = makeClock();
  const first = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
    now: clock.now,
  });
  assert.equal(first.status, "created");

  writeRow(fixture.dbPath, "update session set title = 'moved' where id = 'sess_0'");
  clock.advance(60_000);
  // 内容变了，但周期轮次的节奏闸门（30 min）优先：不能把第二份 2 GB 叠在刚写完的那份上。
  const guarded = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
    minAgeMs: 30 * 60_000,
    now: clock.now,
  });
  assert.equal(guarded.status, "skipped");
  if (guarded.status !== "skipped") return;
  assert.equal(guarded.reason, "recent");
  assert.equal(guarded.ageMs, 60_000);
  assert.equal((await listSnapshots(fixture.backupsDir)).length, 1);

  // 启动那一次传 minAgeMs=0，所以内容一变就一定会跑。
  const startup = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
    minAgeMs: 0,
    now: clock.now,
  });
  assert.equal(startup.status, "created");
  assert.equal((await listSnapshots(fixture.backupsDir)).length, 2);
});

test("a concurrent caller gets in_flight instead of a second snapshot", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blockingRunner: VacuumIntoRunner = async (dbPath, targetPath) => {
    await gate;
    await runVacuumIntoWorker(dbPath, targetPath);
  };

  const first = createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
    runVacuumInto: blockingRunner,
  });
  const second = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
    runVacuumInto: blockingRunner,
  });
  assert.equal(second.status, "skipped");
  if (second.status === "skipped") assert.equal(second.reason, "in_flight");

  release?.();
  assert.equal((await first).status, "created");
  assert.equal((await listSnapshots(fixture.backupsDir)).length, 1);
});

test("a foreign fresh lock blocks the round and a stale lock is stolen", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);
  mkdirSync(fixture.backupsDir, { recursive: true });
  const lockPath = join(fixture.backupsDir, ".snapshot.lock");

  writeFileSync(lockPath, JSON.stringify({ pid: 999_999, startedAt: Date.now() }));
  const blocked = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
  });
  assert.equal(blocked.status, "skipped");
  if (blocked.status === "skipped") assert.equal(blocked.reason, "in_flight");
  assert.equal((await listSnapshots(fixture.backupsDir)).length, 0);

  // 被强杀的进程跑不到 finally：超过陈旧阈值的锁必须能被接管，否则备份永久停摆。
  writeFileSync(lockPath, JSON.stringify({ pid: 999_999, startedAt: Date.now() - 20 * 60_000 }));
  const stolen = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
  });
  assert.equal(stolen.status, "created");
  assert.equal(existsSync(lockPath), false, "the lock must be released after the round");
});

test("low free space frees the oldest generation, retries once and warns instead of throwing", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const seeded = await snapshotRounds(fixture, 2);
  assert.deepEqual(
    seeded.map((result) => result.status),
    ["created", "created"],
  );
  const oldest = (await listSnapshots(fixture.backupsDir))[0];
  assert.ok(oldest);

  // 签名必须真的变了，否则这一轮会先被 "unchanged" 跳过，永远走不到空间闸门。
  writeRow(fixture.dbPath, "update session set title = 'space pressure' where id = 'sess_0'");
  const { logger, entries } = makeLogger();
  // safetyFactor 拉到不可能满足 ⇒ 空间预闸门抛 LowSpaceError；runner 永远失败 ⇒ 重试也失败。
  const result = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
    safetyFactor: Number.MAX_SAFE_INTEGER,
    logger,
    runVacuumInto: async () => {
      throw new Error("simulated ENOSPC from VACUUM INTO");
    },
  });
  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") return;
  assert.equal(result.reason, "low_space");
  assert.equal(result.freedOldest, oldest.file, "the oldest generation must be freed for the retry");
  assert.equal(existsSync(oldest.path), false);
  assert.equal((await listSnapshots(fixture.backupsDir)).length, 1);
  const warnings = eventsOf(entries, "session_store.backup.failed");
  assert.equal(warnings.length, 1, "exactly one warn, and it must not throw");
  assert.equal(warnings[0]?.level, "warn");
  assert.equal(warnings[0]?.context.reason, "low_space");
  assert.equal(warnings[0]?.context.freedOldest, oldest.file);
});

test("a transient vacuum failure recovers by freeing the oldest generation and retrying once", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);
  await snapshotRounds(fixture, 1);
  const oldest = (await listSnapshots(fixture.backupsDir))[0];
  assert.ok(oldest);

  writeRow(fixture.dbPath, "update session set title = 'transient' where id = 'sess_0'");
  let attempts = 0;
  const result = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
    runVacuumInto: async (dbPath, targetPath) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient disk error");
      await runVacuumIntoWorker(dbPath, targetPath);
    },
  });
  assert.equal(attempts, 2, "exactly one retry");
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.equal(result.freedOldest, oldest.file);
  assert.deepEqual(result.removed, [oldest.file]);
  assert.equal(existsSync(oldest.path), false);
});

test("a missing source database is reported, not thrown", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));

  const result = await createSnapshot({
    dbPath: join(fixture.dir, "does-not-exist.sqlite"),
    backupsDir: fixture.backupsDir,
  });
  assert.equal(result.status, "skipped");
  if (result.status === "skipped") assert.equal(result.reason, "source_missing");
  assert.equal(existsSync(fixture.backupsDir), false, "nothing may be created for a missing source");
});

test("restore refuses a snapshot that fails integrity_check", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const created = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
  });
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  // 快照在盘上烂掉（坏道 / 半份拷贝）：连文件头一起写坏。
  scribble(created.path, 0, 4_096);

  const target = join(fixture.dir, "restored.sqlite");
  const before = readFileSync(fixture.dbPath);
  await assert.rejects(
    restoreSnapshot(created.path, target),
    /snapshot failed integrity_check/,
    "a damaged snapshot must be refused before the original is touched",
  );
  assert.equal(existsSync(target), false, "the target must never be created");
  assert.equal(
    existsSync(`${target}-wal`),
    false,
    "a refused restore must not leave sidecars behind",
  );
  assert.deepEqual(readFileSync(fixture.dbPath), before, "the live database must be untouched");
});

test("the source signature changes on every committed write and is stable when idle", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const idle = await readSourceSignature(fixture.dbPath);
  assert.deepEqual(await readSourceSignature(fixture.dbPath), idle);

  const writer = new DatabaseSync(fixture.dbPath);
  try {
    writer.exec("PRAGMA wal_autocheckpoint=0");
    // 写连接全程保持打开：签名必须在连接不关闭的情况下也能察觉每一次提交。
    for (const [label, sql] of [
      ["insert", "insert into session (id, title, time_updated) values ('sess_new', 'new', 1)"],
      ["in-place update", "update session set title = 'renamed' where id = 'sess_new'"],
      ["delete", "delete from session where id = 'sess_new'"],
    ] as const) {
      const before = await readSourceSignature(fixture.dbPath);
      writer.exec(sql);
      assert.notDeepEqual(await readSourceSignature(fixture.dbPath), before, `${label} must move it`);
    }
  } finally {
    writer.close();
  }

  const selectOnly = await readSourceSignature(fixture.dbPath);
  cellOf(fixture.dbPath, "select count(*) as n from part");
  assert.deepEqual(
    await readSourceSignature(fixture.dbPath),
    selectOnly,
    "a read-only query must not look like a change",
  );
});

test("the generation cap is enforced from disk even when the manifest is lost", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  const seeded = await snapshotRounds(fixture, 2);
  assert.deepEqual(
    seeded.map((result) => result.status),
    ["created", "created"],
  );
  // 模拟 "快照写完了但清单没写上"（ENOSPC 时很现实）：清单丢失 + 一份没人记账的孤儿快照。
  rmSync(join(fixture.backupsDir, "backups.json"));
  const existing = await listSnapshots(fixture.backupsDir);
  const orphan = join(fixture.backupsDir, "db-19990101-000000000.sqlite");
  copyFileSync(existing[0]?.path ?? "", orphan);

  const result = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
    generations: 3,
    now: makeClock(1_900_000_000_000).now,
  });
  assert.equal(result.status, "created");
  const onDisk = await listSnapshots(fixture.backupsDir);
  assert.equal(
    onDisk.length,
    3,
    `the cap must come from the directory listing, got ${onDisk
      .map((info) => info.file)
      .join(",")}`,
  );
  assert.equal(existsSync(orphan), false, "the unaccounted orphan must be the one pruned");
});

test("stale partial leftovers are swept but a fresh one is kept", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);
  mkdirSync(fixture.backupsDir, { recursive: true });

  // 被强杀的 vacuum 会留下一个和快照同量级的残留（最坏 2 GB），必须自动清掉；
  // 但正在写的那一份不能删，所以只清超过锁陈旧阈值的。
  const stale = join(fixture.backupsDir, "db-19900101-000000000.sqlite.partial-1-aaaaaa");
  const fresh = join(fixture.backupsDir, "db-19900101-000001000.sqlite.partial-2-bbbbbb");
  writeFileSync(stale, "x");
  writeFileSync(fresh, "y");
  const longAgo = new Date(Date.now() - 60 * 60_000);
  utimesSync(stale, longAgo, longAgo);

  const result = await createSnapshot({
    dbPath: fixture.dbPath,
    backupsDir: fixture.backupsDir,
  });
  assert.equal(result.status, "created");
  assert.equal(existsSync(stale), false, "a partial older than the staleness window is debris");
  assert.ok(existsSync(fresh), "a partial that may still be in flight must not be deleted");
  assert.equal(
    (await listSnapshots(fixture.backupsDir)).length,
    1,
    "partial files must never be counted as generations",
  );
});

test("the RECOVERY note documents the sidecar deletion step", async (t) => {
  const fixture = makeFixture();
  t.after(() => dropFixture(fixture));
  seedDatabase(fixture.dbPath);

  await createSnapshot({ dbPath: fixture.dbPath, backupsDir: fixture.backupsDir });
  const notePath = join(fixture.backupsDir, RECOVERY_NOTE_FILE);
  assert.ok(existsSync(notePath), "the recovery note must exist next to the snapshots");
  const note = readFileSync(notePath, "utf8");
  // 手工恢复时最容易漏、也最致命的一步：不删 -wal 就会把恢复出来的库再次清空
  // （本文件第一个用例的对照组实测过这个后果）。
  assert.match(note, /db\.sqlite-wal/);
  assert.match(note, /restoreSnapshot/);
  assert.match(note, /VACUUM INTO/);

  // 内容不变时不重写（幂等）。
  const firstMtime = statSync(notePath).mtimeMs;
  writeRow(fixture.dbPath, "update session set title = 'again' where id = 'sess_0'");
  await createSnapshot({ dbPath: fixture.dbPath, backupsDir: fixture.backupsDir });
  assert.equal(statSync(notePath).mtimeMs, firstMtime);
});
