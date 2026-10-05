// timeline 首绘期的虚拟窗口 overscan 策略（纯函数）。
//
// 事实依据：timeline 一直是虚拟化的（ConversationTimeline.tsx 的 useVirtualizer，
// overscan = ROW_OVERSCAN = 8），并没有「小于阈值就全渲染」的分支。但冷开时窗口里的
// turn unit 本来就少——实测 unitCount = 3（D:/tmp/ab/trace-summary.json，同一次
// msToFirstRows 1176 ms、longTasksOver50ms = 0），8 的 overscan 足以把**整份列表**
// 纳入挂载窗口。这就是基线里「1 500 ms renderer busy = painting ALL turn units」的真实
// 机制：不是虚拟化失效，是 overscan 在小列表上等价于全量挂载。
//
// 所以这里只调一个旋钮，不新造一套虚拟化。首绘未落定前用小 overscan，落定后立刻回到 8。
// 「落定」= 首个 idle 回调，或用户第一次滚动，谁先到算谁——后者保证「一上来就滚」的用户
// 永远看不到空窗（忙渲染时 idle 回调可能被无限推迟，只靠它是不够的）。
//
// 收益要老实说：同一份实测里 busyMs 只有 410、idlePct 92.5，所以这是几个杠杆里最小的
// 一个。它的价值是给「60 行 x 每行最多 32 KiB head + 32 KiB tail 工具输出」
// （shared core.ts 的 toolOutputFinalHeadBytes / toolOutputFinalTailBytes）这种肥尾窗口
// 兜底，不是一个可以拿来当标题的数字。
//
// 两个触发源（idle 落定 / 用户滚动）效果相同且都是单向的，所以调用侧合并成一个
// escalated 布尔值；这里不再区分它们，避免留一个永远与另一个同值的参数。

/** 常态 overscan。 */
export const SETTLED_ROW_OVERSCAN = 8;

/** 首绘未落定时的 overscan：只留可见区上下各两行。 */
export const INITIAL_ROW_OVERSCAN = 2;

/** idle 落定的兜底超时：窗口被遮挡时 idle 回调会被节流，不能只靠它。 */
export const FIRST_PAINT_SETTLE_IDLE_TIMEOUT_MS = 1000;

export function resolveTimelineOverscan(state: {
  /** 首个 idle 回调已跑过，或用户已经滚动过。 */
  escalated: boolean;
  /** 当前窗口里的 turn unit 数；0 时取哪个值都无所谓，返回常态值避免无谓重建。 */
  unitCount: number;
}): number {
  if (state.escalated || state.unitCount === 0) return SETTLED_ROW_OVERSCAN;
  return INITIAL_ROW_OVERSCAN;
}
