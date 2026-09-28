import type { ModelToolContract } from "../deps.js";
import { registerBuiltInTools } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "../helpers/tool-allowlist.js";
import { isToolNameDisallowed } from "../../tool/tool-visibility.js";
import type { AgentProfile } from "../../subagent/profile.js";
import { buildNewAgentProfilesAvailableBody } from "../../subagent/profile.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";

export function resolveRuntimeEmbeddedSearchEnabled(runtime: AgentRuntimeInternal): boolean {
  const builtInToolAllowlist = resolveBuiltInToolAllowlist(runtime.config);
  const decision = resolveEmbeddedSearchBranchCapability({
    bashAvailable:
      (builtInToolAllowlist === undefined || builtInToolAllowlist.includes("Bash")) &&
      !isToolNameDisallowed("Bash", runtime.config.toolDisallowlist),
  });
  return decision.useEmbeddedSearchBranch;
}

/**
 * #23：新 profile 名集合判脏（新增、删除、重命名触发；纯正文改不动名字则不打扰模型）。
 * 供 bootstrap 在 turn 边界做“是否需要重建 Agent/Task 描述”的判断。
 */
export function subagentProfileNameSetChanged(
  previous: readonly AgentProfile[],
  current: readonly AgentProfile[],
): boolean {
  return !sameAgentProfileNameSet(previous, current);
}

function sameAgentProfileNameSet(
  left: readonly AgentProfile[],
  right: readonly AgentProfile[],
): boolean {
  if (left.length !== right.length) return false;
  const names = new Set(left.map((profile) => profile.name));
  if (names.size !== left.length) return false;
  for (const profile of right) {
    if (!names.has(profile.name)) return false;
  }
  return true;
}

/** #23：把新增名包装成一次性的 turn 级系统提示 entry（调用方决定是否提交）。 */
export function buildNewAgentProfilesNoticeEntry(names: readonly string[]) {
  if (names.length === 0) return null;
  return systemReminderAttachmentEntry(
    "shell_environment_change",
    buildNewAgentProfilesAvailableBody(names),
  );
}

export function refreshBranchAwareBuiltInTools(runtime: AgentRuntimeInternal): void {
  const embeddedSearchEnabled = resolveRuntimeEmbeddedSearchEnabled(runtime);
  if (embeddedSearchEnabled) {
    runtime.registry.unregister("Glob");
    runtime.registry.unregister("Grep");
  }

  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    embeddedSearchEnabled,
    // 本函数是**第二个**
    // 注册入口，且刻意只传一个精简选项集。对「只有 true 才注册」的门（OffPeak / Cron / Workflow…）
    // 省略是安全的；但动态工作流灰度门的极性相反——「缺席即开启」，省略等于把首次装配剃掉的
    // 十个工具在 shell 快照初始化时原样加回来（registry.register 会覆盖同名项，
    // silentDuplicateWarnings 还把告警吞掉，所以全程无声）。推导因此必须与 runtime-tools.ts
    // 共用同一个 helper，不能在这里重写一遍判断。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime.config),
    agentProfiles: runtime.config.subagents?.profiles,
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    disallowedTools: runtime.config.toolDisallowlist,
    silentDuplicateWarnings: true,
  });
  runtime.cachedTools = null;
}

export function filterEmbeddedSearchRuntimeVisibleTools(
  runtime: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  if (!resolveRuntimeEmbeddedSearchEnabled(runtime)) return tools;
  return tools.filter((tool) => tool.name !== "Glob" && tool.name !== "Grep");
}
