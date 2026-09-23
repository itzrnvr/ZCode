// Side-chat task filter.
// New file — no upstream merge conflict risk.
// Keeps "Selection side chat" sessions out of the main task list
// without modifying SQL queries in taskIndexRepo.ts.

const SIDE_CHAT_TITLE = "Selection side chat";

/**
 * Generic filter: exclude side-chat entries from any list of items with a `title` field.
 * Works on both ZCodeTaskMeta and raw TaskIndexRow.
 */
export function excludeSideChats<T extends { title: string }>(items: T[]): T[] {
  return items.filter((item) => item.title !== SIDE_CHAT_TITLE);
}

/**
 * Check if an item is a side chat.
 */
export function isSideChat<T extends { title: string }>(item: T): boolean {
  return item.title === SIDE_CHAT_TITLE;
}
