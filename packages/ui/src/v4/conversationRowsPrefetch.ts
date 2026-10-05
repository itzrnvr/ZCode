// v4 会话行的预测式预取调度器（纯逻辑，不依赖 React / DOM）。
//
// 为什么必须这么保守：预取省下的是「一次 RTT + 一次 JSON 反序列化」，而反序列化在
// renderer 主线程上实测 579 ms / 60 行（tight-e2e-base.json 的 `(program)` 自耗时；
// 同一次运行 busyMs 只有 410 ms、idlePct 92.5%）。也就是说 K=6 条天真预取 ≈ 3.5 s
// 主线程占用——把一次点击变快的代价是让整段时间里所有交互都卡。所以这里的约束顺序是
// 「先不卡，再谈准」：
// - 严格串行（maxInFlight = 1），因为代价是主线程而不是网络；
// - 只在 idle 窗口跑，且带 timeout 兜底（窗口被遮挡时 idle 回调会被节流，
//   见 browser-use/useBrowserScreenshotSurfaceReady.ts:22-26 记录的同类失效）；
// - 任何用户交互立刻取消待跑的 idle 回调并延后，交互永远优先于预取；
// - 命中 TTL 即丢弃，不自动刷新（预取结果不该活得比它本可以喂给的那个 store 更久，
//   30 s 与 sessionDataLayer.ts:30 / workspaceConnectionRegistry.ts:89 的 keep-warm 对齐）。
//
// 形状刻意对齐 src/lib/agentPrewarm.ts（本仓库既有的预热点调度器）：策略对象 +
// 可注入 now/schedule + 事件回调 + 模块级单例，因此可以用同一套测试写法覆盖
// （test/agentPrewarm.test.ts:16-46 的手动 flush，不依赖假计时器）。
import type {
  ConversationRowsFastOutcome,
  PrefetchCache,
} from "@/v4/conversationRowsFastPath.js";

export interface ConversationRowsPrefetchPolicy {
  /** 单轮最多预取多少个候选（K）。 */
  candidateLimit: number;
  /** 同时在途的读取数。串行是主线程约束，不是礼貌约束。 */
  maxInFlight: number;
  /** 两次读取之间的最小间隔，避免 idle 窗口里连发把长任务串成一串。 */
  minIntervalMs: number;
  /** requestIdleCallback 的 timeout 兜底。 */
  idleTimeoutMs: number;
  /** 交互后延多久才恢复预取。 */
  interactionDeferMs: number;
}

export const DEFAULT_CONVERSATION_ROWS_PREFETCH_POLICY: ConversationRowsPrefetchPolicy = {
  candidateLimit: 6,
  maxInFlight: 1,
  minIntervalMs: 120,
  idleTimeoutMs: 1000,
  interactionDeferMs: 400,
};

export interface ConversationRowsPrefetchCandidate {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远端会话不预取：本地 host accessor 不能代表远端 workspace 读 store。 */
  remote?: boolean;
}

export type ConversationRowsPrefetchSkipReason =
  | "empty_list"
  | "remote_session"
  | "empty_session_id"
  | "already_cached"
  | "already_queued"
  | "candidate_limit"
  | "opened"
  | "deferred_by_interaction";

export interface ConversationRowsPrefetchEvent {
  kind: "queued" | "skipped" | "started" | "cached" | "failed" | "deferred" | "resumed";
  sessionId: string;
  reason?: ConversationRowsPrefetchSkipReason;
  error?: string;
}

export interface ConversationRowsPrefetchDeps {
  /** 真正发 RPC 的执行器；由 hook 注入（持 connection lease 的那一侧）。 */
  read(candidate: ConversationRowsPrefetchCandidate): Promise<ConversationRowsFastOutcome>;
  /** 返回取消函数。测试注入后手动 flush，不依赖真实 idle/计时器。 */
  scheduleIdle(run: () => void, timeoutMs: number): () => void;
  scheduleDelay(run: () => void, delayMs: number): () => void;
  cache: PrefetchCache;
  now?: () => number;
  policy?: Partial<ConversationRowsPrefetchPolicy>;
  onEvent?: (event: ConversationRowsPrefetchEvent) => void;
}

export interface ConversationRowsPrefetchController {
  /** 用当前可见行替换候选队列；空列表是 no-op。 */
  submit(candidates: readonly ConversationRowsPrefetchCandidate[]): void;
  /** 用户交互：取消待跑的 idle 回调并延后。 */
  notifyInteraction(): void;
  /** 该会话已被打开：出队，不再为它预取。 */
  notifyOpened(sessionId: string): void;
  queuedSessionIds(): readonly string[];
  requestedCount(): number;
  dispose(): void;
}

export function createConversationRowsPrefetchController(
  deps: ConversationRowsPrefetchDeps,
): ConversationRowsPrefetchController {
  const policy: ConversationRowsPrefetchPolicy = {
    ...DEFAULT_CONVERSATION_ROWS_PREFETCH_POLICY,
    ...deps.policy,
  };
  const now = deps.now ?? (() => Date.now());
  const emit = (event: ConversationRowsPrefetchEvent): void => {
    deps.onEvent?.(event);
  };

  // 队列用数组保序（候选顺序 = 侧栏显示顺序 = 点击概率序），
  // 用 Set 做 O(1) 去重；两者同步维护，dispose 时一起清。
  const queue: ConversationRowsPrefetchCandidate[] = [];
  const queued = new Set<string>();
  const opened = new Set<string>();
  let inFlight = 0;
  let requestedCount = 0;
  let lastStartedAt: number | null = null;
  let idleCancel: (() => void) | null = null;
  let deferCancel: (() => void) | null = null;
  let disposed = false;

  const cancelIdle = (): void => {
    if (idleCancel === null) return;
    const cancel = idleCancel;
    idleCancel = null;
    cancel();
  };

  const cancelDefer = (): void => {
    if (deferCancel === null) return;
    const cancel = deferCancel;
    deferCancel = null;
    cancel();
  };

  const skip = (
    candidate: ConversationRowsPrefetchCandidate,
    reason: ConversationRowsPrefetchSkipReason,
  ): void => {
    emit({ kind: "skipped", sessionId: candidate.sessionId, reason });
  };

  const pump = (): void => {
    idleCancel = null;
    if (disposed) return;
    if (inFlight >= policy.maxInFlight || queue.length === 0) return;
    const earliestNextAt = lastStartedAt === null ? 0 : lastStartedAt + policy.minIntervalMs;
    const waitMs = earliestNextAt - now();
    if (waitMs > 0) {
      schedulePump(waitMs);
      return;
    }
    const candidate = queue.shift();
    if (!candidate) return;
    queued.delete(candidate.sessionId);
    // 已被打开的会话不再为它付反序列化：pane 自己那次读取就是权威的那次。
    if (opened.has(candidate.sessionId)) {
      skip(candidate, "opened");
      schedulePump(0);
      return;
    }
    inFlight++;
    requestedCount++;
    lastStartedAt = now();
    emit({ kind: "started", sessionId: candidate.sessionId });
    void deps.read(candidate).then(
      (outcome) => {
        inFlight--;
        if (disposed) return;
        if (outcome.ok) {
          deps.cache.put({
            sessionId: candidate.sessionId,
            revision: outcome.revision,
            rows: outcome.rows,
            hasMore: outcome.hasMore,
            storedAt: now(),
          });
          emit({ kind: "cached", sessionId: candidate.sessionId });
        } else {
          // 失败不进 UI，也不重试：瞬态原因的重试由 conversationRowsFastPath 的
          // building/stale 分支负责，这里只记录、不缓存。
          emit({ kind: "failed", sessionId: candidate.sessionId });
        }
        schedulePump(0);
      },
      (error: unknown) => {
        inFlight--;
        if (disposed) return;
        emit({
          kind: "failed",
          sessionId: candidate.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        schedulePump(0);
      },
    );
  };

  /** delayMs <= 0 走 idle 通道（可被交互取消）；> 0 走计时通道（min-interval / 交互延后）。 */
  const schedulePump = (delayMs: number): void => {
    if (disposed || idleCancel !== null || deferCancel !== null) return;
    if (delayMs > 0) {
      deferCancel = deps.scheduleDelay(() => {
        deferCancel = null;
        schedulePump(0);
      }, delayMs);
      return;
    }
    idleCancel = deps.scheduleIdle(pump, policy.idleTimeoutMs);
  };

  return {
    submit(candidates: readonly ConversationRowsPrefetchCandidate[]): void {
      if (disposed) return;
      // 空列表 no-op：侧栏在加载中/搜索无结果时会反复传空，
      // 不能因此把已经排好的队列清掉。
      if (candidates.length === 0) {
        return;
      }
      for (const candidate of candidates) {
        const sessionId = candidate.sessionId?.trim() ?? "";
        if (!sessionId) {
          skip(candidate, "empty_session_id");
          continue;
        }
        if (candidate.remote === true) {
          skip({ ...candidate, sessionId }, "remote_session");
          continue;
        }
        if (opened.has(sessionId)) {
          skip({ ...candidate, sessionId }, "opened");
          continue;
        }
        if (queued.has(sessionId)) {
          skip({ ...candidate, sessionId }, "already_queued");
          continue;
        }
        // 已有新鲜缓存就不重复付反序列化；TTL 过期由 cache.peek 自己判定。
        if (deps.cache.peek(sessionId) !== null) {
          skip({ ...candidate, sessionId }, "already_cached");
          continue;
        }
        if (queue.length >= policy.candidateLimit) {
          skip({ ...candidate, sessionId }, "candidate_limit");
          continue;
        }
        const normalized: ConversationRowsPrefetchCandidate = {
          ...candidate,
          sessionId,
        };
        queue.push(normalized);
        queued.add(sessionId);
        emit({ kind: "queued", sessionId });
      }
      schedulePump(0);
    },

    notifyInteraction(): void {
      if (disposed) return;
      if (queue.length === 0 || deferCancel !== null) return;
      cancelIdle();
      emit({ kind: "deferred", sessionId: queue[0]?.sessionId ?? "" });
      schedulePump(policy.interactionDeferMs);
    },

    notifyOpened(sessionId: string): void {
      opened.add(sessionId);
      const index = queue.findIndex((candidate) => candidate.sessionId === sessionId);
      if (index === -1) return;
      queue.splice(index, 1);
      queued.delete(sessionId);
      emit({ kind: "skipped", sessionId, reason: "opened" });
    },

    queuedSessionIds(): readonly string[] {
      return queue.map((candidate) => candidate.sessionId);
    },

    requestedCount(): number {
      return requestedCount;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelIdle();
      cancelDefer();
      queue.length = 0;
      queued.clear();
      opened.clear();
      inFlight = 0;
    },
  };
}

// ── 模块级注册点 ──
//
// 控制器实例由 React 胶水层（`useTaskListPrefetch.ts`）创建，因为它要借
// `workspaceConnectionRegistry` 的连接租约；而数据层（`sessionDataLayer.acquire`）需要在
// 打开会话时通知调度器出队。注册表自己 import `SessionDataLayer`，所以数据层直接 import
// 胶水层会成环（sessionDataLayer -> useTaskListPrefetch -> workspaceConnectionRegistry ->
// sessionDataLayer）。把这一个入口放在没有任何注册表依赖的纯模块里，环就断了；
// 注册之前调用是 no-op，正好对应「侧栏还没渲染过，也就没有预取可取消」。
// 与 `lib/agentPrewarm.ts:182-190` 的「模块级单例 + 注册执行器」是同一个做法。
let liveController: ConversationRowsPrefetchController | null = null;

export function registerConversationRowsPrefetchController(
  controller: ConversationRowsPrefetchController | null,
): void {
  liveController = controller;
}

/**
 * 会话已被真正打开：出队，别再为它付一次反序列化（pane 自己那次读取就是权威的那次）。
 * `SessionDataLayer.acquire` 在命中与未命中两条路上都要调它。
 */
export function notifyTaskListPrefetchOpened(sessionId: string): void {
  liveController?.notifyOpened(sessionId);
}
