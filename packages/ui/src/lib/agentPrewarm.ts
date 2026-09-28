/**
 * Agent 预热点（#4：首次触达未激活 workspace 的 2–3.8 s 冷启动）。
 *
 * 事实依据（本仓库 issue #4 实测 + 本次 sandbox A/B）：warm agent 下冷会话打开
 * 0.42–0.79 s（达标），而首次触达一个 agent 未运行的 workspace 要先付 agent 进程
 * spawn + bundle 启动（实测 ~1.55 s，bytecode 方案已在本线程被实测否掉）。启动期
 * 只预热最近 3 个 workspace（`STARTUP_AGENT_WARMUP_LIMIT`），名单之外的那次点击
 * 因此仍然全额付费。
 *
 * 这里补的是**意图触发**的预热：侧栏行 hover 时预热该行所属 workspace 的 agent，
 * 复用 host 既有的 `IZCodeSessionService.initializeWorkspace`（与启动预热同一条路径，
 * 进程管理器已按 workspaceKey 收敛并发 spawn，并有 idle 回收兜住内存）。
 *
 * 约束（全部在本文件内可单测，不依赖 React）：
 * - 远端行不预热：本地 host accessor 不能代表远端 workspace 起进程；
 * - 当前激活 workspace 不预热：它本来就在跑；
 * - 每个 workspace 一次（按 identity||path 去重），整轮运行有上限；
 * - 两次执行之间有最小间隔，避免光标扫过列表时连环 spawn；
 * - 执行失败只记录，绝不冒泡到 UI（预热是优化，不是功能）。
 */

export interface AgentPrewarmTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远端会话行：本地 host 无权为其 spawn agent，一律跳过。 */
  remoteSessionId?: string | null;
  /** 已是当前激活 workspace：agent 必然在跑，无需预热。 */
  isActiveWorkspace?: boolean;
}

export type AgentPrewarmExecutor = (target: {
  workspacePath: string;
  workspaceIdentity?: string;
}) => Promise<unknown> | unknown;

export interface AgentPrewarmPolicy {
  /** 单次 app 运行内最多预热多少个不同 workspace（不含启动期的 3 个）。 */
  maxDistinctWorkspaces: number;
  /** 两次预热执行之间的最小间隔，抑制光标扫列表造成的连环 spawn。 */
  minIntervalMs: number;
  /** hover 到真正执行的意图延迟；离开也不会取消（去重已保证只跑一次）。 */
  intentDelayMs: number;
}

export const DEFAULT_AGENT_PREWARM_POLICY: AgentPrewarmPolicy = {
  maxDistinctWorkspaces: 3,
  minIntervalMs: 1500,
  intentDelayMs: 120,
};

export type AgentPrewarmSkipReason =
  | "no_executor"
  | "remote_workspace"
  | "active_workspace"
  | "empty_workspace_path"
  | "already_requested"
  | "capacity_reached";

export interface AgentPrewarmEvent {
  kind: "skipped" | "scheduled" | "completed" | "failed";
  workspaceKey: string;
  reason?: AgentPrewarmSkipReason;
  error?: string;
}

export interface AgentPrewarmControllerDeps {
  execute?: AgentPrewarmExecutor | null;
  now?: () => number;
  /** 返回取消函数；测试注入后可手动触发，避免依赖真实计时器。 */
  schedule?: (run: () => void, delayMs: number) => () => void;
  policy?: Partial<AgentPrewarmPolicy>;
  onEvent?: (event: AgentPrewarmEvent) => void;
}

export interface AgentPrewarmController {
  request(target: AgentPrewarmTarget): void;
  setExecutor(execute: AgentPrewarmExecutor | null): void;
  /** 已请求过的 workspace 数（含失败），用于诊断与测试断言。 */
  requestedCount(): number;
  reset(): void;
}

export function workspacePrewarmKey(target: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function createAgentPrewarmController(
  deps: AgentPrewarmControllerDeps = {},
): AgentPrewarmController {
  const policy: AgentPrewarmPolicy = { ...DEFAULT_AGENT_PREWARM_POLICY, ...deps.policy };
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });
  let execute = deps.execute ?? null;
  const requested = new Set<string>();
  let lastStartedAt: number | null = null;

  const emit = (event: AgentPrewarmEvent): void => {
    deps.onEvent?.(event);
  };

  return {
    setExecutor(next: AgentPrewarmExecutor | null): void {
      execute = next;
    },

    requestedCount(): number {
      return requested.size;
    },

    reset(): void {
      requested.clear();
      lastStartedAt = null;
    },

    request(target: AgentPrewarmTarget): void {
      const skip = (reason: AgentPrewarmSkipReason, workspaceKey: string): void => {
        emit({ kind: "skipped", reason, workspaceKey });
      };
      const workspacePath = target.workspacePath?.trim() ?? "";
      const workspaceKey = workspacePrewarmKey({
        workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
      if (!execute) return skip("no_executor", workspaceKey);
      if (target.remoteSessionId) return skip("remote_workspace", workspaceKey);
      if (target.isActiveWorkspace) return skip("active_workspace", workspaceKey);
      if (!workspacePath) return skip("empty_workspace_path", workspaceKey);
      if (requested.has(workspaceKey)) return skip("already_requested", workspaceKey);
      if (requested.size >= policy.maxDistinctWorkspaces) {
        return skip("capacity_reached", workspaceKey);
      }
      // 先占位再排程：同一行的重复 hover（以及虚拟列表重挂）不会排入第二次。
      requested.add(workspaceKey);
      // 闭包里不能用可变的 `execute`（TS 无法保留窄化，且注册可能在排程后被清空）。
      const executor = execute;
      const earliestNextAt =
        lastStartedAt === null ? 0 : lastStartedAt + policy.minIntervalMs;
      const delayMs = Math.max(policy.intentDelayMs, earliestNextAt - now());
      emit({ kind: "scheduled", workspaceKey });
      schedule(() => {
        lastStartedAt = now();
        try {
          const result = executor({
            workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          });
          if (result && typeof (result as Promise<unknown>).then === "function") {
            void (result as Promise<unknown>).then(
              () => emit({ kind: "completed", workspaceKey }),
              (error: unknown) =>
                emit({
                  kind: "failed",
                  workspaceKey,
                  error: error instanceof Error ? error.message : String(error),
                }),
            );
            return;
          }
          emit({ kind: "completed", workspaceKey });
        } catch (error) {
          emit({
            kind: "failed",
            workspaceKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, Math.max(0, delayMs));
    },
  };
}

// 组件侧只认这一个模块级实例：执行器由 root 层的注册 hook 注入（本地 host services），
// 行组件不各自持有 service，避免每行一个 context 订阅。
const liveController = createAgentPrewarmController();

export function registerAgentPrewarmExecutor(execute: AgentPrewarmExecutor | null): void {
  liveController.setExecutor(execute);
}

export function requestAgentPrewarm(target: AgentPrewarmTarget): void {
  liveController.request(target);
}

export function agentPrewarmRequestedCount(): number {
  return liveController.requestedCount();
}
