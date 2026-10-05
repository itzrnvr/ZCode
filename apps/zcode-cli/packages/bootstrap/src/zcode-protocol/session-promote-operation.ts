import type { PromoteSelectionSideChatResult, SessionId } from "@zcode/contracts";
import type { ZCodeSessionPromoteSideChatResult } from "@zcode/shared";
import { zcodeSessionPromoteSideChatParamsSchema } from "@zcode/shared";
import {
  parseParams,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * `session/promoteSideChat` —— 把框选副屏提升为正式会话。
 *
 * 为什么单独一个文件而不是塞进 server-operations.ts：那个文件已经 4172 行，而 0024 的
 * `conversation-rows-operation.ts` 已经立了 "一个操作一个模块 + server.ts 一行 case" 的先例。
 * 与那条不同的是，本操作**是**写操作，因此走 store 的写门禁（throwBeforeWrite）而不是
 * 只读快路径；但它同样不进 requireV4Gateway()——提升只改会话归属，不需要 v4 网关在场，
 * 而 `requireV4Gateway()` 在网关缺席时会把整个操作打成 -32603。
 *
 * 语义边界（与 fork 的区别）：不复制任何 message/part，不换 session id，只把
 * `task_type` selection_side_chat -> interactive 并清掉 `parent_id`。副屏里已有的上下文
 * 因此原样保留。`commands/executor.ts` 里禁止副屏 `forkAssistant` 的那道闸**不动**：
 * 它读的是活记录的 taskType，提升之后这个会话自然不再是副屏，闸门对剩下的副屏依旧成立。
 */

/**
 * 存储面的结构化窄接口。沿用本仓既有写法（server-operations.ts 的 SessionStoreWithTail /
 * hasMessagesTail、conversation-rows-operation.ts 的 ConversationProjectionStore）：
 * 端口上只加一个可选方法，能力探测在宿主侧收窄，旧宿主缺席时给结构化错误而不是崩。
 */
interface SessionPromoteStore {
  promoteSelectionSideChat(input: {
    id: SessionId;
    title?: string;
  }): Promise<PromoteSelectionSideChatResult>;
}

function hasPromoteCapability(store: unknown): store is SessionPromoteStore {
  if (!store || typeof store !== "object") return false;
  const candidate = store as Partial<SessionPromoteStore>;
  return typeof candidate.promoteSelectionSideChat === "function";
}

export async function promoteSessionSideChat(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSessionPromoteSideChatResult> {
  const params = parseParams(zcodeSessionPromoteSideChatParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  if (!store || !hasPromoteCapability(store)) {
    // -32003 与 "Cannot import session history without session store" 同码：都是
    // "这个宿主没有能完成该操作的存储面"。调用方（services 的 task adapter）据此降级。
    throw new ProtocolRequestError(
      -32003,
      "Cannot promote a side chat without a session store that supports it",
    );
  }

  const sessionId = String(params.sessionId);
  const result = await store.promoteSelectionSideChat({
    id: sessionId as SessionId,
    ...(params.title !== undefined ? { title: params.title } : {}),
  });

  const record = context.sessions.get(sessionId);
  if (result.promoted && record) {
    // 活记录必须与存储层同步翻，否则三处会继续把它当副屏：
    //  - v4-bridge.ts getSessionWorkspaceId 用 isTaskListSessionType(record.taskType)
    //    决定这个会话属不属于 sessions-index；
    //  - commands/executor.ts 的 SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS 用 record.taskType
    //    挡住 forkAssistant / retryTurn 等命令；
    //  - server-operations.ts listSessionSideChats 用 record.taskType + parentSessionId
    //    把它列进副屏目录（提升后它必须从那个目录里消失）。
    record.taskType = "interactive";
    delete record.parentSessionId;
    // CAS 命中就说明 session 行确实存在，draft 判定随之落定：persistence 仍是 deferred 的话
    // v4-bridge isDraftSession 会把它当草稿，sessions-index 直接跳过。
    if (record.persistence === "deferred") record.persistence = "immediate";
    // 与 setModel / setMode / fork 等记录变更同一约定：bump 一次，让按 revision 做乐观并发的
    // 客户端看得见这次变更。**不**动 record.updatedAt——它是 sessions-index 的 lastActivityAt
    // 事实源，提升不是用户会话活动，动它会把一个旧副屏顶到侧栏最前（与 store 侧
    // 故意不写 time_updated 同一个理由）。
    record.stateRevision++;
  }

  return {
    promoted: result.promoted,
    sessionId,
    title: result.session?.title ?? null,
    taskType: result.session?.taskType ?? null,
  };
}
