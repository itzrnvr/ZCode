// 快绘临时行的一层薄状态机（纯逻辑，不依赖 React / DOM / 协议 fixture）。
//
// 它存在的唯一理由是：`conversationRows` 直读 durable store 的行**不是**权威投影，
// 必须有一份明确的规则说明它什么时候可用、什么时候必须消失、以及为什么永远不能和
// 权威状态合并。把这些规则放进 ConversationProjectionStore 里就没法单测了——
// 驱动一次 snapshot 落地需要一份合法的 ConversationSnapshot，而它有 6 个嵌套子 schema
// （control / availability / inputRouting / config / usage / queue，snapshot.ts:470-509），
// 造一份假快照既脆又会随协议演进腐烂。所以策略在这里，store 侧只剩四行委托。
//
// 三条不变量（对应 notes 里的 I1 / I2 / I3 / I8）：
// 1. 临时行永远不进 snapshot，也永远不当 delta base：delta 应用要求
//    `frame.fromSeq === snapshot.seq`（conversationProjectionStore.ts:699-706），
//    而快绘行没有任何水位（durable store 侧根本没有持久化的 event sequence）。
// 2. 整体丢弃，绝不合并：`rowId` 是 product-projection 的计数器（nextRowId++，
//    :5240-5252），跑过 hook 的会话里快绘 rowId 与权威 rowId 整体错位，
//    按 rowId 合并会拼出一份谁都不认的投影。稳定键是 entityId / turnId，
//    而 timeline 本来就按 turnId 取键（conversationTurnRenderUnits.ts:360-366），
//    所以整体替换在视觉上是同一批行。
// 3. 权威 snapshot 一旦落地，本实例**永久**拒绝再播种。
//    这条不是洁癖：projection lane 的后台折叠是 coalesced + single-flighted 的，
//    写突发会推迟它，所以一次 conversationRows 响应完全可能在首个 snapshot 之后才到，
//    那时它的行在时间上更新、但在种类上并不更正确——应用它等于用临时数据覆盖权威状态。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowsFastOutcome } from "@/v4/conversationRowsFastPath.js";

export interface ConversationFastRows {
  /** 不透明 3 段字符串；只能用 !== 比较新鲜度，不可解析、不可当 atRevision。 */
  revision: string;
  rows: readonly ConversationRow[];
  /**
   * durable store 里还有更早的行。当前不驱动任何 UI（临时窗口里分页是关闭的，
   * 见 store 的 loadOlder 在 snapshot 为 null 时直接返回），保留它是因为它是
   * 读取结果的一部分，且替换成权威 snapshot 后由 hasOlderRows 接管同一语义。
   */
  hasMore: boolean;
  seededAt: number;
}

export interface FastRowsLayer {
  /** 播下一次读取结果；返回是否真的落地（被拒绝时 false，调用方据此打日志）。 */
  seed(outcome: ConversationRowsFastOutcome, seededAt: number): boolean;
  /** 权威 snapshot 落地：清空并永久拒绝后续播种。 */
  markAuthoritative(): void;
  /** store close：清空，但不标记权威（新 store 实例会从干净状态重新开始）。 */
  clear(): void;
  read(): ConversationFastRows | null;
  /** 当前渲染的是不是临时行；行级能力降级就看这一个布尔值。 */
  isProvisional(): boolean;
}

export function createFastRowsLayer(): FastRowsLayer {
  let rows: ConversationFastRows | null = null;
  let authoritativeApplied = false;

  return {
    seed(outcome: ConversationRowsFastOutcome, seededAt: number): boolean {
      if (authoritativeApplied) return false;
      if (!outcome.ok) return false;
      // 空窗口不播种：画出来和今天的空状态一模一样，却会把整个 pane 标成 provisional
      // 从而白白降级行级能力。
      if (outcome.rows.length === 0) return false;
      // 替换而不是拼接：见文件头不变量 2。
      rows = {
        revision: outcome.revision,
        rows: outcome.rows,
        hasMore: outcome.hasMore,
        seededAt,
      };
      return true;
    },

    markAuthoritative(): void {
      authoritativeApplied = true;
      rows = null;
    },

    clear(): void {
      rows = null;
    },

    read(): ConversationFastRows | null {
      return rows;
    },

    isProvisional(): boolean {
      return rows !== null;
    },
  };
}
