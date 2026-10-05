// keep-alive 隐藏 pane 的 props 降级（纯函数，可单测）。
//
// 为什么必须收口成一个函数：主 leaf 的 keep-alive 会同时挂载最多 5 个 SessionPane
// （1 个活跃 + N=4 个隐藏），而 SessionPane 有 ~50 个 props（SessionPane.tsx:286-371），
// 其中相当一部分是**活跃任务级**或**shell 共享状态级**的。把它们原样发给隐藏 pane 会产生
// 三类真实故障，而不是「多渲染一点」这种性能问题：
// 1. `onSessionCreated` / `onSessionDeleted` 会让一个隐藏 pane 把 shell 路由改到它自己的会话上；
// 2. `summaryPanelVariantOverride` 及其 onChange 是 shell 共享状态，多个 pane 同时持有就是多个写入方互相覆盖；
// 3. `conversationFind*` / `searchResultHighlightRequest` 会让查找结果同时高亮到多个 pane 里。
// 逐条写在 JSX 里迟早会漏，所以这里是一张显式的表，并且有测试钉住「改了哪些键」。
//
// 保留（不降级）的部分同样是有意的：`paneId` / `workspacePath` / `workspaceIdentity` /
// `remoteSessionId` / `readOnly` / `isDesktop` 是 pane 身份，改了就会 remount，
// keep-alive 的收益（省掉那 1 287 ms 暖切换）当场归零；session 级的 `onOpen*` 侧栏回调
// 引用稳定，留着可以避免 reshow 时 props 身份抖动，而隐藏 pane 是 inert 的，本来也点不到。
import type { SessionPaneProps } from "@/v4/SessionPane.js";

/**
 * 必须被降级的键，集中一处。测试按这张表断言，新增活跃级 prop 时要回来加一行。
 * 分组即理由，见文件头。
 */
export const RETAINED_PANE_NEUTRALIZED_PROPS = [
  // 活跃任务级
  "activeTaskChangeSummary",
  "provider",
  "searchResultHighlightRequest",
  "activeSelectionSideChatSessionId",
  // shell 共享状态（多写入方）
  "summaryPanelVariantOverride",
  "onSummaryPanelVariantOverrideChange",
  // 会改 shell 路由
  "onSessionCreated",
  "onSessionDeleted",
  // 草稿专属
  "draftComposerHeader",
  "onDropTargetControllerChange",
  // workspace 级状态：发给 4 个隐藏 pane 只会让每次 git 轮询多渲染 4 次
  "gitSummary",
  "gitDirtyFileCount",
  "gitWorktreeReviewSourceId",
  "gitWorktreeChangeSummary",
  "onRefreshGit",
  "onOpenGitReview",
  // 查找 / 高亮只属于可见 pane
  "conversationFindQuery",
  "conversationFindActiveIndex",
  "conversationFindNavigationRequestId",
  "onConversationFindMatchStateChange",
  // 可见性 / 焦点
  "focused",
  "telemetryVisible",
] as const;

export type RetainedPaneNeutralizedProp = (typeof RETAINED_PANE_NEUTRALIZED_PROPS)[number];

/**
 * 由活跃 pane 的 props 派生出隐藏保留 pane 的 props。
 *
 * `openTrigger` 刻意不捕获成 per-pane 的历史值：它只喂 telemetry
 * （SessionPane.tsx:290 的低基数打开入口），而隐藏 pane 的 `telemetryVisible` 是 false，
 * 根本不上报；为它多存一份状态换不到任何可观测收益。
 */
export function resolveRetainedPaneProps(
  active: SessionPaneProps,
  retainedSessionId: string,
): SessionPaneProps {
  return {
    ...active,
    sessionId: retainedSessionId,
    focused: false,
    // 这个 prop 的存在理由就是「forceMount 的隐藏 tab 传 false」（SessionPane.tsx:316-320）。
    telemetryVisible: false,
    activeTaskChangeSummary: undefined,
    provider: undefined,
    searchResultHighlightRequest: null,
    activeSelectionSideChatSessionId: null,
    summaryPanelVariantOverride: undefined,
    onSummaryPanelVariantOverrideChange: undefined,
    onSessionCreated: undefined,
    onSessionDeleted: undefined,
    draftComposerHeader: undefined,
    onDropTargetControllerChange: undefined,
    gitSummary: undefined,
    gitDirtyFileCount: undefined,
    gitWorktreeReviewSourceId: undefined,
    gitWorktreeChangeSummary: undefined,
    onRefreshGit: undefined,
    onOpenGitReview: undefined,
    conversationFindQuery: "",
    conversationFindActiveIndex: -1,
    conversationFindNavigationRequestId: 0,
    onConversationFindMatchStateChange: undefined,
  };
}

/**
 * 隐藏方式的类名。
 *
 * 用 opacity-0 + pointer-events-none 而**不是** hidden / display:none，两条理由：
 * 1. `RootWorkspaceContent.tsx:113-123` 已经为同一个问题记了三种失效：Radix 菜单关闭动画
 *    期间锚点节点退出布局会让 Floating UI 丢定位参考（内容先闪到左上角）；整棵子树
 *    visibility:hidden 的那一帧会被部分平台当成一次突兀的可见性切换；子树里的弹层会继承
 *    display:none，导致「状态已打开但完全看不见」。
 * 2. display:none 会把滚动容器的 clientHeight 归零，虚拟器的测量随之作废，reshow 时要
 *    整列重测——而 keep-alive 的全部意义就是省掉那次重挂载与重测。
 * 配合 inert 阻断焦点与命中测试（只用 opacity + pointer-events 时，底层权限卡片的
 * autofocus 仍会抢走焦点，同一段注释里也记了这一点）。
 */
export const RETAINED_PANE_HIDDEN_CLASS_NAME = "absolute inset-0 opacity-0 pointer-events-none";
