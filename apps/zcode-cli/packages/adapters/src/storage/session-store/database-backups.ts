// 会话库的世代备份（zk-kit guard.backup() 的原生替代）。
//
// 为什么不是 `copyFile`：guard 的做法是顺序复制 db + -wal + -shm 三个文件，而库正在被写，
// 三次复制之间会发生 checkpoint，得到的是撕裂快照；而且它要额外 2 GB × 3 的空间。
// 这里用 sqlite 自己的 `VACUUM INTO`：单文件、自带一致性、**不需要** -wal/-shm 伴生文件。
// 实测（本机 NVMe，2026-10-05）：
//   - 线上库 2 075 942 912 B（2.07 GB），journal_mode=wal，page_size=4096，
//     page_count=506822，**freelist_count=0** ⇒ VACUUM INTO 没有压缩收益，快照≈2 GB；
//   - 磁盘吞吐 348 MB/s ⇒ 一份快照约 6 s；
//   - 放进 worker 线程后主线程完全不阻塞：91.3 MB 的 vacuum 耗时 336 ms，期间主线程
//     setInterval 照常跳了 **89 次**；
//   - 源库以 `readOnly: true` 打开，VACUUM INTO 只读源 ⇒ 备份永远不会给线上库加写锁、
//     不会 checkpoint、也不会写坏它（实测源文件逐字节不变）。
//     反过来说，"先 checkpoint 再复制" 在这里是错的设计：只读连接执行
//     `PRAGMA wal_checkpoint` 会直接 `disk I/O error`，它需要用户线上库的写权限。
//   - 写事务持锁时（BEGIN IMMEDIATE 未提交）VACUUM INTO 依然成功，拿到的是提交前的一致
//     快照，未提交数据不可见（实测 rows=1 / uncommitted visible=0）；
//   - `wal_autocheckpoint=0`、WAL 已涨到 20.6 MB 且写连接仍打开时，快照 20 533 248 B、
//     rows=20000、integrity_check=ok ⇒ **未 checkpoint 的 WAL 帧会被包含**。
//
// 四条硬约束（编排方裁定 8）：单飞、节奏闸门、ENOSPC 删最旧重试一次 + warn、RECOVERY 说明文件。
import type { Logger } from "@zcode/contracts";
import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export const DEFAULT_GENERATIONS = 3;
export const DEFAULT_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_STARTUP_DELAY_MS = 60_000;
// 锁的过期阈值取 15 min：远大于最坏耗时（2.07 GB ≈ 6 s），因此绝不会抢走正在进行的快照，
// 又能让被强杀的进程遗留的锁自行失效。
export const DEFAULT_LOCK_STALE_MS = 15 * 60_000;
// 快照体积 ≈ 源库体积（freelist_count=0，无压缩收益），预留 1.5 倍余量给 VACUUM 的临时页。
export const DEFAULT_SAFETY_FACTOR = 1.5;

const SNAPSHOT_PREFIX = "db-";
const SNAPSHOT_SUFFIX = ".sqlite";
const PARTIAL_INFIX = ".partial-";
const MANIFEST_FILE = "backups.json";
const LOCK_FILE = ".snapshot.lock";
export const RECOVERY_NOTE_FILE = "RECOVERY.md";
const LOG_MODULE = "adapters.sessionStore";

export interface FileMark {
  size: number;
  mtimeMs: number;
}

/**
 * 源库变更签名。
 *
 * 为什么不用内容派生的签名：`PRAGMA data_version` 实测在 INSERT / 原地 UPDATE / DELETE 之后
 * 恒为 2（无用）；`page_count + max(id) + max(time_updated)` 也瞎——一次行数与时间戳都不变的
 * `UPDATE part SET data=…` 让它们全部相同（与裁定 3 里 projection watermark 的盲点同源）。
 * 落到 {size, mtimeMs} 上是可靠的：WAL 模式下每次提交都往 -wal 追加帧（size+mtime 变），
 * 每次 checkpoint 都把帧搬进主库（db mtime 变），所以没有任何提交能让签名保持不变。
 * NTFS 实测：写连接保持打开时 insert / 原地 update / delete 都改变了签名，空跑 select 没有。
 *
 * `-shm` **故意排除**：它是派生的 WAL 索引、不含已提交数据，而只读打开库（VACUUM INTO 就会）
 * 会创建/重写它。实测：写连接关闭后 wal=ABSENT shm=ABSENT；第一次只读 VACUUM INTO 之后
 * wal=0@t shm=32768@t；第 2、3 次稳定。把 -shm 算进去会让 "跳过" 永远不触发
 * （真实的测试失败：期望 skipped 得到 created）。零长度 -wal 不含帧，同样归一化为 null。
 */
export interface SourceSignature {
  db: FileMark | null;
  wal: FileMark | null;
}

export interface SnapshotInfo {
  file: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  stamp: string;
}

export interface SnapshotManifestEntry {
  file: string;
  createdAt: number;
  bytes: number;
  sourceBytes: number | null;
  sourceSignature: SourceSignature | null;
  freedOldest?: string;
}

export interface SnapshotManifest {
  snapshots: SnapshotManifestEntry[];
}

export type SnapshotSkipReason =
  | "unchanged"
  | "recent"
  | "low_space"
  | "source_missing"
  | "in_flight"
  | "failed";

export type SnapshotResult =
  | {
      status: "created";
      file: string;
      path: string;
      bytes: number;
      createdAt: number;
      removed: string[];
      freedOldest: string | null;
    }
  | {
      status: "skipped";
      reason: SnapshotSkipReason;
      file?: string;
      ageMs?: number;
      minAgeMs?: number;
      freedOldest?: string | null;
      message?: string;
    };

export type VacuumIntoRunner = (dbPath: string, targetPath: string) => Promise<void>;

export interface CreateSnapshotOptions {
  dbPath: string;
  backupsDir: string;
  /** 保留几份。默认 3（guard 注释写 20、代码留 3，规格取 3）。 */
  generations?: number;
  /** 节奏闸门：最新一份比这个值年轻就跳过。启动那一次传 0，因此总会跑。 */
  minAgeMs?: number;
  now?: () => number;
  safetyFactor?: number;
  lockStaleMs?: number;
  logger?: Logger;
  /** 可注入以便测试驱动同一条代码路径；默认是真正的 worker 实现。 */
  runVacuumInto?: VacuumIntoRunner;
}

export interface RestoreSnapshotOptions {
  /** 默认 true：损坏的库改名留证（`.pre-restore-<stamp>`），绝不盲删。 */
  keepOriginal?: boolean;
  logger?: Logger;
}

export interface RestoreSnapshotResult {
  restored: string;
  preserved: string | null;
}

export interface SessionDatabaseBackupTimer {
  unref?(): void;
}

export interface ScheduleSessionDatabaseBackupsOptions {
  dbPath: string;
  backupsDir: string;
  generations?: number;
  intervalMs?: number;
  startupDelayMs?: number;
  safetyFactor?: number;
  logger?: Logger;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => SessionDatabaseBackupTimer;
  clearTimeout?: (timer: SessionDatabaseBackupTimer) => void;
  /** 可注入以便测试；默认走真正的 createSnapshot。 */
  snapshot?: (options: CreateSnapshotOptions) => Promise<SnapshotResult>;
}

export interface SessionDatabaseBackupHandle {
  cancel(): void;
}

class LowSpaceError extends Error {
  readonly freeBytes: number;
  readonly needBytes: number;

  constructor(freeBytes: number, needBytes: number) {
    super(`insufficient free space: ${freeBytes} < ${needBytes}`);
    this.name = "LowSpaceError";
    this.freeBytes = freeBytes;
    this.needBytes = needBytes;
  }
}

// 进程内单飞。跨进程由 .snapshot.lock 兜底（桌面端可能有 N 个 Host 进程）。
let inFlight: Promise<SnapshotResult> | null = null;

// 文件名用 UTC：本地时戳在夏令时回拨时会不再单调，"最旧的一份" 就会算错，
// 而这是数据安全代码。清单里另有 createdAt（epoch ms），展示层要本地时间自己转。
function stampOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` +
    `${p(d.getUTCMilliseconds(), 3)}`
  );
}

function parseStamp(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(stamp);
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]),
  );
  return Number.isFinite(ms) ? ms : null;
}

// 与 adapters/src/logging/retention.ts 的同名助手保持同一语义（那里也是模块私有，
// 不跨文件复用：两个模块的错误分类各自演进，共享一个助手只会把它们绑在一起）。
function hasFileSystemCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string" && error.code === code
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function markOf(file: string): Promise<FileMark | null> {
  try {
    const st = await fs.stat(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function readSourceSignature(dbPath: string): Promise<SourceSignature> {
  const wal = await markOf(dbPath + "-wal");
  return {
    db: await markOf(dbPath),
    wal: wal && wal.size === 0 ? null : wal,
  };
}

function sameSignature(a: SourceSignature | null, b: SourceSignature | null): boolean {
  if (!a || !b) return false;
  for (const key of ["db", "wal"] as const) {
    const x = a[key];
    const y = b[key];
    if (x === null || y === null) {
      if (x !== y) return false;
      continue;
    }
    if (x.size !== y.size || x.mtimeMs !== y.mtimeMs) return false;
  }
  return true;
}

function decodeFileMark(value: unknown): FileMark | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("size" in value) || !("mtimeMs" in value)) return null;
  const size = numberOf(value.size);
  const mtimeMs = numberOf(value.mtimeMs);
  return size === null || mtimeMs === null ? null : { size, mtimeMs };
}

function decodeSignature(value: unknown): SourceSignature | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("db" in value) || !("wal" in value)) return null;
  const db = value.db === null ? null : decodeFileMark(value.db);
  const wal = value.wal === null ? null : decodeFileMark(value.wal);
  if (value.db !== null && db === null) return null;
  if (value.wal !== null && wal === null) return null;
  return { db, wal };
}

// 清单是我们自己写的持久化 blob，损坏时**降级为空清单**而不是抛：备份机制不该因为
// 一个 json 文件坏掉就停止保护数据库。逐条解码，坏条目直接丢弃。
function decodeManifest(value: unknown): SnapshotManifest {
  if (typeof value !== "object" || value === null) return { snapshots: [] };
  if (!("snapshots" in value) || !Array.isArray(value.snapshots)) return { snapshots: [] };
  const snapshots: SnapshotManifestEntry[] = [];
  for (const raw of value.snapshots) {
    if (typeof raw !== "object" || raw === null) continue;
    if (!("file" in raw) || !("createdAt" in raw)) continue;
    const file = stringOf(raw.file);
    const createdAt = numberOf(raw.createdAt);
    if (file === null || createdAt === null) continue;
    const sourceBytes = "sourceBytes" in raw ? numberOf(raw.sourceBytes) : null;
    const signature = "sourceSignature" in raw ? decodeSignature(raw.sourceSignature) : null;
    const freedOldest = "freedOldest" in raw ? stringOf(raw.freedOldest) : null;
    snapshots.push({
      file,
      createdAt,
      bytes: ("bytes" in raw ? numberOf(raw.bytes) : null) ?? 0,
      sourceBytes,
      sourceSignature: signature,
      ...(freedOldest ? { freedOldest } : {}),
    });
  }
  return { snapshots };
}

async function readManifest(dir: string): Promise<SnapshotManifest> {
  try {
    return decodeManifest(JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8")));
  } catch {
    return { snapshots: [] };
  }
}

async function writeManifest(dir: string, manifest: SnapshotManifest): Promise<void> {
  const target = path.join(dir, MANIFEST_FILE);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}

/** 目录里已发布的快照，按文件名（= UTC 时戳）升序，最旧的在 [0]。忽略 .partial- 残留。 */
export async function listSnapshots(backupsDir: string): Promise<SnapshotInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupsDir);
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) return [];
    throw error;
  }
  const names = entries
    .filter(
      (n) =>
        n.startsWith(SNAPSHOT_PREFIX) && n.endsWith(SNAPSHOT_SUFFIX) && !n.includes(PARTIAL_INFIX),
    )
    .sort();
  const out: SnapshotInfo[] = [];
  for (const name of names) {
    const target = path.join(backupsDir, name);
    const st = await fs.stat(target);
    out.push({
      file: name,
      path: target,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      stamp: name.slice(SNAPSHOT_PREFIX.length, -SNAPSHOT_SUFFIX.length),
    });
  }
  return out;
}

// VACUUM INTO 收的是 SQL 字符串字面量；Windows 路径里的单引号必须双写，绝不做字符串插值。
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const VACUUM_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
  try { db.exec("VACUUM INTO " + workerData.literal); } finally { db.close(); }
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: String((error && error.message) || error) });
}
`;

/**
 * 真正的默认 runner：VACUUM INTO 跑在 worker 线程里，2 GB / ~6 s 的快照不会卡住 agent 的事件循环。
 * worker 源码用**内联字符串**（`eval: true`）而不是 `new URL(...)` 入口，这样不需要改 tsup/bundler
 * 配置；本包已有同样的先例：`adapters/src/fs/index.ts` 的 RIPGREP_WORKER_SOURCE。
 * 内联 worker 默认按 CommonJS 求值，所以里面用 require。
 */
export function runVacuumIntoWorker(dbPath: string, targetPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(VACUUM_WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath, literal: sqlLiteral(targetPath) },
    });
    let settled = false;
    worker.once("message", (message: { ok?: boolean; message?: string }) => {
      settled = true;
      if (message?.ok) resolve();
      else reject(new Error(message?.message ?? "VACUUM INTO failed"));
    });
    worker.once("error", (error: Error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code: number) => {
      if (!settled) reject(new Error(`backup worker exited with code ${code}`));
    });
  });
}

async function freeBytesOf(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    // 探测失败不该拦住备份：真正的 ENOSPC 会走 "删最旧重试一次" 那条路。
    return null;
  }
}

interface LockToken {
  pid: number;
  startedAt: number;
}

interface OwnedLock {
  lockPath: string;
  token: LockToken;
}

function decodeLockToken(value: unknown): LockToken | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("pid" in value) || !("startedAt" in value)) return null;
  const pid = numberOf(value.pid);
  const startedAt = numberOf(value.startedAt);
  return pid === null || startedAt === null ? null : { pid, startedAt };
}

async function readLockToken(lockPath: string): Promise<LockToken | null> {
  try {
    return decodeLockToken(JSON.parse(await fs.readFile(lockPath, "utf8")));
  } catch {
    return null;
  }
}

async function acquireLock(
  dir: string,
  now: () => number,
  staleAfterMs: number,
): Promise<OwnedLock | null> {
  const lockPath = path.join(dir, LOCK_FILE);
  const token: LockToken = { pid: process.pid, startedAt: now() };
  // 两次尝试：第二次是为了在 "偷掉一把陈旧锁" 之后真正拿到它。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockPath, JSON.stringify(token), { flag: "wx" });
      return { lockPath, token };
    } catch (error) {
      if (!hasFileSystemCode(error, "EEXIST")) throw error;
      const held = await readLockToken(lockPath);
      // 被强杀的进程跑不到自己的 finally；读不出来或者太老的锁只偷一次，
      // 这样备份不需要人工清理就能恢复。
      const stale = held === null || now() - held.startedAt > staleAfterMs;
      if (!stale) return null;
      await fs.rm(lockPath, { force: true });
    }
  }
  return null;
}

async function releaseLock(owned: OwnedLock | null): Promise<void> {
  if (!owned) return;
  const current = await readLockToken(owned.lockPath);
  // 只删自己的令牌：被偷走的锁现在属于别人。读不出令牌时按残留处理，直接删。
  if (current === null || (current.pid === owned.token.pid && current.startedAt === owned.token.startedAt)) {
    await fs.rm(owned.lockPath, { force: true });
  }
}

const RECOVERY_NOTE = `# 会话数据库备份 / Session database backups

这个目录由 ZCode 自动维护：启动后一次、之后每 30 分钟一次，用 sqlite \`VACUUM INTO\`
对 \`~/.zcode/cli/db/db.sqlite\` 做**一致性整库快照**，最多保留 3 份。
每份约等于当前库大小（实测 2.07 GB 库 → 约 2 GB 快照，约 6 秒）。

This directory is maintained by ZCode: one snapshot shortly after launch and one
every 30 minutes, taken with sqlite \`VACUUM INTO\` — a consistent whole-database
copy of \`~/.zcode/cli/db/db.sqlite\`. At most 3 generations are kept.

## 文件 / Files

- \`db-<YYYYMMDD-HHMMSSmmm>.sqlite\` — 快照本体，单文件，**没有** \`-wal\`/\`-shm\` 伴生文件。
  文件名里的时戳是 **UTC**（本地时戳在夏令时回拨时不再单调，会算错 "最旧的一份"）。
- \`backups.json\` — 清单：每份快照的时间（epoch ms）、字节数与源库变更签名。
- \`.snapshot.lock\` — 运行锁，正常情况只在快照进行中的几秒内存在；超过 15 分钟视为陈旧并被接管。
- \`db-*.sqlite.partial-*\` — 只可能是中断残留，可以直接删除（程序也会在下一轮自动清掉）。

## 如何恢复 / How to restore

1. **完全退出 ZCode**（含托盘/后台进程）。数据库被占用时恢复会失败或再次损坏。
   Quit ZCode completely first.
2. 把当前损坏的库挪走留证，不要直接删：
   Move the damaged database aside instead of deleting it:
   \`mv ~/.zcode/cli/db/db.sqlite ~/.zcode/cli/db/db.sqlite.damaged\`
3. **删除伴生文件**——旧库的 WAL 一旦被回放到恢复出来的文件上，会把内容再次清空：
   Delete the sidecars; replaying the old WAL onto the restored file wipes it:
   \`rm -f ~/.zcode/cli/db/db.sqlite-wal ~/.zcode/cli/db/db.sqlite-shm\`
4. 复制最近一份可用的快照，并把日志模式改回 WAL：
   Copy the newest good snapshot and re-arm WAL mode:
   \`cp ~/.zcode/cli/db/backups/db-<stamp>.sqlite ~/.zcode/cli/db/db.sqlite\`
   \`sqlite3 ~/.zcode/cli/db/db.sqlite "PRAGMA journal_mode=WAL; PRAGMA integrity_check"\`
5. 重新启动 ZCode。启动迁移会自动补齐 schema 版本差。
   Restart ZCode; startup migrations reconcile any schema version gap.

程序内恢复走同一套逻辑（校验快照完整性 → 保留原库 → 复制 → 删除伴生文件 → 重新置 WAL），
入口是 adapters 的 \`restoreSnapshot(snapshotPath, dbPath)\`，调用前必须先关闭 session store。
In-app restore uses the same steps via \`restoreSnapshot(snapshotPath, dbPath)\`.

## 注意 / Notes

- 快照是**整库**副本，包含所有会话、消息与用量记录；请按需清理，不要提交到仓库。
  Snapshots are whole-database copies of every session, message and usage row.
- 磁盘空间不足时，最旧的一份会被自动删除后重试一次；仍然失败则跳过本轮并记 warn 日志。
  备份机制永远不会让应用崩溃，也永远不会写坏正在使用的库（源库是只读打开的）。
  On low space the oldest generation is freed and the snapshot retried once; if it
  still fails the round is skipped with a warning. Backups never crash the app and
  never write to the live database (the source is opened read-only).
- 空闲时不会重复写盘：源库签名未变化的一轮直接跳过（否则 24/7 挂着的应用每天要白写约 96 GB）。
  An idle database is detected and the round is skipped, so no pointless 2 GB writes.
`;

async function ensureRecoveryNote(dir: string): Promise<boolean> {
  const target = path.join(dir, RECOVERY_NOTE_FILE);
  try {
    if ((await fs.readFile(target, "utf8")) === RECOVERY_NOTE) return false;
  } catch {
    /* 首次写入 */
  }
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, RECOVERY_NOTE, "utf8");
  await fs.rename(tmp, target);
  return true;
}

// 被强杀的 vacuum 会留下一个和快照同量级的 .partial- 文件（最坏 2 GB）。
// 只有超过锁陈旧阈值还没动过的才算残留——正在写的那一份不能删。
async function sweepStalePartials(dir: string, now: number, staleAfterMs: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!name.includes(PARTIAL_INFIX)) continue;
    const target = path.join(dir, name);
    try {
      const st = await fs.stat(target);
      if (now - st.mtimeMs < staleAfterMs) continue;
      await fs.rm(target, { force: true });
      removed.push(name);
    } catch {
      /* 忽略：清残留失败不影响本轮备份 */
    }
  }
  return removed;
}

interface BackupState {
  manifest: SnapshotManifest;
  /** 目录里真实存在的快照（升序）。世代上限以磁盘为准，不以清单为准。 */
  snapshots: SnapshotInfo[];
  newest: SnapshotManifestEntry | null;
}

/**
 * 清单可能落后于磁盘：快照写完之后清单写失败（ENOSPC 时很现实）就会留下一份没人记账的 2 GB 文件，
 * 于是 "超过 generations 就删" 永远不触发，磁盘被悄悄吃满。所以世代上限一律以**目录列表**为准，
 * 清单只用来补元数据；目录里有、清单里没有的文件按名字里的 UTC 时戳补一条（签名为 null，
 * 顶多多做一轮快照，绝不会少做）。
 */
async function readBackupState(dir: string): Promise<BackupState> {
  const [manifest, snapshots] = await Promise.all([readManifest(dir), listSnapshots(dir)]);
  const byFile = new Map(manifest.snapshots.map((entry) => [entry.file, entry]));
  const reconciled: SnapshotManifestEntry[] = snapshots.map((info) => {
    const known = byFile.get(info.file);
    if (known) return known;
    return {
      file: info.file,
      createdAt: parseStamp(info.stamp) ?? Math.round(info.mtimeMs),
      bytes: info.bytes,
      sourceBytes: null,
      sourceSignature: null,
    };
  });
  return {
    manifest: { snapshots: reconciled },
    snapshots,
    newest: reconciled.length > 0 ? (reconciled[reconciled.length - 1] ?? null) : null,
  };
}

async function vacuumOnce(options: {
  dbPath: string;
  backupsDir: string;
  finalPath: string;
  partialPath: string;
  safetyFactor: number;
  runVacuumInto: VacuumIntoRunner;
}): Promise<number> {
  const source = await fs.stat(options.dbPath);
  const free = await freeBytesOf(options.backupsDir);
  const need = source.size * options.safetyFactor;
  if (free !== null && free < need) throw new LowSpaceError(free, need);
  await fs.rm(options.partialPath, { force: true });
  await options.runVacuumInto(options.dbPath, options.partialPath);
  // 原子发布：VACUUM INTO 拒绝覆盖已存在的文件，而中断的 vacuum 绝不能被算作一个世代。
  await fs.rename(options.partialPath, options.finalPath);
  return (await fs.stat(options.finalPath)).size;
}

function skipFailed(
  logger: Logger | undefined,
  error: unknown,
  freedOldest: string | null,
): SnapshotResult {
  const reason: SnapshotSkipReason = error instanceof LowSpaceError ? "low_space" : "failed";
  const message = messageOf(error);
  logger?.warn("Session database snapshot failed", {
    event: "session_store.backup.failed",
    module: LOG_MODULE,
    reason,
    freedOldest,
    message,
    status: "failed",
    ...(error instanceof LowSpaceError
      ? { freeBytes: error.freeBytes, needBytes: error.needBytes }
      : {}),
  });
  return { status: "skipped", reason, freedOldest, message };
}

async function freeOldestGeneration(dir: string, state: BackupState): Promise<string | null> {
  const oldest = state.snapshots[0];
  if (!oldest) return null;
  await fs.rm(oldest.path, { force: true });
  state.manifest.snapshots = state.manifest.snapshots.filter((entry) => entry.file !== oldest.file);
  state.snapshots = state.snapshots.filter((info) => info.file !== oldest.file);
  await writeManifest(dir, state.manifest);
  return oldest.file;
}

async function createSnapshotOnce(options: CreateSnapshotOptions): Promise<SnapshotResult> {
  const generations = options.generations ?? DEFAULT_GENERATIONS;
  const minAgeMs = options.minAgeMs ?? 0;
  const now = options.now ?? ((): number => Date.now());
  const safetyFactor = options.safetyFactor ?? DEFAULT_SAFETY_FACTOR;
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const runVacuumInto = options.runVacuumInto ?? runVacuumIntoWorker;
  const logger = options.logger;
  const startedAt = now();

  const source = await markOf(options.dbPath);
  if (!source) {
    return { status: "skipped", reason: "source_missing", message: options.dbPath };
  }

  await fs.mkdir(options.backupsDir, { recursive: true });
  // 说明文件与快照解耦：即使每一轮都被跳过，用户打开这个目录也能看到恢复步骤。
  await ensureRecoveryNote(options.backupsDir).catch(() => undefined);
  await sweepStalePartials(options.backupsDir, startedAt, lockStaleMs);

  const state = await readBackupState(options.backupsDir);
  const newest = state.newest;

  // 节奏闸门。启动那一次 minAgeMs=0 总会跑；周期轮次不能把第二份 2 GB 叠在刚写完的那份上。
  if (minAgeMs > 0 && newest && Number.isFinite(newest.createdAt)) {
    const ageMs = startedAt - newest.createdAt;
    if (ageMs < minAgeMs) {
      return { status: "skipped", reason: "recent", file: newest.file, ageMs, minAgeMs };
    }
  }

  const signature = await readSourceSignature(options.dbPath);
  if (newest && sameSignature(newest.sourceSignature, signature)) {
    const existing = await markOf(path.join(options.backupsDir, newest.file));
    if (existing) {
      logger?.debug("Session database unchanged since the last snapshot", {
        event: "session_store.backup.skipped",
        module: LOG_MODULE,
        reason: "unchanged",
        file: newest.file,
        status: "waiting",
      });
      return { status: "skipped", reason: "unchanged", file: newest.file };
    }
  }

  const owned = await acquireLock(options.backupsDir, now, lockStaleMs);
  // 另一个进程（或本进程的另一个调度器）正在做快照。
  if (!owned) return { status: "skipped", reason: "in_flight" };
  try {
    const file = `${SNAPSHOT_PREFIX}${stampOf(startedAt)}${SNAPSHOT_SUFFIX}`;
    const finalPath = path.join(options.backupsDir, file);
    const partialPath = `${finalPath}${PARTIAL_INFIX}${process.pid}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const attempt = {
      dbPath: options.dbPath,
      backupsDir: options.backupsDir,
      finalPath,
      partialPath,
      safetyFactor,
      runVacuumInto,
    };

    let bytes: number;
    let freedOldest: string | null = null;
    try {
      bytes = await vacuumOnce(attempt);
    } catch (error) {
      // ENOSPC 以及任何其它失败：删掉最旧的一个世代，**只重试一次**。备份机制绝不能让应用崩。
      freedOldest = await freeOldestGeneration(options.backupsDir, state).catch(() => null);
      if (!freedOldest) return skipFailed(logger, error, null);
      try {
        bytes = await vacuumOnce(attempt);
      } catch (retryError) {
        return skipFailed(logger, retryError, freedOldest);
      }
    }

    const manifest = state.manifest;
    manifest.snapshots.push({
      file,
      createdAt: startedAt,
      bytes,
      sourceBytes: source.size,
      sourceSignature: signature,
      ...(freedOldest ? { freedOldest } : {}),
    });
    const removed = freedOldest ? [freedOldest] : [];
    // 世代上限以磁盘为准（见 readBackupState 的注释）。
    const onDisk = await listSnapshots(options.backupsDir);
    const overflow = Math.max(0, onDisk.length - Math.max(1, generations));
    for (const stale of onDisk.slice(0, overflow)) {
      await fs.rm(stale.path, { force: true });
      removed.push(stale.file);
    }
    const keep = new Set(onDisk.slice(overflow).map((info) => info.file));
    manifest.snapshots = manifest.snapshots.filter((entry) => keep.has(entry.file));
    await writeManifest(options.backupsDir, manifest);

    logger?.info("Session database snapshot created", {
      event: "session_store.backup.created",
      module: LOG_MODULE,
      file,
      bytes,
      sourceBytes: source.size,
      generations,
      removed,
      elapsedMs: now() - startedAt,
      status: "completed",
    });
    return {
      status: "created",
      file,
      path: finalPath,
      bytes,
      createdAt: startedAt,
      removed,
      freedOldest,
    };
  } finally {
    await releaseLock(owned);
  }
}

/**
 * 做一个世代快照。**永不 reject**：备份失败只该出现在日志里，不该把 agent 进程带走。
 * 并发调用（同进程）立刻拿到 `skipped/in_flight`；跨进程由 `.snapshot.lock` 挡住。
 */
export function createSnapshot(options: CreateSnapshotOptions): Promise<SnapshotResult> {
  if (inFlight) return Promise.resolve({ status: "skipped", reason: "in_flight" });
  const flight = (async (): Promise<SnapshotResult> => {
    try {
      return await createSnapshotOnce(options);
    } catch (error) {
      return skipFailed(options.logger, error, null);
    }
  })().finally(() => {
    if (inFlight === flight) inFlight = null;
  });
  inFlight = flight;
  return flight;
}

/**
 * 用一份快照恢复会话库。调用前 **必须** 已经关闭 session store：Windows 上库文件被占用时
 * rename 会失败，而半路失败会留下一个没有 -wal 的库。
 *
 * 顺序是有讲究的：
 *  1. 先只读打开快照跑 `PRAGMA integrity_check`，不合格就拒绝——**在碰原库之前**拒绝；
 *  2. 原库改名留证（`.pre-restore-<stamp>`），绝不盲删；
 *  3. 复制快照；
 *  4. **删掉 -wal / -shm**：损坏库的 WAL 里可能正躺着 `DELETE FROM part`，回放到恢复出来的
 *     文件上会把它悄悄清空（回归测试断言的正是这一条）；
 *  5. 重新置 WAL：VACUUM INTO 的产物是 rollback-journal 库（实测 journal=delete），
 *     而 migration-runner 期望 WAL。
 */
export async function restoreSnapshot(
  snapshotPath: string,
  dbPath: string,
  options: RestoreSnapshotOptions = {},
): Promise<RestoreSnapshotResult> {
  const keepOriginal = options.keepOriginal ?? true;
  const verify = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    // 严重损坏时 integrity_check 本身会抛（malformed / not a database），不是返回一行。
    // 统一归一成一个错误类：调用方只需要认 "snapshot failed integrity_check"，
    // 而不必枚举 sqlite 的每一种损坏措辞。
    let row: Record<string, unknown> | undefined;
    try {
      row = verify.prepare("PRAGMA integrity_check").get();
    } catch (error) {
      throw new Error(`snapshot failed integrity_check: ${messageOf(error)}`);
    }
    const verdict = row ? (row.integrity_check ?? row[Object.keys(row)[0] ?? ""]) : undefined;
    if (verdict !== "ok") {
      throw new Error(`snapshot failed integrity_check: ${JSON.stringify(row ?? null)}`);
    }
  } finally {
    verify.close();
  }

  const existed = await markOf(dbPath);
  let preserved: string | null = null;
  if (existed) {
    if (keepOriginal) {
      preserved = `${dbPath}.pre-restore-${stampOf(Date.now())}`;
      await fs.rename(dbPath, preserved);
    } else {
      await fs.rm(dbPath, { force: true });
    }
  }
  await fs.copyFile(snapshotPath, dbPath);
  await fs.rm(`${dbPath}-wal`, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
  } finally {
    db.close();
  }
  options.logger?.info("Session database restored from snapshot", {
    event: "session_store.backup.restored",
    module: LOG_MODULE,
    snapshot: snapshotPath,
    restored: dbPath,
    preserved,
    status: "completed",
  });
  return { restored: dbPath, preserved };
}

/**
 * 启动后一次 + 之后每 intervalMs 一次。
 *
 * 形状照抄 `adapters/src/logging/retention.ts` 的调度器：可注入的 setTimeout、`timer.unref?.()`、
 * **自重排而不是 setInterval**（这样一次慢快照永远不会和自己重叠）。错误只记日志，绝不抛出。
 * 空闲时由签名比对跳过，多进程/多窗口由锁 + 节奏闸门兜住，所以挂着不动的应用不会每天白写 ~96 GB。
 */
export function scheduleSessionDatabaseBackups(
  options: ScheduleSessionDatabaseBackupsOptions,
): SessionDatabaseBackupHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startupDelayMs = options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  const generations = options.generations ?? DEFAULT_GENERATIONS;
  const safetyFactor = options.safetyFactor ?? DEFAULT_SAFETY_FACTOR;
  const now = options.now ?? ((): number => Date.now());
  const schedule =
    options.setTimeout ??
    ((callback: () => void, delayMs: number): SessionDatabaseBackupTimer =>
      setTimeout(callback, delayMs));
  const unschedule = options.clearTimeout ?? clearBackupTimer;
  const snapshot = options.snapshot ?? createSnapshot;
  const logger = options.logger;

  let timer: SessionDatabaseBackupTimer | null = null;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    if (timer) unschedule(timer);
    timer = schedule(() => {
      timer = null;
      void run(intervalMs);
    }, intervalMs);
    timer.unref?.();
  };

  const run = async (minAgeMs: number): Promise<void> => {
    if (stopped) return;
    const startedAt = now();
    let result: SnapshotResult;
    try {
      result = await snapshot({
        dbPath: options.dbPath,
        backupsDir: options.backupsDir,
        generations,
        minAgeMs,
        safetyFactor,
        now,
        logger,
      });
    } catch (error) {
      // createSnapshot 自己不抛；注入的 runner 可能会，这里兜住，定时器必须继续。
      logger?.warn("Session database backup round threw", {
        event: "session_store.backup.failed",
        module: LOG_MODULE,
        reason: "failed",
        message: messageOf(error),
        status: "failed",
      });
      arm();
      return;
    }
    if (stopped) return;
    if (result.status === "skipped") {
      // unchanged / recent / in_flight 都是正常状态，不值得 warn。
      const quiet =
        result.reason === "unchanged" || result.reason === "recent" || result.reason === "in_flight";
      const context = {
        event: "session_store.backup.skipped",
        module: LOG_MODULE,
        reason: result.reason,
        file: result.file,
        elapsedMs: now() - startedAt,
        status: "waiting" as const,
      };
      if (quiet) logger?.debug("Session database snapshot skipped", context);
      else logger?.warn("Session database snapshot skipped", { ...context, message: result.message });
    }
    arm();
  };

  logger?.info("Session database backups scheduled", {
    event: "session_store.backup.scheduled",
    module: LOG_MODULE,
    dbPath: options.dbPath,
    backupsDir: options.backupsDir,
    generations,
    intervalMs,
    startupDelayMs,
    status: "waiting",
  });
  timer = schedule(() => {
    timer = null;
    void run(0);
  }, startupDelayMs);
  timer.unref?.();

  return {
    cancel(): void {
      stopped = true;
      if (timer) {
        unschedule(timer);
        timer = null;
      }
    },
  };
}

function clearBackupTimer(timer: SessionDatabaseBackupTimer): void {
  // 默认调度器交回来的就是 Node 的 Timeout 句柄；注入版必须自带 clearTimeout。
  const nodeTimer = timer as NodeJS.Timeout;
  clearTimeout(nodeTimer);
}
