import type { MessageWithParts } from "@zcode/contracts";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "./cold-event-merge.js";
import { ProductProjection } from "./product-projection.js";

/**
 * conversation projection store（0024）的折叠器。
 *
 * 与 v4-bridge 的 record-less hydration（`loadPersistedEventsWithoutRecord`）是**同一份三段归约**，
 * 差别只在最后一段：那边把事件交给 gateway 去建活投影，这边接着折成行并落到 SQLite，于是
 * view 路径的点击开销里不再有任何折叠。两条路的六个 merge 输入逐项相同（见下），所以
 * 「有没有先经过这里」不会让行分叉 —— 这正是 parity 测试断言的东西。
 *
 * 刻意不 import `PersistedConversationMaterializationStore`：那个 interface 在 cold-event-merge.ts
 * 里未导出（该文件属 cache lane）。改成从**已导出函数的签名**派生，与 v4-bridge.ts 的
 * `ColdMaterializationStore` 同一手法：派生体就是真参数类型，契约增员自动跟随，也不必改别人的文件。
 */
export type ProjectionMaterializationStore = NonNullable<
  Parameters<typeof loadPersistedConversationMaterialization>[0]["store"]
>;

/**
 * 折叠用的 logEpoch。行里不含 epoch（它只进 snapshot.logEpoch），所以这个常量不影响行的逐字相等；
 * 固定下来是为了让两次折叠的 snapshot 完全可比，也给日志一个可 grep 的来源标记。
 */
export const CONV_PROJECTION_LOG_EPOCH = "conversation-projection-store";

/**
 * 从持久事实折出整份行目录（不是 60 行窗口：`snapshotTailWindowRows` 的截尾只发生在
 * conversation-topic-publisher 的下发口，ProductProjection 自己不裁）。
 *
 * 三个输入是刻意的：
 * - `memoryEvents: []` —— 没有 record 就没有内存事件。缺席项即 ruling 3 记的 limitations：
 *   turnHeader.fileChanges（源是 CheckpointCreated 内存事件 + record.app.readToolResultArtifact）、
 *   整个 hookInvocation kind（HookRun* 没有任何持久合成点）、toolCall 的 pendingApproval /
 *   outputPreview、subagent 的 backgrounded / workId。record-less 的 bridge 分支同样拿不到这些
 *   （它的 artifact reader 直接抛 fault.hydrate.artifactReaderRequiresRuntime），所以两边一致。
 * - `contextWindow` 省略 —— 它只进 snapshot.usage / config（onSessionCreated 返回 []，
 *   onModelSelected / onModelComplete 只发 state.updated），从不进任何一行，因此行逐字相同。
 * - `persistedMessages` 必须**显式**传入，不能让 store 自己读：bridge 的窄面刻意不转发
 *   messagesTail（裸尾部读对 revert/fork 选不出版本正确的活跃分支，实测 2703-part 会话被截成
 *   6 条消息 -> 空会话），于是它的回落是全量 messages()。而 turnId 是 `hydrate-turn-${turnNumber}`，
 *   turnNumber 从**传入数组的第一条**开始数 —— 全量与 500 尾部对 >500 part 的会话会数出不同的
 *   turn 序号，rowId 与 turnId 双双分叉。所以这里只接受调用方按 resume / 视图冷物化同一条约定
 *   （readPersistedSessionMessages，messagesTail limit=500）取来的那一份尾读。
 *
 * 仍必须经过 `loadPersistedConversationMaterialization` 而不是直接折裸尾：它内部会跑
 * `selectActiveConversationBranch`，绕过它就是在复刻上面那条被实测钉住的 bug。
 */
export async function buildConversationProjectionRows(
  sessionId: string,
  store: ProjectionMaterializationStore,
  persistedMessages: readonly MessageWithParts[],
): Promise<ConversationRow[]> {
  const source = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    persistedMessages: persistedMessages as MessageWithParts[],
    sessionId,
    store,
  });
  const merged = mergeColdConversationEvents({
    memoryEvents: [],
    messages: source.messages,
    sessionId,
    goalVerificationEntries: source.goalVerificationEntries,
    // hasOwnProperty 才是 authority：显式 null 抑制 memory TargetChanged，缺键不抑制。
    // 逐字镜像 bridge 两个分支（record 与 record-less）的同一段展开——两处写法相同，
    // 说明这是契约而不是某一条路径的巧合。
    ...(Object.prototype.hasOwnProperty.call(source, "target") ? { target: source.target } : {}),
  });

  const projection = new ProductProjection(sessionId, CONV_PROJECTION_LOG_EPOCH);
  projection.beginHydrationReplay();
  for (const event of merged.events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay();
  // getSnapshot() 返回的是活引用，hydration accumulator 原地改 rows.window；
  // completeHydrationReplay() 之后立刻浅拷贝一份再交出去，调用方随后才 await（读水位、开事务），
  // 不能让一个可变数组跨 await 存活。
  return projection.getSnapshot().rows.window.slice();
}
