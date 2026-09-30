/**
 * 冷恢复事件缓存（issue #4 的剩余杠杆）。
 *
 * 冷恢复把整份 transcript 读进内存、JSON 解析、再合成事件：实测 22 809 part 的会话读
 * 639ms + 合成 64ms，最终只剩 834 行、1.63MB 事件——**98.8% 读进来的字节从未变成行**。
 * 这一层此前没有任何缓存，每次开合都重付。
 *
 * ## 缓存什么、为什么不是 transcript
 *
 * 候选只有两个，实测同一会话：
 *
 * | 缓存内容 | 体积 | 命中 | 未命中额外成本 |
 * |---|---|---|---|
 * | 整份 transcript | 66.4 MB | 304ms 解析 | **+347ms 序列化（净亏）** |
 * | 合成结果（事件） | 1.63 MB | **8ms 解析** | +19ms 序列化 |
 *
 * 整份 transcript 那条被实测否掉了：写进去比省下的还多。所以缓存合成结果。
 *
 * ## 为什么不碰 rowId 契约
 *
 * 缓存存的是**事件**而不是行，折叠照旧发生。事件重放是确定性的——同一串事件经同一个
 * reducer 折叠出的行逐字节一致（实测 834 vs 834 完全相同，含 rowId）。所以这条路径不改
 * 变 rowId 的任何语义，也不碰冻结的 wire schema。
 *
 * ## 什么时候可以命中
 *
 * 只有**没有活事件**时才用（`coldHydrationCacheable`）。两个理由，都是承重的：
 *
 * 1. `buildColdFileChangeSummaries` 遍历 `workspaceCheckpoints(input.events)`，事件为空时
 *    它一次 artifact 都不读，于是合成退化成 `(transcript, target, contextWindow,
 *    goalVerificationEntries)` 的纯函数——这四项都能用一次主键读拿到廉价指纹。
 * 2. `usageSeed` 会混进 live event store 的用量；事件为空时那一路是空的，所以 usageSeed
 *    同样退化成纯函数，一并缓存才是安全的。
 *
 * 事件非空就整条绕过：宁可多读一次，也不能拿一份可能已过期的 artifact 摘要或用量冒充权威。
 *
 * ## 失效
 *
 * 键是"参与合成的非 transcript 输入"的完整 JSON（不是哈希：漏一个输入就等于可能返回错
 * 内容，字符串全等是一眼可审的）。`session.time_updated` 由 `touchSession` 在**每次
 * message/part 写入**时推进（saveMessage / savePart 都调它），一次主键读 0.006ms。任何
 * 一项对不上就是 miss，回落全量路径——缓存只会让人变慢，绝不会返回错内容。
 *
 * 进程内缓存：不开新文件、不改 schema、不写用户数据。代价是重启后首次打开仍是 miss。
 */

export interface ColdHydrationFingerprintInput {
  contextWindow: number | undefined;
  goalVerificationEntries: readonly unknown[];
  revert: unknown;
  sessionId: string;
  targetUpdatedAt: number | undefined;
  title: string | null | undefined;
  /** session.time.updated —— transcript 水位。 */
  transcriptWatermark: number | undefined;
}

export function coldHydrationFingerprint(input: ColdHydrationFingerprintInput): string {
  return JSON.stringify([
    input.sessionId,
    input.transcriptWatermark ?? null,
    input.revert ?? null,
    input.title ?? null,
    input.targetUpdatedAt ?? null,
    input.contextWindow ?? null,
    input.goalVerificationEntries,
  ]);
}

// 载荷形状由调用方拥有（bridge 用它自己的具名类型），这里只做键控存取，不猜结构。
interface CacheEntry<T> {
  fingerprint: string;
  payload: T;
}

// 动态键 + 插入序 + 容量上限 + 淘汰 ⇒ Map，而不是 Record。
const MAX_ENTRIES = 16;
const cache = new Map<string, CacheEntry<unknown>>();

/**
 * 只有没有活事件时才允许用缓存（见文件头「什么时候可以命中」）。事件非空时合成要读
 * artifact 摘要、usageSeed 要读 live 用量，两者都没有廉价水位。
 */
export function coldHydrationCacheable(liveEventCount: number): boolean {
  return liveEventCount === 0;
}

export function readColdHydrationCache<T>(
  sessionId: string,
  fingerprint: string,
): T | null {
  const hit = cache.get(sessionId);
  // 水位不符就是没有：宁可重算，也不返回一份对应旧 transcript 的行。
  if (!hit || hit.fingerprint !== fingerprint) return null;
  return hit.payload as T;
}

export function writeColdHydrationCache<T>(
  sessionId: string,
  fingerprint: string,
  payload: T,
): void {
  // 重新插入以刷新淘汰序。
  cache.delete(sessionId);
  cache.set(sessionId, { fingerprint, payload });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
