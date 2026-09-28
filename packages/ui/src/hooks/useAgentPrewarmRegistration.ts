import { useEffect } from "react";
import { registerAgentPrewarmExecutor } from "@/lib/agentPrewarm.js";
import { logger } from "@/logger.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

/**
 * #4：把「意图预热」的执行器接到本地 host 的 workspace 初始化入口。
 *
 * 只在 root 层挂一次：执行器是模块级单例的依赖，行组件通过
 * `requestAgentPrewarm` 触发，不各自订阅 service context。
 *
 * 用 base（本地 host）services 而不是当前 workspace 的 services：预热目标本来就
 * 是**另一个** workspace，而远端 tab 激活时 `useServices()` 读到的是远端 host，
 * 拿它去 initializeWorkspace 会把本地 workspace 的请求发到远端。远端行在
 * controller 里已按 remoteSessionId 直接跳过。
 */
export function useAgentPrewarmRegistration(): void {
  const services = useOptionalBaseWorkspaceServices();
  const zcodeSessionService = services?.zcodeSessionService;

  useEffect(() => {
    if (!zcodeSessionService) {
      registerAgentPrewarmExecutor(null);
      return;
    }
    registerAgentPrewarmExecutor((target) =>
      zcodeSessionService
        .initializeWorkspace({
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        })
        .then((result) => {
          // available=false 不是异常（provider 未就绪等），只留一条 debug 线索。
          if (!result?.available) {
            logger.debug("[agent-prewarm] workspace not available", {
              reason: result?.reason,
              workspacePath: target.workspacePath,
            });
          }
          return result;
        }),
    );
    return () => registerAgentPrewarmExecutor(null);
  }, [zcodeSessionService]);
}
