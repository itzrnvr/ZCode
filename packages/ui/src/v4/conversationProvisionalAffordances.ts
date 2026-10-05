// 快绘（provisional）窗口里的行级能力降级：一处收口，避免各处各猜。
//
// 背景：`conversationRows` 快绘行来自 durable store，**算不出** `turnHeader.fileChanges`
// 与由它派生的 `actions.canRewindFiles`——两者都要 `buildColdFileChangeSummaries`，
// 而它依赖 CheckpointCreated 内存事件 + `record.app.readToolResultArtifact`，
// 都绑定 activation（projection lane 已逐字段核实）。契约写得很清楚：
// 缺席的含义是「还没算出来」，绝不是「这一轮没改文件」。
//
// 这个区别不是措辞问题，它会变成两句假话：
// 1. `ConversationTurnGroup.tsx:1226-1235` 原本对 fileChanges 缺席返回
//    `reason: "noFiles"`，而 `ConversationRowView.tsx:910-915` 会把这个 reason 直接
//    插进 i18n id 生成一句解释文案 —— 于是一个确实改过文件的轮次，在快绘的几百毫秒里
//    会告诉用户「没有可撤销的文件改动」。
// 2. `useAssistantPreviewCardsForRow.ts:83-120` 用
//    `requestKey = rowId:entityId:(fileChangesState ?? "unknown")` 做幂等键。快绘期
//    `fetchFileChanges` 会拿到 SessionPane 的空占位结果（`SessionPane.tsx:1596-1603`，
//    snapshotRef 为 null），把 paths 存成空；而权威 snapshot 里
//    `fileChanges.state` 也是 optional（`rows.ts:93`），键可能**一模一样**，
//    effect 不再重跑 —— md/html 预览卡片就此永久消失。
//
// 处理方式沿用本仓库既有的「缺席即不提供」写法（`conversationRowContext.ts:101-109`
// 的 onCancelBackgroundWork、`ConversationRowView.tsx:548,563` 的 readAttachmentRange）：
// 快绘期这些能力在 rowContext 上**缺席**，权威 snapshot 落地后自动恢复，
// effect 依赖变化会重新触发正确的那次读取。
import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { EditWorkspaceRewindAvailability } from "@/v4/ConversationRowView.js";
/**
 * 快绘窗口里必须静默的行级能力清单。
 *
 * 这份清单是「检查点」而不是运行时数据：SessionPane 在对应 props 上逐个用
 * `provisionalRows ? undefined : handler` 落地，新增行级能力时必须回来加一行，
 * 否则会漏掉这道门。逐项理由：
 * - fetchFileChanges：需要 baseRevision + baseLogEpoch（`SessionPane.tsx:1626-1630`），
 *   快绘行没有任何水位，发出去只能拿到空占位结果，而那个空结果会被
 *   `useAssistantPreviewCardsForRow.ts:83-120` 按 requestKey 锁死（见文件头第 2 条）。
 * - previewFileRewind / applyFileRewind：同样按水位取值（`SessionPane.tsx:1667+`），
 *   且 applyFileRewind 是写操作。两者在 onEdit 被降级之后其实已经传递性不可达
 *   （撤销按钮在编辑态里，编辑入口没了就进不去），仍然显式列出来，因为这份清单是
 *   检查点：将来有人给撤销加第二个入口时，这道门不会自动失效。
 * - onFork / onRetry / onEdit：命令目标是 `ConversationRowTarget {rowId, entityId}`，
 *   而快绘 rowId 是 product-projection 的计数器（`nextRowId++`，:5240-5252），
 *   跑过 hook 的会话里与权威 rowId 整体错位。服务端 `resolveRowActionTarget`
 *   （:757-768）要求 rowId 与 entityId 同时命中，错位只会干净地回
 *   `proto.staleTarget`，不会改错行——所以这是 UX 门（别给一个点了就报错的按钮），
 *   不是防腐门。
 */
export const PROVISIONAL_SUPPRESSED_ROW_AFFORDANCES = [
  "fetchFileChanges",
  "previewFileRewind",
  "applyFileRewind",
  "onFork",
  "onRetry",
  "onEdit",
] as const;

export type ProvisionalSuppressedRowAffordance =
  (typeof PROVISIONAL_SUPPRESSED_ROW_AFFORDANCES)[number];

/**
 * 撤销工作区文件的可用性。从 `ConversationTurnGroup.tsx:1226-1235` 原地提取，
 * 判定顺序逐条保持不变，只在最前面加一条 provisional 分支——这样它可以在没有 DOM
 * 的情况下被单测覆盖（本仓库测试栈没有组件渲染能力，见 test/ 目录约定）。
 */
export function resolveEditWorkspaceRewindAvailability(input: {
  /** 当前渲染的是快绘临时行（权威 snapshot 尚未到达）。 */
  provisional: boolean;
  fileChanges: TurnHeaderRow["fileChanges"];
  isRunning: boolean;
  canRewindFiles: boolean | undefined;
}): EditWorkspaceRewindAvailability {
  const { fileChanges } = input;
  // 「还不知道」必须先于「没有文件」判定，否则快绘期一律落到 noFiles 那句假话。
  if (input.provisional && fileChanges === undefined) {
    return { enabled: false, reason: "pending" };
  }
  if (!fileChanges || fileChanges.files <= 0) return { enabled: false, reason: "noFiles" };
  if (fileChanges.state === "reverted") return { enabled: false, reason: "reverted" };
  if (input.isRunning) return { enabled: false, reason: "running" };
  if (input.canRewindFiles !== true) return { enabled: false, reason: "unavailable" };
  return { enabled: true, reason: "available" };
}

/**
 * 撤销按钮的解释文案 id；null = 只显示按钮标题、不显示解释句。
 *
 * 收口在这里而不是在 JSX 里插值，是为了防止以后往 reason 闭集加值时
 * 悄悄拼出一个不存在的 message id（今天的写法就是把 reason 直接插进 id）。
 * `pending` 与 `available` 一样没有解释句：前者是「还不知道」，任何现成文案都会变成
 * 一句假话；后者本来就可用。`reason` 缺席时保持今天的行为（回落 noFiles 文案），
 * 因为只读/分享等调用点确实不传这个 prop。
 */
export function resolveEditRewindExplanationMessageId(
  reason: EditWorkspaceRewindAvailability["reason"] | undefined,
): string | null {
  if (reason === "available" || reason === "pending") return null;
  return `chat.edit.resetConversationAndFiles.${reason ?? "noFiles"}`;
}
