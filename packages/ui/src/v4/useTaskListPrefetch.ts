// 侧栏可见行 -> 会话行预取（React 胶水层）。
//
// 分工是刻意的：调度策略全在 `conversationRowsPrefetch.ts`（纯逻辑、可单测），
// 本文件只做三件在组件里才拿得到的事——把两种列表视图摊平成候选、判断 workspace
// 是否远端、以及挂/摘交互监听。侧栏那两个调用点各自只有一行调用，
// 不放排序逻辑、不放 service 查找、不放状态。
//
// 为什么按「可见行」而不是按最近活跃排序：点击概率跟着用户眼睛走，
// 侧栏的显示顺序（活跃行优先，lib/taskListOrdering.ts:44-70）就是那个顺序，
// 而 sessions-index 的 lastActivityAt 降序（sessionsIndexStore.ts:764-772）不是。
//
// 为什么远端一律跳过：与 agentPrewarm 同一条理由（agentPrewarm.ts:15、:133）——
// 本地 host accessor 不能代表远端 workspace 读 store，而预取是优化不是功能，
// 猜错一次的代价（一次无效 RTT + 一次 579 ms 量级的反序列化）比省下的那次点击更贵。
import { useEffect, useMemo, useRef } from "react";
import type { ZCodeGroupedTaskView, ZCodeTaskListItem } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ConversationRowsFastOutcome } from "@/v4/conversationRowsFastPath.js";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionLease,
} from "@/v4/workspaceConnectionRegistry.js";
import {
  getRemoteWorkspaceServicesForIdentity,
  getRemoteWorkspaceServicesForPath,
  resolveRegisteredWorkspaceServices,
} from "@/store/remoteWorkspaceSessionStore.js";
import {
  conversationRowsPrefetchCache,
  createConversationRowsFastReader,
} from "@/v4/conversationRowsFastPath.js";
import {
  createConversationRowsPrefetchController,
  registerConversationRowsPrefetchController,
  type ConversationRowsPrefetchCandidate,
  type ConversationRowsPrefetchController,
} from "@/v4/conversationRowsPrefetch.js";

/** idle 优先、计时兜底；与 hooks/useTabPersistence.ts:32-42 同一写法（本仓库唯一先例）。 */
function scheduleIdle(run: () => void, timeoutMs: number): () => void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
}

function scheduleDelay(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}

function isRemoteWorkspace(candidate: {
  workspacePath: string;
  workspaceIdentity?: string;
}): boolean {
  const identity = candidate.workspaceIdentity?.trim();
  return identity
    ? getRemoteWorkspaceServicesForIdentity(identity) !== null
    : getRemoteWorkspaceServicesForPath(candidate.workspacePath) !== null;
}

/**
 * 一次预取读取：临时借一条 workspace 连接（引用计数 + 30 s keep-warm，
 * workspaceConnectionRegistry.ts:89,159-263），读完立刻还。
 * 走 transport 而不是直接调 agentService，是为了复用 transport 自己的
 * ensureHandshake（agentConversationTransport.ts:376）——非 pane 消费者已有同样先例：
 * settings/saved-workflows/useSavedWorkflowLauncher.ts:76-88 + finally release（:218-222）。
 */
async function readPrefetchedRows(
  candidate: ConversationRowsPrefetchCandidate,
): Promise<ConversationRowsFastOutcome> {
  const services = resolveRegisteredWorkspaceServices({
    workspacePath: candidate.workspacePath,
    ...(candidate.workspaceIdentity ? { workspaceIdentity: candidate.workspaceIdentity } : {}),
  });
  if (!services) return { ok: false, reason: "unavailable" };
  let lease: WorkspaceConnectionLease | null = null;
  try {
    lease = acquireWorkspaceConnection(
      {
        workspacePath: candidate.workspacePath,
        ...(candidate.workspaceIdentity ? { workspaceIdentity: candidate.workspaceIdentity } : {}),
      },
      services.zcodeAgentService,
    );
    return await createConversationRowsFastReader(lease.transport).read({
      sessionId: candidate.sessionId,
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    // 远端 proxy 的 activateRemoteService 必须在 commit 后调用，而这里根本不为远端
    // 预取，所以不需要它；release 幂等（:258-261）。
    lease?.release();
  }
}

let liveController: ConversationRowsPrefetchController | null = null;

/**
 * 惰性创建控制器，并注册到纯模块的注册点（`conversationRowsPrefetch.ts`）。
 *
 * 注册点放在那边而不是这里，是为了断一个真实的环：`sessionDataLayer.acquire` 要在打开会话时
 * 通知调度器出队，而本文件的执行器要借 `workspaceConnectionRegistry` 的连接租约，注册表自己又
 * import `SessionDataLayer` —— 数据层直接 import 本文件就成环。把「已打开」这一个函数放在没有
 * 任何注册表依赖的纯模块里，环就断了；注册之前调用是 no-op。
 * 与 `lib/agentPrewarm.ts:182-190`（模块级单例 + 注册执行器）同一个做法。
 */
function getTaskListPrefetchController(): ConversationRowsPrefetchController {
  if (liveController !== null) return liveController;
  liveController = createConversationRowsPrefetchController({
    read: readPrefetchedRows,
    scheduleIdle,
    scheduleDelay,
    cache: conversationRowsPrefetchCache,
  });
  registerConversationRowsPrefetchController(liveController);
  return liveController;
}

/** 候选签名：流式刷新会重建整个数组（WorkspaceSidebarItem.tsx:216-219 有同样的问题），
 *  只有可见会话集合真的变了才值得重新提交。 */
function candidateSignature(candidates: readonly ConversationRowsPrefetchCandidate[]): string {
  return candidates.map((candidate) => candidate.sessionId).join("|");
}

function useTaskListPrefetchCandidates(
  candidates: readonly ConversationRowsPrefetchCandidate[],
): void {
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const signature = candidateSignature(candidates);

  useEffect(() => {
    if (signature === "") return;
    const controller = getTaskListPrefetchController();
    controller.submit(candidatesRef.current);
    // 交互永远优先于预取：按下/敲键/滚轮的当场取消待跑的 idle 回调。
    // 监听器只在有候选时挂，卸载即摘（两个调用点同时挂载时重复通知是幂等的，
    // notifyInteraction 在已延后时直接返回）。
    const notify = (): void => controller.notifyInteraction();
    window.addEventListener("pointerdown", notify, { capture: true, passive: true });
    window.addEventListener("keydown", notify, { capture: true });
    window.addEventListener("wheel", notify, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", notify, { capture: true });
      window.removeEventListener("keydown", notify, { capture: true });
      window.removeEventListener("wheel", notify, { capture: true });
    };
  }, [signature]);
}

function toCandidate(
  item: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): ConversationRowsPrefetchCandidate {
  return {
    sessionId: item.taskId,
    workspacePath: item.workspacePath,
    ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
    remote: isRemoteWorkspace(item),
  };
}

/**
 * 平铺侧栏（workspace 模式）：`taskItems` 已是显示顺序，直接按序取前 K 个候选，
 * K 的上限由调度器负责，这里不截断（截断了就没法在跳过远端/已缓存后补位）。
 */
export function useTaskListPrefetchTaskItems(items: readonly ZCodeTaskMeta[] | undefined): void {
  const candidates = useMemo(
    () => (items ?? []).map(toCandidate),
    // 只按身份集合变化重算；数组每帧重建但内容通常不变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items],
  );
  useTaskListPrefetchCandidates(candidates);
}

/**
 * 分组侧栏：把 group/task 两种顶层节点摊平回显示顺序
 * （nodes 顺序即显示顺序，组内 tasks 顺序即组内显示顺序，
 * 与 workspace-grouped-tasks/virtualized-top-level-list.tsx:20-25 的取键口径一致）。
 */
export function useTaskListPrefetchGroupedView(view: ZCodeGroupedTaskView | null | undefined): void {
  const candidates = useMemo(
    () =>
      (view?.nodes ?? []).flatMap((node): ConversationRowsPrefetchCandidate[] =>
        node.type === "group"
          ? node.tasks.map((task: ZCodeTaskListItem) => toCandidate(task))
          : [toCandidate(node.task)],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view],
  );
  useTaskListPrefetchCandidates(candidates);
}

