// 冷恢复缓存的**判定面**（issue #4 门槛修正）：`loadPersistedEvents` 里"能不能用缓存、
// 用不用得上、命中时贴什么 overlay"这一小段被抽成本模块，唯一理由是它必须能被真实顺序驱动
// 测试（resume 先往内存 event store 追加生命周期事件，hydration 再读那份 store），而不是
// 只在 v4-bridge 的巨大闭包里靠计时间接证明。
//
// 与 #42 的差别集中在三处，都是承重的：
// 1. 门槛：从"活事件条数 === 0"改成"活事件只允许是 resume 生命周期事件"（见
//    cold-hydration-cache.ts 文件头）。出现任何别的类型就整条绕过，一个字都不缓存。
// 2. 载荷：只存 transcript 合成结果（`durableEvents`），不含 live overlay —— 生命周期事件
//    的重数每次 resume 都会涨，写进载荷第二次开就错。
// 3. 写前复核：合成期间指纹输入被并发写入改变就不写（seqlock）。
//
// 这里只做判定与组装，不碰 runtime：指纹读三个 store 主键面（getSession/readTarget/
// sessionEntries），与 v4-bridge.ts 的 hydration 逐项同口径；`contextWindow` 与 `transcriptScope`
// 都由调用方解好传进来，保证指纹与合成/usageSeed 用的是同一份输入。本模块因此**天生不依赖
// record**：record-less 的视图冷物化只要传得出一档位就能用同一套判定（传不出就按
// context-window-unresolved 整条绕过，绝不伪造 20 万）。
//
// 视图路径当前刻意不参与缓存（v4-bridge.ts 的 loadPersistedEventsWithoutRecord 在判定之前就返回）：
// 它的档位来自另一条推导（resolvePersistedSessionModelContextWindow），与 record 路径不同时键就
// 永不可达，相同时又与升级后那次重建写的条目重复；而缓存只有 16 格 LRU
// （cold-hydration-cache.ts:126），塞进不可达条目会挤掉可达的。要改这条决定，先回答这三点。
//
// 命中路径的最终事件 = 缓存里的 durable 合成结果 + 当前 live overlay，经
// `finalizeColdConversationEvents`（cold-event-merge.ts，与 miss 路径同一段收尾）重排，
// 因此"命中 = 未命中"是构造出来的。

import { type SessionEvent, type SessionId } from "@zcode/contracts";
import {
  finalizeColdConversationEvents,
  SHARED_CONTEXT_IMPORT_ENTRY_TYPE,
  type ConversationMaterializationSource,
} from "./cold-event-merge.js";
import {
  classifyColdHydrationLiveEvents,
  coldHydrationCheckpointDigest,
  coldHydrationFingerprint,
  readColdHydrationCache,
  type ColdHydrationTranscriptScope,
} from "./cold-hydration-cache.js";
import type { SessionUsageSeed } from "./product-projection.js";
import { goalVerificationEntriesFromSessionEntries } from "./transcript-hydration.js";

/**
 * 三个结果各一条 info 级标记（生产 minLevel=Info，debug 只在 development 落盘；见
 * adapters/logging/index.ts:226-228）。字段形状与既有 `phase: "loadPersistedEvents"` 日志一致：
 * `event` 是稳定可 grep 的 ASCII 名，`message` 给人看，附 `sessionId`/`phase`，绝不带载荷内容。
 */
export const COLD_HYDRATION_CACHE_LOG = {
  bypassed: {
    event: "zcode_protocol.v4.cold_hydration_cache_bypassed",
    message: "ZCode Protocol v4 cold hydration cache bypassed",
  },
  hit: {
    event: "zcode_protocol.v4.cold_hydration_cache_hit",
    message: "ZCode Protocol v4 cold hydration cache hit",
  },
  missWritten: {
    event: "zcode_protocol.v4.cold_hydration_cache_miss_written",
    message: "ZCode Protocol v4 cold hydration cache miss written",
  },
} as const;

export type ColdHydrationCacheBypassReason =
  /** store 缺席（in-memory/测试宿主）：指纹读不出来，不猜。 */
  | "no-store"
  /** 活事件里出现非 resume 生命周期事件：合成/用量不再可复原。 */
  | "live-events"
  /** 目录解不出 contextWindow：指纹里那一项会是 null，宁可整条绕过。 */
  | "context-window-unresolved"
  /** 合成期间指纹输入被并发写入改变：这次不写，等下一次开合重新算。 */
  | "inputs-changed";

/** 缓存载荷：只有 transcript 合成结果与它自己的来源标记（见 cold-hydration-cache.ts 文件头）。 */
export interface ColdHydrationCachePayload {
  /** transcript 合成结果（未重排、不含 live overlay）。 */
  durableEvents: SessionEvent[];
  /** 与 miss 路径写出的同一个提前导入元数据；entry 原始 data 已在指纹里。 */
  sharedContextImport?: ConversationMaterializationSource["sharedContextImport"];
  synthesized: boolean;
  usageSeed: SessionUsageSeed | null;
}

export type ColdHydrationCachePlan =
  | {
      kind: "bypass";
      liveEventTypes?: string[];
      reason: ColdHydrationCacheBypassReason;
    }
  | { kind: "miss"; fingerprint: string; overlay: SessionEvent[] }
  | {
      kind: "hit";
      events: SessionEvent[];
      fingerprint: string;
      overlay: SessionEvent[];
      payload: ColdHydrationCachePayload;
    };

/** 判定只用到 store 的三个廉价读面；完整 SessionStorePort 结构上自然满足。 */
export interface ColdHydrationCacheStore {
  getSession(sessionID: SessionId): Promise<ColdHydrationCacheSessionRow | null>;
  readTarget(input: { sessionID: SessionId }): Promise<ColdHydrationCacheTarget | null>;
  sessionEntries?(input: { sessionID: SessionId }): Promise<ColdHydrationCacheSessionEntry[]>;
}

interface ColdHydrationCacheSessionRow {
  revert?: unknown;
  time: { updated: number };
  title?: string;
}

interface ColdHydrationCacheTarget {
  time: { updated: number };
}

interface ColdHydrationCacheSessionEntry {
  data: unknown;
  time: { created: number };
  type?: string;
}

export interface ColdHydrationCachePlanInput {
  /** 由调用方按 workspace-model-runtime.ts:133-141 解出的当前档位；命中与 miss 必须同值。 */
  contextWindow: number | undefined;
  /** 与 loadPersistedEvents 的 events 同一份（含 workflow journal 前置的事件）。 */
  events: readonly SessionEvent[];
  sessionId: string;
  store: ColdHydrationCacheStore | undefined;
  /**
   * 合成将消费哪一份 transcript，由调用方按 materialization 自己的那个分支给出
   * （cold-event-merge.ts:86-88：`persistedMessages?.length` 非空即用尾读，否则回落全量）。
   * 判据必须与 materialization 逐字相同，否则键描述的输入就不是真正被合成的输入。
   */
  transcriptScope: ColdHydrationTranscriptScope;
}

export async function planColdHydrationCache(
  input: ColdHydrationCachePlanInput,
): Promise<ColdHydrationCachePlan> {
  const live = classifyColdHydrationLiveEvents(input.events);
  if (!live.cacheable) {
    return { kind: "bypass", liveEventTypes: live.liveEventTypes, reason: "live-events" };
  }
  if (!input.store) return { kind: "bypass", reason: "no-store" };
  // 指纹里 contextWindow 只有"解出/未解出"两种命运；未解出就整条绕过，
  // 不写一份要靠 null 才能命中的条目（那等于把"目录暂时读不到"冻成缓存语义）。
  if (input.contextWindow === undefined) {
    return { kind: "bypass", reason: "context-window-unresolved" };
  }
  const fingerprint = await readFingerprint(input);
  const payload = readColdHydrationCache<ColdHydrationCachePayload>(input.sessionId, fingerprint);
  if (!payload) return { kind: "miss", fingerprint, overlay: live.overlay };
  return {
    kind: "hit",
    // 与 miss 路径同一段收尾：缓存只带 transcript 合成结果，live overlay 用当前这一份现贴。
    events: finalizeColdConversationEvents({
      durableEvents: payload.durableEvents,
      trailingEvents: live.overlay,
    }),
    fingerprint,
    overlay: live.overlay,
    payload,
  };
}

/**
 * 写前复核（seqlock 式）：合成期间指纹输入可能被并发写入改变 —— resume 的 transcript 尾读
 * 与这次指纹读之间也有窗口，materialization 自己还会再读一次 session/entry。对不上就不写：
 * 宁可这次不缓存，也不能把一份"输入已变"的载荷挂到旧键上（那才是唯一可能返回错行的路径）。
 */
export async function isColdHydrationCacheFingerprintCurrent(
  input: ColdHydrationCachePlanInput & { fingerprint: string },
): Promise<boolean> {
  if (!input.store || input.contextWindow === undefined) return false;
  return (await readFingerprint(input)) === input.fingerprint;
}

/** 三个廉价读面 + 与 v4-bridge.ts:1826-1842 同口径的指纹。 */
async function readFingerprint(input: ColdHydrationCachePlanInput): Promise<string> {
  const store = input.store as ColdHydrationCacheStore;
  const sessionID = input.sessionId as SessionId;
  const [session, target, entries] = await Promise.all([
    store.getSession(sessionID),
    store.readTarget({ sessionID }),
    // 与 v4-bridge.ts:1830-1832 同约定：entry 读取故障按空处理，不让指纹的廉价读拖垮整次 hydration。
    store.sessionEntries
      ? store.sessionEntries({ sessionID }).catch(() => [])
      : Promise.resolve([]),
  ]);
  return coldHydrationFingerprint({
    contextWindow: input.contextWindow,
    goalVerificationEntries: goalVerificationEntriesFromSessionEntries(entries),
    revert: session?.revert ?? null,
    sessionId: input.sessionId,
    sharedContextEntry: sharedContextEntryData(entries),
    targetUpdatedAt: target?.time.updated,
    title: session?.title ?? null,
    transcriptScope: input.transcriptScope,
    transcriptWatermark: session?.time.updated,
    // checkpoint 的内容指纹从**这批活事件**推出来，不额外读 entry：它要钉住的正是
    // buildColdFileChangeSummaries 的输入，而那份输入就是这里的 input.events。
    workspaceCheckpoints: coldHydrationCheckpointDigest(input.events),
  });
}

/**
 * `v4/shared_context_import` entry 的原始 data（没有就是 null）。materialization 的
 * `sharedContextImport` 推导（cold-event-merge.ts:92-121）只看这一条 entry 加标题加消息，
 * 标题与消息在指纹里；entry 不推进水位，所以把它的原始 data 也放进指纹，
 * 否则 pending/attached/discarded 的变化会命中一份过期的 handover 元数据。
 */
function sharedContextEntryData(entries: readonly ColdHydrationCacheSessionEntry[]): unknown {
  return entries.find((entry) => entry.type === SHARED_CONTEXT_IMPORT_ENTRY_TYPE)?.data ?? null;
}
