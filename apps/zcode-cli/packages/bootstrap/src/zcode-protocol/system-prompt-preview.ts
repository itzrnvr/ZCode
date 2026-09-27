// 设置页系统提示词预览：真实解析指令文件 + 真实组装 prompt。
//
// 只读请求，不改任何设置。两条数据都由既有真实路径产出，绝不在 Renderer 侧重建：
// - instructionFiles: NodeContextSourceAdapter.resolveContextSources（与 session 运行同一入口，
//   含 walk-up 到 git root 的 workspace AGENTS.md 与用户全局 ~/.zcode|~/.blackbird/AGENTS.md）。
// - sections: core ContextBuilder（与 turn 组装同一个 builder；开关/文本覆盖按请求参数临时生效）。
//
// 会话态输入（skills / output style / session guidance / 执行模型）在预览里缺席：
// 它们由 session 运行期决定，不是 workspace 级事实。UI 用 catalog 标注这些段为 session-only。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import {
  createContextBuilder,
  getSystemPromptSwitches,
  setSystemPromptSwitches,
  type ContextBuilderConfig,
} from "@zcode/core";
import {
  zcodeWorkspaceSystemPromptPreviewParamsSchema,
  type ZCodeWorkspaceSystemPromptPreviewOverrides,
  type ZCodeWorkspaceSystemPromptPreviewResult,
} from "@zcode/shared";
import { getCliStorageRoot, getProjectMemoryRoot } from "../app/paths.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

export async function previewWorkspaceSystemPrompt(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkspaceSystemPromptPreviewResult> {
  const params = parseParams(zcodeWorkspaceSystemPromptPreviewParamsSchema, rawParams);
  const { workspace } = params;
  const workingDirectory = workspace.workspacePath;

  const contextSourcePort = createNodeContextSourceAdapter({ env: context.deps.env });
  const snapshot = await contextSourcePort.resolveContextSources({
    workingDirectory,
    userInstructions: { workingDirectory },
  });

  const configResult = createConfig({ env: context.deps.env, workingDirectory });
  const cliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
  // 与 session 创建同源：Host prefs 未开启 memory 时不注入 # Memory 段，预览不能凭空显示它。
  const memoryRoot =
    params.overrides?.memoryEnabled === true
      ? getProjectMemoryRoot(cliStorageRoot, workingDirectory, workspace.workspaceIdentity)
      : undefined;
  // 与运行期一致：缺失或不可读的 index 视为没有该 context source（builder 自行做格式化/截断）。
  const memoryIndexContent = memoryRoot
    ? await readFile(join(memoryRoot, "MEMORY.md"), "utf8").catch(() => undefined)
    : undefined;

  const builderConfig: ContextBuilderConfig = {
    workingDirectory,
    envInfo: snapshot.envInfo,
    presentationSurface: params.presentationSurface ?? "terminal",
    currentDate: snapshot.currentDate,
    userInstructions: snapshot.userInstructions,
    projectContext: snapshot.projectContext,
    memoryRoot,
    memoryIndexContent,
  };
  const built = withSystemPromptOverrides(params.overrides, () =>
    createContextBuilder(builderConfig).build(),
  );

  return {
    workspace,
    workingDirectory,
    instructionFiles: (snapshot.userInstructions?.sources ?? []).map((source) => ({
      path: source.filePath,
      scope: source.scope,
      content: source.content,
      truncated: source.truncated,
    })),
    sections: built.sections.map((section) => ({
      id: section.source,
      title: section.name,
      text: section.content,
      target: section.injectionTarget,
      cache: section.cacheHint,
      chars: section.chars,
      tokens: section.tokens,
    })),
    totalChars: built.totalChars,
    totalTokens: built.totalTokens,
  };
}

/**
 * 覆盖只在同步 build 期间生效，finally 立即还原：
 * builder 读全局开关，而 set→build→restore 之间没有 await，事件循环不会在中间调度其他 turn。
 * 还原值必须显式给出可选字段（undefined 即删除），否则上一次的文本会留在全局状态里。
 */
function withSystemPromptOverrides<T>(
  overrides: ZCodeWorkspaceSystemPromptPreviewOverrides | undefined,
  build: () => T,
): T {
  const previous = { ...getSystemPromptSwitches() };
  try {
    setSystemPromptSwitches({
      securityNoticeEnabled: overrides?.securityNoticeEnabled ?? true,
      autoMemoryEnabled: overrides?.autoMemoryEnabled ?? true,
      agentsMdEnabled: overrides?.agentsMdEnabled ?? true,
      securityNoticeText: overrides?.securityNoticeText?.trim()
        ? overrides.securityNoticeText
        : undefined,
      customText: overrides?.customText?.trim() ? overrides.customText : undefined,
      sectionTexts: overrides?.sectionTexts ?? {},
    });
    return build();
  } finally {
    setSystemPromptSwitches({
      ...previous,
      securityNoticeText: previous.securityNoticeText?.trim()
        ? previous.securityNoticeText
        : undefined,
      customText: previous.customText?.trim() ? previous.customText : undefined,
      sectionTexts: previous.sectionTexts ?? {},
    });
  }
}
