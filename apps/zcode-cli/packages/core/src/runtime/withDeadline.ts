/**
 * 限时等待：等到 promise settle，超时则回退到 fallback。
 *
 * 用于「补充信息」类路径——MCP 工具注册、提醒注入、流式工具排空——
 * 这些都不允许把首个 provider 请求或轮次收尾无限期拖住。
 * 注册路径的默认上限与 methods/mcp.ts 的 MCP_TOOL_REGISTRATION_WAIT_MS
 * 保持一致（调用方的显式传入为准，这里不引入反向依赖）。
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 1_500;
export function settleWithin<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // 计时器保持 ref（默认状态）：unref 的计时器在事件循环空闲时不会触发，
    // 单发 CLI 场景下这个「截止时间」会静默失效，等待方又变成无限等待。
    // 提前 settle 时清掉它，避免多留一个待触发的计时器。
    const timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
