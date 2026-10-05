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
 * ## 什么时候可以命中：活事件里只允许 resume 生命周期
 *
 * #42 的第一版门槛是"活事件条数 === 0"。那条门槛在真实冷开上**永远判否**：冷开先
 * `record.app.resume()`，而 `resumeFromStore` 会往同一个内存 event store 追加
 * `SessionResumed`（core/runtime/methods/resume.ts:253）与带标题时的 `SessionTitleUpdated`
 * （:352），随后 hydration 才来读这份 store（v4-gateway.ts:2907-2913 → v4-bridge.ts:1805）。
 * 沙箱日志里冷开的 `sourceEventSeq=2` 就是这两条。于是 #42 的缓存从未真正读写过一次。
 *
 * 修正后的门槛（`classifyColdHydrationLiveEvents`）：活事件只允许是**resume 每次重新追加的
 * 生命周期事件**（`COLD_HYDRATION_LIVE_OVERLAY_EVENT_TYPES`）。这三条理由都是承重的：
 *
 * 1. 这类事件在合并里**只走尾部补充**（`MEMORY_ONLY_EVENT_TYPES` → trailing supplements，
 *    cold-event-merge.ts:881-884），不参与 turn 权威判定（`memoryAuthorityTurnIds` 只看
 *    TurnStarted/TurnComplete，:277-314）、不做 turn 边界插入（`durableBoundaryKeyForEvent`
 *    只认 compaction/fork/goal，:488-507）、不进 hook 归类。所以合并结果 =
 *    `resequence([...durableEvents, ...lifecycle])`，可以被**同一段收尾代码**
 *    （cold-event-merge.ts `finalizeColdConversationEvents`）在命中路径逐字节复原。
 * 2. 它的**重数**每次 resume 都 +1，因此绝不能进缓存载荷（会让第二次开就错），也绝不能进
 *    指纹（否则每次 resume 都自失效，永远命中不了）。命中路径用当前 live 的那一份现贴。
 * 3. 零活事件仍然走 `coldHydrationCacheable(0)`：语义完全一致，只是不再是唯一入口。
 *
 * 其他任何活事件（turn 事件、hook、boundary、`RewindTriggered`、`PermissionRequested`
 * 之类的 memory-only、以及 workflow journal 重放）一律整条绕过：宁可多读一次，也不能拿一份
 * 可能已过期的 artifact 摘要或用量冒充权威。
 *
 * ## usageSeed 为什么可以随载荷一起缓存（不是"已知未知"）
 *
 * `usageSeed` 在 #42 里没有进指纹，命中时直接返回缓存值。它在门槛内的状态下是**指纹输入的
 * 纯函数**，链路逐步可查：
 *
 * - `readSessionContextUsage` 的三项输入在门槛内全部退化：`events.filter(RewindTriggered)`
 *   为空（白名单）；`latestContextUsageBreakdownFromEvents` 需要 `ModelComplete`（白名单阻挡）
 *   → breakdown 恒无；`projection` 由 `rebuildProjection() = eventReducer.reduce(store 事件)`
 *   得来（core/runtime/methods/config.ts:312-313），而 resume 生命周期事件既不写
 *   `contextUsed`（只有 `ModelComplete`，contracts/events/event-reducer.ts:223）也不写
 *   `contextWindow`（只有 `SessionCreated`，:104）→ 投影停在初值 `contextUsed: 0`、
 *   `contextWindow: 200000`（event-reducer-helpers.ts:32-33）。
 * - `contextUsageFromProjection` 因此返回 undefined（守卫要求 `contextUsed > 0` 且
 *   `contextWindow > 0`，session-mapper.ts:713-726），用量只剩 `contextUsageFromPersistedMessages
 *   (messages, 200000)` 这一路：`used`/`cache` 只来自 transcript，`size`(=window) 又被
 *   `sessionUsageSeedFromRuntimeContextUsage` 丢掉，窗口只留下"是否 > 0"这一个开关
 *   （session-mapper.ts:728-734）。
 * - `messages = projectActiveSessionMessages(source.messages, session, [])` 只用
 *   `session.revert` 的三个 id（server-operations.ts:3916-3941），而 revert 就是指纹输入。
 * - `maxTokens = contextWindowOverride` 正是指纹里那个 `contextWindow`。
 *
 * 所以 `usageSeed = f(transcript, revert, contextWindow)`，三项都被指纹钉住。换成别的模型
 * 窗口只会改 `maxTokens`（已在指纹里）；换成别的投影来源才会破这条论证，而那必然带着
 * `ModelComplete`/`SessionCreated` 活事件 → 白名单判否 → 根本不走缓存。
 *
 * ## 失效
 *
 * 键是"参与合成的非 transcript 输入"的完整 JSON（不是哈希：漏一个输入就等于可能返回错
 * 内容，字符串全等是一眼可审的）。`session.time_updated` 由 `touchSession` 在**每次
 * message/part 写入**时推进（saveMessage / savePart 都调它），一次主键读 0.006ms。session
 * entry 不走 `touchSession`，所以合成用到的 entry 一类不落：`goalVerificationEntries` 与
 * `sharedContextEntry`（v4/shared_context_import 的原始 data）都在指纹里。任何一项对不上就是
 * miss，回落全量路径——缓存只会让人变慢，绝不会返回错内容。
 *
 * 进程内缓存：不开新文件、不改 schema、不写用户数据。代价是重启后首次打开仍是 miss。
 */

import { SessionEventType, type SessionEvent } from "@zcode/contracts";

export interface ColdHydrationFingerprintInput {
  contextWindow: number | undefined;
  goalVerificationEntries: readonly unknown[];
  revert: unknown;
  sessionId: string;
  /**
   * `v4/shared_context_import` entry 的原始 data（没有就是 null）。session entry 不推进
   * `session.time_updated`，只靠水位盖不住它的 pending/attached/discarded 变化，而
   * `sharedContextImport` 是缓存载荷的一部分。
   */
  sharedContextEntry: unknown;
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
    input.sharedContextEntry ?? null,
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
 * 完全没有活事件：合成与 usageSeed 都是 transcript 的纯函数（#42 原始门槛，保留为最干净的
 * 那条分支；见文件头「什么时候可以命中」）。
 */
export function coldHydrationCacheable(liveEventCount: number): boolean {
  return liveEventCount === 0;
}

/**
 * 活事件里唯一允许留在 live 侧的一类：resume 每次冷开都会重新追加、且只作为尾部补充进入
 * 合并结果的生命周期事件（见文件头第 1 条）。加入任何其他类型前先证明它能被尾部补充复原。
 */
export const COLD_HYDRATION_LIVE_OVERLAY_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set([
  SessionEventType.SessionResumed,
  SessionEventType.SessionTitleUpdated,
]);

export type ColdHydrationLiveEvents =
  | { cacheable: true; overlay: SessionEvent[] }
  | { cacheable: false; liveEventTypes: string[] };

/**
 * 判定这批活事件能否走缓存，并给出命中路径要现贴的 overlay（live 顺序原样保留：合并的尾部
 * 补充就是这个顺序，cold-event-merge.ts:790-899）。
 */
export function classifyColdHydrationLiveEvents(
  events: readonly SessionEvent[],
): ColdHydrationLiveEvents {
  if (coldHydrationCacheable(events.length)) return { cacheable: true, overlay: [] };
  const offending = new Set<string>();
  for (const event of events) {
    if (!COLD_HYDRATION_LIVE_OVERLAY_EVENT_TYPES.has(event.type)) offending.add(event.type);
  }
  if (offending.size === 0) return { cacheable: true, overlay: [...events] };
  return { cacheable: false, liveEventTypes: [...offending].sort() };
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
