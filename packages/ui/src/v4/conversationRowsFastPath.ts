// v4 冷会话「快绘行」读取面（renderer 侧客户端 + 预取缓存）。
//
// 为什么存在：冷开一个 22 515 part 的会话要 11 216 ms 才见到首行，其中 4 663 ms 是
// app.resume() 的运行时构造、2 280 ms 是 hydration（common.md 实测基线）。而
// `conversationRows` 走 CLI 侧 server.ts 的**直接派发**（不经 requireV4Gateway，
// 因此不触发 activation），DB 侧只是 messagesTail（同一读法在 22K part 会话上
// 实测 1307 ms -> 16 ms）。所以首绘的关键路径可以从「等 activation + hydration」
// 变成「一次 RTT + 一次 JSON 反序列化」。
//
// 反序列化不是免费的：实测一个 60 行 snapshot 帧在 renderer 的 `(program)` 自耗时
// 579 ms（tight-e2e-base.json，同一次运行 busyMs 只有 410、idlePct 92.5%）。
// 因此本模块把 limit 钉在 `snapshotTailWindowRows`（60）而不用协议允许的 200 上限：
// 行数与权威 snapshot 窗口一致，既让反序列化成本与今天持平，也让
// 「临时行 -> 权威 snapshot」的替换在视觉上是同一批行。
//
// 硬约束（来自 projection lane 的契约与 product-projection.ts 实测）：
// - 快绘行**没有**任何水位（无 atSeq/atRevision/atLogEpoch）：仓库里根本没有持久化的
//   event sequence（SessionEventStorePort 只有 InMemorySessionEventStore，
//   migrations 0001-0023 无 event 表）。所以这些行永远不能当 delta base
//   （store 要求 frame.fromSeq === snapshot.seq），也永远不能拿去发
//   fileChanges / fileRewindPreview / plans 这类按水位取值的只读查询。
// - `rowId` 是 product-projection 的计数器（nextRowId++，:5240-5252），不是持久键。
//   跑过 hook 的会话里快绘 rowId 与权威 rowId 会整体错位（hookInvocation 行没有
//   durable 合成点）。稳定键是 `entityId`，分组键是 `turnId`。
// - 因此本模块只做「读 + 判新鲜 + 去重 + 缓存」，绝不合并两套行；替换是整体丢弃。
//
// 类型全部从协议包派生，不在 renderer 侧复制一份：失败原因闭集与结果形状都由
// projection lane 在 packages/shared 里定义，改动了这里就编译不过（这是刻意的）。
//
// 「快绘窗口为什么是权威 snapshot 的子集」的权威粗粒度清单是 bootstrap 侧的
// `COLD_VIEW_DEFERRED_SOURCES`（apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/
// cold-session-resume.ts:63-71，类型 ColdDeferredSource :73，经 v4-bridge.ts:1655 以
// `deferredColdSources` 上线）。packages/ui 不得 import bootstrap，所以这里只按名字引用，
// 并把七个字面量抄在下面，便于将来肉眼 diff（改名会 grep 得到，不会静默漂移）：
//   memoryEvents / workflowRunReplay / fileChangeArtifacts / modelContextWindow /
//   configSeed / usageSeed / subagentProjection
// 行级的映射（9 种 kind 里哪一种真的会在替换时新增、哪些字段缺席）不在那个常量里，
// 结论是：只有 `hookInvocation` 会在替换时真的多出来；`artifact` 与 `toolCall.outputPreview`
// 在权威冷 snapshot 里同样缺席，所以不会有「内容弹入」。
import type {
  ConversationRow,
  V4ConversationRowsResult,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";

/** 一次快绘读取的结果；与协议同形，不另造一份（避免两边闭集漂移）。 */
export type ConversationRowsFastOutcome = V4ConversationRowsResult;

/** CLI 侧 `conversationRows` 的闭集失败原因，从协议结果类型反推。 */
export type ConversationRowsUnavailableReason = Extract<
  ConversationRowsFastOutcome,
  { ok: false }
>["reason"];

/** 对一次 outcome 的裁决：接受、重试一次、还是回落到今天的 subscribe 路径。 */
export type ConversationRowsFastDecision = "accept" | "retry" | "fallback";

// 只有这两个原因是「还没好」（后台折叠在跑 / 存储 revision 落后），其余都是
// 「这条路走不通」，重试只会白付一次 RTT + 反序列化。
const RETRYABLE_CONVERSATION_ROWS_REASONS: Partial<
  Record<ConversationRowsUnavailableReason, true>
> = {
  building: true,
  stale: true,
};

/** 与权威 snapshot 窗口同宽；见文件头对 579 ms 反序列化的说明。 */
export const FAST_PATH_ROW_LIMIT = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;

/**
 * 重试时刻表（ms）。敢重试的原因是成本不对称：`building` / `stale` 的响应**不含行**，
 * 所以一次重试只花一次很小的 RTT，不花那次实测 ~579 ms 的 JSON 反序列化
 * （tight-e2e-base.json 的 `(program)` 自耗时）。反过来，重试风暴会把 CLI 侧
 * coalesced + single-flighted 的后台折叠压垮，所以上限由这张表的长度决定，不开放配置。
 * 具体档位取决于 durable 折叠的真实耗时（已向 projection lane 询问），改数字不改逻辑。
 */
export const FAST_PATH_RETRY_DELAYS_MS: readonly number[] = [60, 240];

/** 尝试次数上限 = 重试次数 + 1。 */
export const FAST_PATH_MAX_ATTEMPTS = FAST_PATH_RETRY_DELAYS_MS.length + 1;

export function decideConversationRowsOutcome(
  outcome: ConversationRowsFastOutcome,
  attempt: number,
): ConversationRowsFastDecision {
  if (outcome.ok) return "accept";
  if (RETRYABLE_CONVERSATION_ROWS_REASONS[outcome.reason] !== true) return "fallback";
  return attempt + 1 < FAST_PATH_MAX_ATTEMPTS ? "retry" : "fallback";
}

/**
 * 行序与唯一性自检。
 *
 * renderer 不对 RPC 结果做 zod 解析（校验发生在 services 跳，
 * zcodeProtocolClient.ts:331-333），所以畸形响应会直接进到 virtualizer。
 * 重复 rowId 会变成重复 React key，乱序会让 turn 分组算错——两者都按 `partial`
 * 处理并回落，宁可慢也不要错。
 */
export function inspectConversationRows(
  rows: readonly ConversationRow[],
): { ok: true } | { ok: false } {
  let previous: number | null = null;
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.rowId)) return { ok: false };
    seen.add(row.rowId);
    // 契约是 rowId 升序（transport.ts:510 的全序定义）；不升序即视为畸形。
    if (previous !== null && row.rowId <= previous) return { ok: false };
    previous = row.rowId;
  }
  return { ok: true };
}

export interface ConversationRowsFastReadParams {
  sessionId: string;
  /** 只用于「至少这么新」；不可解析、不可数值比较（契约是 3 段字符串）。 */
  minRevision?: string;
  /** 向更早翻页；缺省 = 从当前尾部向前。快绘首屏不用它。 */
  beforeRowId?: number;
  limit?: number;
}

export interface ConversationRowsFastEvent {
  kind: "requested" | "accepted" | "retried" | "fallback" | "malformed";
  sessionId: string;
  attempt: number;
  reason?: ConversationRowsUnavailableReason;
  rowCount?: number;
}

export interface ConversationRowsFastReader {
  /** 读取（同 session 并发合流为一次 in-flight）；永不 reject，失败即 ok:false。 */
  read(params: ConversationRowsFastReadParams): Promise<ConversationRowsFastOutcome>;
  /** 放弃该 session 的 in-flight 归属（pane 关闭 / 换代），不清预取缓存。 */
  cancel(sessionId: string): void;
}

interface FastReaderOptions {
  /** 返回可等待的延迟；测试注入后可手动推进，避免依赖真实计时器（同 agentPrewarm）。 */
  delay?: (ms: number) => Promise<void>;
  onEvent?: (event: ConversationRowsFastEvent) => void;
}

function defaultDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * 传输面缺失即降级。
 *
 * `conversationRows` 在 ConversationTransport 上是**可选成员**，沿用本仓库既有的
 * 「旧 host 可能没有这个方法」写法（transport.ts:152 的 onRuntimeLifecycle?、
 * agentConversationTransport.ts:536 的 onDynamicLocalTtftFacts?.()）。没有
 * host.supports 这类能力探测面，所以缺席本身就是探测结果。
 */
export function createConversationRowsFastReader(
  transport: ConversationTransport,
  options: FastReaderOptions = {},
): ConversationRowsFastReader {
  const delay = options.delay ?? defaultDelay;
  const emit = (event: ConversationRowsFastEvent): void => {
    options.onEvent?.(event);
  };
  const inFlight = new Map<string, Promise<ConversationRowsFastOutcome>>();

  const attemptRead = async (
    params: ConversationRowsFastReadParams,
  ): Promise<ConversationRowsFastOutcome> => {
    // 必须先取到函数再判类型：缺席时这就是探测结果，直接降级。
    const read = transport.conversationRows;
    if (typeof read !== "function") {
      return { ok: false, reason: "unavailable" };
    }
    for (let attempt = 0; attempt < FAST_PATH_MAX_ATTEMPTS; attempt++) {
      let outcome: ConversationRowsFastOutcome;
      try {
        // 用 .call 绑定 transport 而不是裸调 read(...)：
        // ReplaceableConversationTransport 是 class，方法体读 this.current，
        // 解绑会拿到 undefined（agentConversationTransport 的对象字面量方法用闭包，
        // 两种实现必须同时成立）。
        outcome = await read.call(transport, {
          sessionId: params.sessionId,
          ...(params.minRevision !== undefined ? { minRevision: params.minRevision } : {}),
          ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
          limit: params.limit ?? FAST_PATH_ROW_LIMIT,
        });
      } catch (error) {
        // RPC 失败不进 error 态：快绘只是加速器，回落今天的 subscribe 路径即可。
        logger.warn(
          `[v4-fast-rows] ${params.sessionId} 读取失败: ${error instanceof Error ? error.message : String(error)}`,
        );
        outcome = { ok: false, reason: "unavailable" };
      }
      if (outcome.ok && !inspectConversationRows(outcome.rows).ok) {
        emit({ kind: "malformed", sessionId: params.sessionId, attempt });
        outcome = { ok: false, reason: "partial" };
      }
      const decision = decideConversationRowsOutcome(outcome, attempt);
      if (decision === "accept") {
        emit({
          kind: "accepted",
          sessionId: params.sessionId,
          attempt,
          rowCount: outcome.ok ? outcome.rows.length : 0,
        });
        return outcome;
      }
      if (decision === "retry") {
        emit({
          kind: "retried",
          sessionId: params.sessionId,
          attempt,
          reason: outcome.ok ? undefined : outcome.reason,
        });
        // decideConversationRowsOutcome 只在 attempt + 1 < FAST_PATH_MAX_ATTEMPTS
        // （= 表长 + 1）时判 retry，所以 attempt 必然落在表内；`?? 0` 纯粹是
        // noUncheckedIndexedAccess 看不到这条蕴含关系，0 表示「立刻重试」，不可达。
        const retryDelayMs =
          FAST_PATH_RETRY_DELAYS_MS[Math.min(attempt, FAST_PATH_RETRY_DELAYS_MS.length - 1)] ?? 0;
        await delay(retryDelayMs);
        continue;
      }
      emit({
        kind: "fallback",
        sessionId: params.sessionId,
        attempt,
        reason: outcome.ok ? undefined : outcome.reason,
      });
      return outcome;
    }
    return { ok: false, reason: "unavailable" };
  };

  return {
    read(params: ConversationRowsFastReadParams): Promise<ConversationRowsFastOutcome> {
      const existing = inFlight.get(params.sessionId);
      if (existing) return existing;
      emit({ kind: "requested", sessionId: params.sessionId, attempt: 0 });
      const flight = attemptRead(params).finally(() => {
        // 只清自己那一代，避免把后来者挤掉。
        if (inFlight.get(params.sessionId) === flight) inFlight.delete(params.sessionId);
      });
      inFlight.set(params.sessionId, flight);
      return flight;
    },
    cancel(sessionId: string): void {
      inFlight.delete(sessionId);
    },
  };
}

// ── 预取缓存（模块级，跨 pane / 跨 connection 共享）──
//
// 键只用 sessionId：session id 是 CLI 侧 uuid，跨 workspace 不会重复，所以不必把
// workspaceKey 掺进键里（掺了反而要求 SessionDataLayer 知道自己属于哪个 workspace，
// 而它按设计是 workspace 无感的，见 sessionDataLayer.ts:4-5）。
//
// TTL 取 30 s，与本仓库既有的两个 keep-warm 窗口对齐
// （sessionDataLayer.ts:30、workspaceConnectionRegistry.ts:89）：预取结果不该活得比
// 它本可以喂给的那个 store 更久。过期即丢弃，不自动刷新。
export const PREFETCH_TTL_MS = 30_000;
/** 略高于 K=6，让「刚被打开的那条」在消费前不被挤出。 */
export const PREFETCH_CACHE_MAX_ENTRIES = 8;

export interface PrefetchedConversationRows {
  sessionId: string;
  revision: string;
  // 与协议结果的 rows 同可变性（v4ConversationRowsResultSchema 的 z.array 推出的是
  // ConversationRow[]）：缓存只是转手，不改动它，而保持同型可以避免消费侧为了播种
  // 再拷一份 60 元素的数组。
  rows: ConversationRow[];
  hasMore: boolean;
  storedAt: number;
}

export interface PrefetchCache {
  peek(sessionId: string): PrefetchedConversationRows | null;
  put(entry: PrefetchedConversationRows): void;
  /** 取走并删除：打开会话时消费一次，避免同一份行被两个 pane 当成两次新鲜事实。 */
  consume(sessionId: string): PrefetchedConversationRows | null;
  /** 无参 = 全清（runtime 换代）；有参 = 只清该会话（会话被改写）。 */
  invalidate(sessionId?: string): void;
  size(): number;
}

export function createPrefetchCache(now: () => number = () => Date.now()): PrefetchCache {
  // Map 迭代序 = 插入序；delete+set 即 LRU touch（同 timelineRowHeightCache.ts:32-34）。
  const entries = new Map<string, PrefetchedConversationRows>();

  const live = (sessionId: string): PrefetchedConversationRows | null => {
    const entry = entries.get(sessionId);
    if (!entry) return null;
    if (now() - entry.storedAt >= PREFETCH_TTL_MS) {
      entries.delete(sessionId);
      return null;
    }
    // 命中即刷新淘汰顺序，活跃条目不被挤出。
    entries.delete(sessionId);
    entries.set(sessionId, entry);
    return entry;
  };

  return {
    peek: live,
    consume(sessionId: string): PrefetchedConversationRows | null {
      const entry = live(sessionId);
      entries.delete(sessionId);
      return entry;
    },
    put(entry: PrefetchedConversationRows): void {
      entries.delete(entry.sessionId);
      entries.set(entry.sessionId, entry);
      while (entries.size > PREFETCH_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    invalidate(sessionId?: string): void {
      if (sessionId === undefined) entries.clear();
      else entries.delete(sessionId);
    },
    size(): number {
      return entries.size;
    },
  };
}

/**
 * 组件与数据层只认这一个模块级实例（同 agentPrewarm.ts:182 的单例做法）。
 * 导出实例而不是逐个导出 peek/put/consume 包装函数：调用点写
 * `conversationRowsPrefetchCache.peek(id)` 一样清楚，少五个纯转发。
 */
export const conversationRowsPrefetchCache = createPrefetchCache();
