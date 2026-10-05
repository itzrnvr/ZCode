/* eslint-disable max-lines -- workspace 模型协议与兼容请求处理仍集中在本文件。 */
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import type { ModelSelection, MessageWithParts } from "@zcode/contracts";
import {
  zcodeProviderTestModelConnectivityParamsSchema,
  zcodeSessionModeSchema,
  zcodeWorkspaceReadPresentationParamsSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../app/types.js";
import type { SessionConfigSeed } from "../zcode-protocol-v4/product-projection.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import {
  parseParams,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { createProviderRuntimeHeadersPort } from "./provider-runtime-headers.js";

export async function readWorkspacePresentation(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);
  return {
    workspace: params.workspace,
    mode: "build" as const,
    slashCommands: await listProtocolSlashCommands({
      // 灰度门是 Host 判定的 workspace 级事实，目录装配读进程缓存。
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
      workingDirectory: params.workspace.workspacePath,
    }),
  };
}

export async function testProviderModelConnectivity(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeProviderTestModelConnectivityParamsSchema, rawParams);
  // 旧 Personal Config 跨进程 watcher 可能永久漏掉原子写事件；连接测试若不先
  // 主动刷新，会反复查询旧 Registry。这里复用正式 Registry refresh，不旁路创建配置事实。
  await context.deps.refreshProviderRegistry?.("provider-connectivity");
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: { workingDirectory: params.workspace.workspacePath },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));
  try {
    await app.testModelConnectivity(
      { selection: params.selection as ModelSelection },
      { abortSignal },
    );
    return { success: true as const };
  } finally {
    if (!active) await app.close?.();
  }
}

export async function createWorkspaceZCodeApp(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
  options: Omit<ZCodeAppOptions, "providerRegistry">,
): Promise<ZCodeApp> {
  const providerRuntimeHeadersPort =
    options.providerRuntimeHeadersPort ?? createProviderRuntimeHeadersPort(context, workspace);
  return context.deps.createZCodeApp({
    ...options,
    platform: context.deps.platform,
    providerRuntimeHeadersPort,
    runtimeConfig: {
      ...options.runtimeConfig,
      // createZCodeApp 会把 workingDirectory 规范化为执行 cwd。把协议入口的
      // workspacePath 单独注入 runtime，session 持久化才能保留本地 workspaceKey 的路径表示。
      workspacePath: workspace.workspacePath,
      // 远端 session 是 shared-host CUA 的第二层隔离边界：不能只传 workspacePath/identity，
      // 否则同一远端 workspace 的不同 attachment 会复用 Accessibility frame/action 状态。
      // 放在这个 helper 里而不是各调用点，是为了两条 session 创建路径都拿到同一份隔离键。
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
      ...(workspace.workspaceIdentity
        ? {
            memory: {
              ...options.runtimeConfig?.memory,
              workspaceIdentity: workspace.workspaceIdentity,
            },
          }
        : {}),
      // Electron/Protocol 主会话之前没有像 CLI/TUI 那样显式开启模型流式，
      // 导致主 turn 退回 generateText 非流式请求，遇到返回 SSE 的兼容端点会按 JSON 解析失败。
      modelStreaming: options.runtimeConfig?.modelStreaming ?? "on",
    },
  });
}

export function hasSessionModelProvider(
  _context: ZCodeProtocolAgentServerContext,
  record: Pick<ZCodeProtocolSessionRecord, "app" | "workspace">,
  providerId: string,
): boolean {
  return record.app.listModels().some((model) => model.ref.providerId === providerId);
}

async function ensureSessionModelAvailableUnlocked(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<boolean> {
  // 存量模型失效时不能静默改成 Registry 第一项覆盖用户选择；失效选择保持未绑定，
  // 由恢复/Composer 的选择校验和首发门禁处理；这里不能再写入另一份默认模型事实。
  // 保留该过渡入口是为了让旧协议调用方平稳退场。
  void context;
  void record;
  return false;
}

export async function ensureSessionModelAvailable(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<boolean> {
  return runSessionModelConfigMutation(record.app, () =>
    ensureSessionModelAvailableUnlocked(context, record),
  );
}

export function resolveSessionModelContextWindow(
  _context: ZCodeProtocolAgentServerContext,
  record: Pick<ZCodeProtocolSessionRecord, "app" | "workspace" | "restoredModelSelection">,
): number | undefined {
  // 缺档位会让恢复选择暂不绑定 Runtime，但模型身份仍可只读查询容量，不能伪造 20 万。
  const selection = record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
  const value = selection && record.app.getModelOption?.(selection)?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 持久 transcript 里的最后一次模型选型（倒扫约定与
 * `core/src/runtime/methods/session-fork.ts:70-90` 逐字对齐：user 消息只认
 * `info.modelSelection`，assistant 消息用 `modelId/providerId` + 可选 `reasoningLevel`）。
 *
 * 视图冷物化没有 runtime，`getSessionModelSelection()` / `restoredModelSelection` 都不存在；
 * 这条倒扫是「这个会话上次用哪个模型」的唯一持久事实。取不到就返回 undefined——
 * 调用方必须让它保持未知，绝不能拿 registry 首项或 20 万窗口顶上去。
 */
export function persistedModelSelectionFromMessages(
  messages: readonly MessageWithParts[],
): ModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (!info) continue;
    if (info.role === "user") {
      const selection = info.modelSelection;
      if (!selection) continue;
      return {
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(selection.options ? { options: { ...selection.options } } : {}),
      };
    }
    if (!info.modelId || !info.providerId) continue;
    return {
      modelId: info.modelId,
      providerId: info.providerId,
      ...(info.reasoningLevel ? { options: { reasoningLevel: info.reasoningLevel } } : {}),
    };
  }
  return undefined;
}

/**
 * record-less 的档位查询面：借**同 workspace 的活跃 record** 的 registry。
 *
 * `getModelOption` 是 registry-backed（`app/session-facade.ts:348`），而 registry 按
 * workspace identity 隔离；所以优先挑 workspaceKey 相同的那个 record，本地会话没有
 * workspaceID（workspaceKey 退化成路径）时才回落到任意带 `getModelOption` 的活跃 record。
 * 一个都没有 → undefined，调用方按「未知」处理（冷缓存因此 bypass，用量分母留空），
 * 这比拿别的 workspace 的 registry 猜一个窗口要诚实。
 */
function resolveWorkspaceModelLookupApp(
  context: ZCodeProtocolAgentServerContext,
  workspaceId: string | undefined,
): ZCodeApp | undefined {
  const records = [...context.sessions.values()];
  const scoped = workspaceId
    ? records.find((record) => record.workspace.workspaceKey === workspaceId)
    : undefined;
  return (scoped ?? records.find((record) => record.app.getModelOption !== undefined))?.app;
}

/**
 * {@link resolveSessionModelContextWindow} 的 record-less 版本（视图冷物化路径）。
 *
 * 与 record 版本的差别是有意的：record 版本读**本会话 runtime 的当前选型**，这里只能读
 * 持久 transcript 的最后一次选型 + 别的活跃 app 的 registry。用户改过模型而 ModelSelected
 * 没落库时两者会不同，因此 bridge 把 `modelContextWindow` 无条件列进 deferredColdSources，
 * view→READY 升级后按 record 重算一次。
 */
export function resolvePersistedSessionModelContextWindow(
  context: ZCodeProtocolAgentServerContext,
  persistedMessages: readonly MessageWithParts[],
  workspaceId?: string,
): number | undefined {
  const selection = persistedModelSelectionFromMessages(persistedMessages);
  if (!selection) return undefined;
  const value = resolveWorkspaceModelLookupApp(context, workspaceId)?.getModelOption?.(selection)
    ?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * record-less 的 config 种子：**只用持久事实**，绝不伪造。
 *
 * 视图冷开的只读会话没有 runtime 真值，但把模型与 mode 显示成空同样是一种谎报——它们
 * 都写在 transcript 里。因此这里只派生这两项：
 * - `modelSelection/provider/model/thought`：{@link persistedModelSelectionFromMessages}；
 * - `mode`：最后一条带 mode 的 assistant 消息（与 server-operations 的
 *   `derivePersistedSessionMode` 同一条倒扫，枚举取自 shared 的 `zcodeSessionModeSchema`）。
 *
 * 刻意**不**填 `thoughtLevels` / `planEnabled` / `permissionGrant`：那是 runtime 的能力面与
 * 瞬时状态，借别的 app 的 registry 凑一份档位清单会让 UI 提供该模型其实没有的档位，而
 * planEnabled 猜错会直接打破「revision 不变 ⇔ 无状态变化」的 CAS 不变量（见
 * `product-projection.ts:541-554` 的同一处告警）。缺就缺：`seedConfig` 保留投影默认值，
 * 升级后 record 的种子按字段覆盖。
 *
 * @returns 两项都无从派生时返回 null（gateway 跳过种子注入，与旧宿主同姿态）。
 */
export function buildPersistedSessionConfigSeed(
  context: ZCodeProtocolAgentServerContext,
  persistedMessages: readonly MessageWithParts[],
  workspaceId?: string,
): SessionConfigSeed | null {
  const selection = persistedModelSelectionFromMessages(persistedMessages);
  let mode: string | undefined;
  for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
    const info = persistedMessages[index]?.info;
    if (info?.role !== "assistant") continue;
    const parsed = zcodeSessionModeSchema.safeParse(info.mode);
    if (parsed.success) {
      mode = parsed.data;
      break;
    }
  }
  if (!selection && !mode) return null;
  // thoughtLevels 只在能查到**这个**模型时才填；查不到就留空，不用别的模型的档位顶。
  const levels = selection
    ? resolveWorkspaceModelLookupApp(context, workspaceId)
        ?.listModels()
        .find(
          (model) =>
            model.ref.providerId === selection.providerId &&
            model.ref.modelId === selection.modelId,
        )
        ?.reasoning?.levels.map((level) => level.value)
    : undefined;
  return {
    ...(selection ? { modelSelection: selection } : {}),
    ...(selection ? { provider: selection.providerId, model: selection.modelId } : {}),
    ...(selection?.options?.reasoningLevel ? { thought: selection.options.reasoningLevel } : {}),
    ...(levels && levels.length > 0 ? { thoughtLevels: levels } : {}),
    ...(mode ? { mode } : {}),
  };
}
