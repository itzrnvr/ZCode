// 0023: Performance indexes for session loading.
// Adds covering indexes that eliminate TEMP B-TREE sorts on the hot
// message and part loading paths. Reduces largest-session load from
// ~1.3s to <100ms by avoiding full-table sorts.

export const PERF_COVERING_INDEXES_MIGRATION_SQL = `
-- Covering index for parts: matches ORDER BY message_id, sequence, time_created, id
-- Eliminates "USE TEMP B-TREE FOR LAST 4 TERMS OF ORDER BY" on the parts query.
CREATE INDEX IF NOT EXISTS part_session_full_order_idx
  ON part(session_id, message_id, sequence, time_created, id);

-- Covering index for messages: matches ORDER BY sequence, time_created
-- Eliminates "USE TEMP B-TREE FOR ORDER BY" on the messages query.
CREATE INDEX IF NOT EXISTS message_session_full_order_idx
  ON message(session_id, sequence, time_created, id);

-- Fast tail lookup: ORDER BY id DESC LIMIT N (for paginated initial load)
CREATE INDEX IF NOT EXISTS part_session_tail_idx
  ON part(session_id, id DESC);
`;
