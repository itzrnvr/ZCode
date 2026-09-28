/**
 * #4：快滚时跳过行内容绘制的判定（纯函数，无 DOM/React 依赖）。
 *
 * 实测依据（真实 renderer，CDP，同一会话交替测量，同一 scrollHeight）：
 * | 滚动速度 | 不跳过 | 跳过绘制 |
 * |---|---|---|
 * | 0.35 viewport/帧 | p50 15.9 ms，>32ms 14/160 | p50 11.8 ms，>32ms 5.5/160 |
 * | 1.5 viewport/帧（猛甩） | p50 40.3 ms，>32ms 112/160，>50ms 49/160 | p50 31.0 ms，>32ms 75/160，>50ms 32/160 |
 * 即：已挂载行内容的**绘制**约占每帧成本的 25%。
 *
 * 反例（同样实测）：用 `content-visibility: hidden` 连布局一起跳过会让 p50 从 41 ms
 * 恶化到 77.8 ms —— 行高被换成估值后虚拟列表反复重测重排。所以这里只跳**绘制**
 * （`visibility: hidden`），布局与测高保持真实，虚拟列表几何不受影响。
 *
 * 只在“猛甩”档位生效：连续两帧位移达到 0.8 倍视口高才进入，连续两帧低于阈值才退出
 * （滞回，避免单次事件尖峰造成闪烁）；此时内容本就是一片拖影，停下即恢复。
 */

/** 进入判定：单帧位移达到视口高度的这个比例即算“猛甩”。 */
export const TIMELINE_FAST_SCROLL_VIEWPORT_FRACTION = 0.8;
/** 连续多少帧满足条件才进入/退出，抑制单次尖峰导致的闪烁。 */
export const TIMELINE_FAST_SCROLL_ENTER_STREAK = 2;
export const TIMELINE_FAST_SCROLL_EXIT_STREAK = 2;

export interface TimelineFastScrollState {
  fastStreak: number;
  slowStreak: number;
  /** true = 当前应跳过行内容绘制（容器上挂 data-v4-fast-scrolling="true"）。 */
  skipping: boolean;
}

export const INITIAL_TIMELINE_FAST_SCROLL_STATE: TimelineFastScrollState = {
  fastStreak: 0,
  slowStreak: 0,
  skipping: false,
};

export type TimelineScrollDeltaClass = "fast" | "slow";

export function classifyTimelineScrollDelta(
  input: { deltaPx: number; viewportHeight: number },
  viewportFraction: number = TIMELINE_FAST_SCROLL_VIEWPORT_FRACTION,
): TimelineScrollDeltaClass {
  const { deltaPx, viewportHeight } = input;
  if (!Number.isFinite(deltaPx) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    // 几何不可信时按“慢”处理：宁可多绘制，也不要把内容藏起来。
    return "slow";
  }
  return Math.abs(deltaPx) >= viewportHeight * viewportFraction ? "fast" : "slow";
}

export function advanceTimelineFastScrollState(
  state: TimelineFastScrollState,
  input: { deltaPx: number; viewportHeight: number },
): TimelineFastScrollState {
  const classification = classifyTimelineScrollDelta(input);
  if (classification === "fast") {
    const fastStreak = state.fastStreak + 1;
    return {
      fastStreak,
      slowStreak: 0,
      skipping: state.skipping || fastStreak >= TIMELINE_FAST_SCROLL_ENTER_STREAK,
    };
  }
  const slowStreak = state.slowStreak + 1;
  return {
    fastStreak: 0,
    slowStreak,
    skipping: slowStreak >= TIMELINE_FAST_SCROLL_EXIT_STREAK ? false : state.skipping,
  };
}
