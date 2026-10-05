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
  return items.filter((item) => !isSideChatTitle(item.title));
}

/**
 * Check if an item is a side chat.
 */
export function isSideChat<T extends { title: string }>(item: T): boolean {
  return isSideChatTitle(item.title);
}

/**
 * 标题层面的判定。单独导出是因为 "把副屏提升为正式会话" 必须在**写索引之前**知道
 * 当前标题是不是这个占位串：过滤器是标题制的，只翻 task_type 而不换标题的话，
 * 提升后的会话会先被写进 tasks-index、再被 excludeSideChats 原样滤掉，
 * 用户看到的就是 "点了没反应"。
 */
export function isSideChatTitle(title: string | null | undefined): boolean {
  return (title ?? "").trim() === SIDE_CHAT_TITLE;
}
