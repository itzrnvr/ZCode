import { useEffect, useRef, useState } from "react";
import type { ZCodeSessionSideChat } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/**
 * 当前会话的框选副屏目录（issue #38）。
 *
 * 副屏是 `selection_side_chat` 子会话，父会话就是当前会话。左侧任务列表按
 * `TASK_LIST_SESSION_TYPES` 把副屏排除掉，副屏自己又一直没有目录投影，于是这些会话
 * 在 UI 里没有任何入口——包括重启后"副屏不见了"的现象。会话数据一直按 `parent_id`
 * 关联着，这里只是把它们列出来。
 *
 * 只读查询，不激活 runtime。`isActive` 是查询时刻的快照：副屏的活跃态由 runtime 记录
 * 决定，会话侧事件（新建/结束副屏）会改动 refreshKey 从而触发重取，不做常驻轮询。
 */
export function useSessionSideChats(options: {
  enabled?: boolean;
  refreshKey?: string | number | null;
  remoteSessionId?: string;
  sessionId?: string | null;
  workspaceIdentity?: string;
  workspacePath: string;
}): {
  error: string | null;
  loading: boolean;
  sideChats: ZCodeSessionSideChat[];
} {
  const services = useServices();
  const zcodeAgentService = services.zcodeAgentService;
  const [sideChats, setSideChats] = useState<ZCodeSessionSideChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    if (options.enabled === false) return;
    const sessionId = options.sessionId;
    if (!sessionId) {
      setSideChats([]);
      setError(null);
      return;
    }
    // service 未就绪时不报错：副屏目录是增强信息，缺了不该把面板标红。
    if (typeof zcodeAgentService?.listSessionSideChats !== "function") {
      setSideChats([]);
      setError(null);
      return;
    }
    const version = ++requestVersionRef.current;
    setLoading(true);
    void (async () => {
      try {
        const result = await zcodeAgentService.listSessionSideChats({
          sessionId,
          workspacePath: options.workspacePath,
          limit: 20,
          ...(options.workspaceIdentity
            ? { workspaceIdentity: options.workspaceIdentity }
            : {}),
          ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
        });
        // 会话切换后旧请求晚到时丢弃，避免把上一个会话的副屏挂到当前面板上。
        if (requestVersionRef.current !== version) return;
        setSideChats(result.sideChats);
        setError(null);
      } catch (caught) {
        if (requestVersionRef.current !== version) return;
        setSideChats([]);
        setError(caught instanceof Error ? caught.message : String(caught));
        logger.warn("[v4] 副屏目录读取失败", { error: caught, sessionId });
      } finally {
        if (requestVersionRef.current === version) setLoading(false);
      }
    })();
    return () => {
      // 递增版本号让在途请求失效。
      requestVersionRef.current += 1;
    };
  }, [
    options.enabled,
    options.refreshKey,
    options.remoteSessionId,
    options.sessionId,
    options.workspaceIdentity,
    zcodeAgentService,
  ]);

  return { sideChats, loading, error };
}
