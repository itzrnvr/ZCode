// 0024: 会话投影的持久化快路径（conversation projection store）。
// 冷开一个 22515 part 的会话实测 11216ms 到首屏，其中 4663ms 是 app.resume() 的运行时构造、
// 2280ms 是从 500 条尾部消息派生行 —— 两者都不在磁盘 I/O 上（裸尾读本身 1307ms -> 16ms）。
// 把「行」在写入时就增量物化下来，view 路径便能只读 SQLite 直接出首屏：不激活 runtime、
// 不读 transcript、不产生 agent 往返。三张表：meta 记水位，row 记行，watermark 记写入序号。
//
// watermark 单独成表是必需的，不是冗余：事件序列在本仓从未持久化
// （SessionEventStorePort 只有 InMemorySessionEventStore 一个实现，0001-0023 无 event 表），
// 而 max(message.sequence) / max(part.id) 对「同毫秒原地更新」是盲的 —— 恰好就是
// persistAssistantMessage 写 time.completed 的那次 turn 收尾更新。用它做新鲜度判定会
// false-fresh，把缺终态的行当成最新行发出去。

/**
 * 行 payload 的格式版本。三段 revision 的第三段，同时落进 meta.schema_version。
 * 升位即让所有旧行以 `partial` 失效重建：旧格式的行绝不会被发出去。
 */
export const CONV_PROJECTION_SCHEMA_VERSION = 1;

export const CONVERSATION_PROJECTION_MIGRATION_SQL = `
-- 水位：一次会话写入 +1，永不回退，且独立于 meta 存活。meta 会被 delete-on-uncertain
-- 清掉（revert/fork 分支不可由有界尾部重建），watermark 不能跟着清 —— 否则 revision 会
-- 倒退，客户端手里的 minRevision 就成了一个再也无法满足的值。
CREATE TABLE IF NOT EXISTS conv_projection_watermark (
  session_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

-- 投影元信息：revision 三段 = session.time_updated : watermark.seq : schema_version。
CREATE TABLE IF NOT EXISTS conv_projection_meta (
  session_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 行本体：payload = 当前 v4 投影逐字发出的 ConversationRow（rows.ts 的 9 元可辨识联合）。
-- seq 是折叠产物数组下标（0 起），PRIMARY KEY(session_id, seq) 让「尾部一页」和「后缀替换写」
-- 都走主键顺序；row_id 另建索引服务 beforeRowId 游标 —— 行序恒为 rowId 升序，所以
-- seq 升序与 row_id 升序是同一条序，游标翻页不必回表排序。
CREATE TABLE IF NOT EXISTS conv_projection_row (
  session_id TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS conv_projection_row_cursor_idx
  ON conv_projection_row(session_id, row_id);
`;
