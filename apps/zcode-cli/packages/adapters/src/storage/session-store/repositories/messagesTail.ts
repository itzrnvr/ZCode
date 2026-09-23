// Tail-loading function for session messages+parts.
// New file — no upstream merge conflict risk.
// Loads only the last N parts + their parent messages, instead of
// loading ALL parts (which can be 22K+ rows for large sessions).

import type { DatabaseSync } from "node:sqlite";
import type {
  MessageId,
  MessagePart,
  MessageWithParts,
  SessionId,
} from "@zcode/contracts";
import { decodeMessageRow, decodePartRow } from "../codecs.js";
import type { MessageRow, PartRow } from "../rows.js";

export async function messagesTail(
  db: DatabaseSync,
  input: { sessionID: SessionId; limit: number },
): Promise<MessageWithParts[]> {
  // 1. Load the last N parts (by id DESC for fast index scan, then reverse for chronological order)
  const partRows = (db
    .prepare(
      "SELECT * FROM part WHERE session_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(input.sessionID, input.limit) as unknown as PartRow[]).reverse();

  if (partRows.length === 0) {
    // Fallback: no parts at all — load messages without parts (edge case for new sessions)
    const messageRows = db
      .prepare(
        "SELECT * FROM message WHERE session_id = ? ORDER BY sequence is null, sequence, time_created, rowid",
      )
      .all(input.sessionID) as unknown as MessageRow[];
    return messageRows.map((row) => ({
      info: decodeMessageRow(row),
      parts: [],
    }));
  }

  // 2. Get unique message IDs from the tail parts (preserve order)
  const messageIds = [...new Set(partRows.map((r) => r.message_id))];
  const placeholders = messageIds.map(() => "?").join(", ");

  // 3. Load only those messages (much fewer than all 6K+)
  const messageRows = db
    .prepare(
      `SELECT * FROM message WHERE session_id = ? AND id IN (${placeholders}) ORDER BY sequence is null, sequence, time_created, rowid`,
    )
    .all(input.sessionID, ...messageIds) as unknown as MessageRow[];

  // 4. Group parts by message (same logic as messages() in messages.ts)
  const partsByMessage = new Map<string, MessagePart[]>();
  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }

  // 5. Return messages with their tail parts (messages without parts in the tail get [])
  return messageRows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}
