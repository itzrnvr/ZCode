// pane keep-alive 栈（纯逻辑，不依赖 React / DOM）。
//
// 为什么需要它：两个已挂载会话之间的暖切换实测 1 287 ms，而从空 pane 暖开是
// 3 251 ms（common.md 基线），两者都是 renderer-bound——数据层其实早就暖了
// （SessionDataLayer 引用归零后还有 30 s keep-warm，sessionDataLayer.ts:30,145-155，
// store 与 snapshot 都还在），这 1 287 ms 纯粹是 SessionPane 整棵子树重新挂载 +
// 首绘 + 滚动恢复。所以留住的是**已挂载的 React 子树**，不是数据。
//
// 本仓库已有同类做法：侧栏 tab 用 Radix forceMount 常驻（AnimatedSidePanePanel.tsx:1094-1100、
// Terminal.tsx:359-382），设置页覆盖期间整个 workspace 壳层常驻（RootWorkspaceContent.tsx:101-123）。
// 差别只在于这里要按 LRU 限量，因为主 leaf 是热路径、且每个常驻 pane 都持有一份租约。
//
// 只负责「留谁、按什么顺序留」；隐藏方式与 props 降级在 WorkbenchPane 侧，
// 因为那两件事必须和真实 React 树一起看。
export interface PaneKeepAliveEntry {
  sessionId: string;
  /** 最近一次成为活跃 pane 的时刻；只用于诊断与测试断言，淘汰按插入序。 */
  touchedAt: number;
}

export interface PaneKeepAliveStack {
  /**
   * 把一个会话标记为活跃并返回保留顺序（最久未用在前，活跃项在末尾）。
   * `null`（草稿）永不保留：草稿 pane 的身份是 workspace 而不是会话。
   */
  touch(sessionId: string | null): readonly string[];
  /** 这些会话已由别的 leaf 承载，从保留集里剔除（同一会话两个活 pane 会重复副作用）。 */
  exclude(sessionIds: ReadonlySet<string>): readonly string[];
  /** 主动丢弃（会话被删除 / pane 关闭）。 */
  drop(sessionId: string): void;
  /** 当前保留的会话，最久未用在前。 */
  entries(): readonly string[];
  size(): number;
}

export interface PaneKeepAliveOptions {
  /** 隐藏的保留上限 N；不含当前活跃项。 */
  maxHidden: number;
  now?: () => number;
  /** 被淘汰时回调，宿主据此记录日志（淘汰本身只是不再渲染，卸载由 React 完成）。 */
  onEvict?: (sessionId: string) => void;
}

/** 规格给定的 N=4：4 个隐藏 + 1 个活跃 = 主 leaf 最多 5 个已挂载 SessionPane。 */
export const DEFAULT_PANE_KEEP_ALIVE_MAX_HIDDEN = 4;

export function createPaneKeepAliveStack(options: PaneKeepAliveOptions): PaneKeepAliveStack {
  const now = options.now ?? (() => Date.now());
  // Map 迭代序 = 插入序；delete+set 即 LRU touch，与
  // timelineRowHeightCache.ts:32-34 / chatSessionScrollMemory.ts:22-24 同一写法。
  const retained = new Map<string, PaneKeepAliveEntry>();
  let activeSessionId: string | null = null;

  const prune = (): void => {
    while (retained.size > options.maxHidden) {
      const oldest = retained.keys().next();
      if (oldest.done) break;
      // 活跃项不参与淘汰：它排在末尾（刚 touch 过），只有 maxHidden < 0 才可能命中。
      if (oldest.value === activeSessionId) break;
      retained.delete(oldest.value);
      options.onEvict?.(oldest.value);
    }
  };

  const order = (): readonly string[] => [...retained.keys()];

  return {
    touch(sessionId: string | null): readonly string[] {
      if (sessionId === null || sessionId.trim() === "") {
        activeSessionId = null;
        return order();
      }
      activeSessionId = sessionId;
      retained.delete(sessionId);
      retained.set(sessionId, { sessionId, touchedAt: now() });
      prune();
      return order();
    },

    exclude(sessionIds: ReadonlySet<string>): readonly string[] {
      // 直接迭代 Map 的 key 迭代器：循环体里只删「当前这一项」，而 Map 迭代器按插入序
      // 访问、删掉当前项是规范内安全的（不需要先拷一份数组）。
      for (const sessionId of retained.keys()) {
        if (sessionId === activeSessionId) continue;
        if (!sessionIds.has(sessionId)) continue;
        retained.delete(sessionId);
        options.onEvict?.(sessionId);
      }
      return order();
    },

    drop(sessionId: string): void {
      if (activeSessionId === sessionId) activeSessionId = null;
      retained.delete(sessionId);
    },

    entries: order,

    size(): number {
      return retained.size;
    },
  };
}
