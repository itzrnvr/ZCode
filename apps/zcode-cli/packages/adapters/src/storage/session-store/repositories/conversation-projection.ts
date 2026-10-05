import type { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@zcode/contracts";

// conversation projection（0024）的存取面。行内容对本模块是**不透明**的：adapters 不认识
// ConversationRow（那是 bootstrap/shared 的词），这里只按 (session_id, seq) 存取 payload 字符串，
// 并把 row_id / turn_id / kind 拆成列以支持游标翻页与不回表的过滤。类型边界因此是干净的：
// 换 row 格式只动 bootstrap 的 builder 与 schema_version，不动这里。

/** 一行待存投影。payload = JSON.stringify(ConversationRow)。 */
export interface StoredProjectionRow {
  rowId: number;
  turnId: string;
  kind: string;
  payload: string;
}

export interface ProjectionMeta {
  revision: string;
  schemaVersion: number;
  updatedAt: number;
}

export interface ProjectionPage {
  rows: StoredProjectionRow[];
  /** beforeRowId 方向（更旧）是否还有行。游标 = 本页最小 row_id；空页恒为 false。 */
  hasMore: boolean;
}

interface ProjectionRowRecord {
  session_id: string;
  row_id: number;
  turn_id: string;
  kind: string;
  payload: string;
  seq: number;
}

/**
 * 会话写入水位 +1，返回新值。
 *
 * 必须是**一条**语句而不是先读后写：WAL 下 zcode 允许多个 Agent 共享同一个库
 * （见 dwf-journal.ts 的同款注释），先读 max 再插入会在两个进程之间竞争出同一个 seq，
 * revision 随之重复 —— 那正是这张表要防的 false-fresh。`returning` 顺带把新值给调用方，
 * 省一次往返。
 */
export function bumpWatermark(db: DatabaseSync, sessionID: SessionId): number {
  const row = db
    .prepare(
      `
      insert into conv_projection_watermark (session_id, seq)
      values (?, 1)
      on conflict(session_id) do update set seq = seq + 1
      returning seq
      `,
    )
    .get(sessionID) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

/** 无行 = 0：该会话尚无任何经四个 mutator 的写入。 */
export function readWatermark(db: DatabaseSync, sessionID: SessionId): number {
  const row = db
    .prepare("select seq from conv_projection_watermark where session_id = ?")
    .get(sessionID) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

export function readMeta(db: DatabaseSync, sessionID: SessionId): ProjectionMeta | null {
  const row = db
    .prepare(
      "select revision, schema_version, updated_at from conv_projection_meta where session_id = ?",
    )
    .get(sessionID) as
    | { revision: string; schema_version: number; updated_at: number }
    | undefined;
  if (!row) return null;
  return { revision: row.revision, schemaVersion: row.schema_version, updatedAt: row.updated_at };
}

function toStoredRow(row: ProjectionRowRecord): StoredProjectionRow {
  return { rowId: row.row_id, turnId: row.turn_id, kind: row.kind, payload: row.payload };
}

/** 全量按 seq 升序读出。只用于后缀 diff，不走请求路径。 */
export function readRows(db: DatabaseSync, sessionID: SessionId): StoredProjectionRow[] {
  const rows = db
    .prepare(
      `
      select session_id, row_id, turn_id, kind, payload, seq
      from conv_projection_row
      where session_id = ?
      order by seq
      `,
    )
    .all(sessionID) as unknown as ProjectionRowRecord[];
  return rows.map(toStoredRow);
}

/**
 * 一页行，rowId 升序返回。
 *
 * 两种翻页共用一条游标规则，因此没有「尾页特例」：cursor = 本页最小 row_id，
 * hasMore = cursor 存在且还有 row_id < cursor 的行。尾页与 beforeRowId 页都走
 * conv_projection_row_cursor_idx / 主键倒序，limit 到界即停。
 */
export function readPage(
  db: DatabaseSync,
  sessionID: SessionId,
  opts: { beforeRowId?: number; limit: number },
): ProjectionPage {
  const descending =
    opts.beforeRowId === undefined
      ? db
          .prepare(
            `
            select session_id, row_id, turn_id, kind, payload, seq
            from conv_projection_row
            where session_id = ?
            order by seq desc
            limit ?
            `,
          )
          .all(sessionID, opts.limit)
      : db
          .prepare(
            `
            select session_id, row_id, turn_id, kind, payload, seq
            from conv_projection_row
            where session_id = ? and row_id < ?
            order by seq desc
            limit ?
            `,
          )
          .all(sessionID, opts.beforeRowId, opts.limit);
  const records = (descending as unknown as ProjectionRowRecord[]).reverse();
  const rows = records.map(toStoredRow);
  if (rows.length === 0) return { rows, hasMore: false };
  const cursor = rows[0]!.rowId;
  const older = db
    .prepare(
      "select 1 from conv_projection_row where session_id = ? and row_id < ? limit 1",
    )
    .get(sessionID, cursor);
  return { rows, hasMore: older !== undefined };
}

/** meta + 一页行，一次 `begin deferred` 读事务内取完。 */
export interface ProjectionView extends ProjectionPage {
  meta: ProjectionMeta | null;
}

/**
 * 原子读一份「meta + 一页行」。
 *
 * 必须在同一个读事务里取：折叠是把 rows 与 meta 写在**同一个** `begin immediate` 里的，
 * 分开读就可能拿到「旧 meta 的 revision + 新 rows」，于是回给客户端的 revision 与它手里的行
 * 不是同一份状态。WAL 下 `begin deferred` 是快照读，既不阻塞写方也不被写方阻塞
 * （journal_mode 由 migration-runner 强制成 wal，:memory: 是单连接天然一致）。
 */
export function readView(
  db: DatabaseSync,
  sessionID: SessionId,
  opts: { beforeRowId?: number; limit: number },
): ProjectionView {
  db.exec("begin deferred");
  try {
    const meta = readMeta(db, sessionID);
    const page = readPage(db, sessionID, opts);
    db.exec("commit");
    return { ...page, meta };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * 乐观提交：仅当水位仍等于折叠开始时的 expectedSeq 才落盘。
 *
 * 折叠本身（~50ms 到 ~2s，见 bootstrap 侧的实测口径）不持锁；只有这一段 commit 持
 * `begin immediate`，微秒级，因此流式写入永不会被折叠阻塞。水位已推进就说明有更新的
 * 写入落地，此次产物必须**丢弃**而不是改盖 revision —— 行是按 expectedSeq 的状态折出来的，
 * 用新 revision 盖章就是 false-fresh，正是 watermark 存在要防的那件事。丢弃后由调用方
 * 有界重排（见 bootstrap 侧 MAX_CONSECUTIVE_DISCARDS）。
 *
 * 落盘用后缀 diff：从第一个 payload 不同的下标起删除并重插。流式追加因此只重写尾部，
 * 无变化的重折叠重写 0 行 —— 这是 spec「只重算受影响的行」在存储层能做到的最细粒度
 * （行本身无法按 turn 隔离重算，原因见 bootstrap builder 的注释）。
 */
export function commitIfCurrent(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    expectedSeq: number;
    revision: string;
    schemaVersion: number;
    rows: readonly StoredProjectionRow[];
  },
): { committed: boolean; rewritten: number } {
  db.exec("begin immediate");
  try {
    const current = readWatermark(db, input.sessionID);
    if (current !== input.expectedSeq) {
      db.exec("rollback");
      return { committed: false, rewritten: 0 };
    }
    const existing = readRows(db, input.sessionID);
    const next = input.rows;
    // schema_version 升位时必须整表重写：后缀 diff 只比 payload 字节，两版格式恰好相同的行
    // 会被留下，于是「升位即让旧行失效」这条规则就有了漏洞。读一次 meta 换掉这个漏洞是值得的
    // ——它只在版本号真的不同时改变行为，而版本号不变时这是一次主键单行读。
    const existingMeta = readMeta(db, input.sessionID);
    let firstDiff = 0;
    if (existingMeta === null || existingMeta.schemaVersion === input.schemaVersion) {
      const shared = Math.min(existing.length, next.length);
      while (firstDiff < shared && existing[firstDiff]!.payload === next[firstDiff]!.payload) {
        firstDiff += 1;
      }
    }
    if (firstDiff < existing.length) {
      db.prepare("delete from conv_projection_row where session_id = ? and seq >= ?").run(
        input.sessionID,
        firstDiff,
      );
    }
    if (firstDiff < next.length) {
      const insert = db.prepare(
        `
        insert into conv_projection_row (session_id, row_id, turn_id, kind, payload, seq)
        values (?, ?, ?, ?, ?, ?)
        `,
      );
      for (let seq = firstDiff; seq < next.length; seq += 1) {
        const row = next[seq]!;
        insert.run(input.sessionID, row.rowId, row.turnId, row.kind, row.payload, seq);
      }
    }
    db.prepare(
      `
      insert into conv_projection_meta (session_id, revision, schema_version, updated_at)
      values (?, ?, ?, ?)
      on conflict(session_id) do update set
        revision = excluded.revision,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at
      `,
    ).run(input.sessionID, input.revision, input.schemaVersion, Date.now());
    db.exec("commit");
    return { committed: true, rewritten: next.length - firstDiff };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * 删除 meta + rows，**保留 watermark**。
 *
 * delete-on-uncertain 的落点（revert/fork：有界尾部选不出版本正确的活跃分支，
 * 见 v4-bridge.ts 拒绝 messagesTail 的实测注释），以及 schema_version 不匹配时的清场。
 * watermark 必须活下来：revision 不能倒退，否则客户端手里的 minRevision 永远满足不了。
 */
export function deleteProjection(db: DatabaseSync, sessionID: SessionId): void {
  db.exec("begin immediate");
  try {
    db.prepare("delete from conv_projection_row where session_id = ?").run(sessionID);
    db.prepare("delete from conv_projection_meta where session_id = ?").run(sessionID);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
