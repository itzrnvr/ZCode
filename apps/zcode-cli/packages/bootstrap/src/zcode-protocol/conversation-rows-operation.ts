import type { MessageWithParts, SessionEntryInfo, SessionGoal, SessionId, SessionInfo } from "@zcode/contracts";
import {
  PROTOCOL_V4_LIMITS,
  v4ConversationRowsParamsSchema,
  type ConversationRow,
  type V4ConversationRowsResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  CONV_PROJECTION_SCHEMA_VERSION,
  type ConversationProjectionSink,
  type ProjectionMeta,
  type ProjectionView,
  type StoredProjectionRow,
} from "@zcode/adapters/storage";
import {
  buildConversationProjectionRows,
  type ProjectionMaterializationStore,
} from "../zcode-protocol-v4/conversation-projection-store.js";
import { readPersistedSessionMessages } from "./server-operations.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * `v4/conversation/rows` —— 会话投影的持久化快路径（0024）。
 *
 * 与 `v4/conversation/rowsRange` 的区别只有一个：数据源。rowsRange 读活投影，冷会话要先
 * `ensureResumed` -> `app.resume()`，实测 4663ms 的运行时构造会重新回到点击路径上；这条只读
 * SQLite 里写入时增量物化下来的行，因此可以在**不激活 runtime**的前提下同步返回。
 *
 * ── 车道占用是本文件的硬约束，不是风格 ──
 * bootstrap/src/zcode-protocol/transport.ts:186-195 把每条非 response 消息串到同一个 FIFO
 * promise 上，shouldBypassProcessingQueue（:224-233）只放行 sessionStop 与
 * workspaceCancelGenerateText。renderer 必须先发本方法再发 subscribe（slot 1 的 view-only
 * hydration 就跑在 subscribe 里），所以本 handler 只要 await 一次折叠，就会把整条车道占住
 * 0.7~2s，把冷视图物化挤到后面 —— 首屏更早出行，权威快照却更晚，是伪装成优化的回退。
 * 于是：**任何路径都不折叠、不激活、不读 transcript、不拿写锁**。
 * 缺失/过期一律立刻回 ok:false 并把折叠丢到后台；客户端重试很便宜（无行的响应不触发
 * ~579ms 的反序列化），而折叠只在后台跑一次。
 */

/** 连续丢弃上限：超过就交给 pull-on-read 收口，避免持续写入的会话变成热折叠循环。 */
const MAX_CONSECUTIVE_DISCARDS = 3;

/**
 * 0024 的存取面。刻意做成**结构化窄接口**而不是往 SessionStorePort 上加方法：
 * ruling 3 只批一个可选端口方法（notifyConversationProjectionDirty），而这些成员是具体
 * SqliteSessionStore 的能力，沿用本仓既有的运行时收窄写法（server-operations.ts 的
 * SessionStoreWithTail / hasMessagesTail，getUsageStats 的 as Partial<UsageStorePort>）。
 */
interface ConversationProjectionStore {
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  sessionEntries?(input: { sessionID: SessionId; type?: string }): Promise<SessionEntryInfo[]>;
  readConversationProjectionWatermark(sessionID: SessionId): Promise<number>;
  readConversationProjectionView(
    sessionID: SessionId,
    opts: { beforeRowId?: number; limit: number },
  ): Promise<ProjectionView>;
  commitConversationProjection(input: {
    sessionID: SessionId;
    expectedSeq: number;
    revision: string;
    schemaVersion: number;
    rows: readonly StoredProjectionRow[];
  }): Promise<{ committed: boolean; rewritten: number }>;
  deleteConversationProjection(sessionID: SessionId): Promise<void>;
  setConversationProjectionSink(sink: ConversationProjectionSink | null): void;
}

function hasConversationProjection(store: unknown): store is ConversationProjectionStore {
  if (!store || typeof store !== "object") return false;
  const candidate = store as Partial<Record<keyof ConversationProjectionStore, unknown>>;
  return (
    typeof candidate.getSession === "function" &&
    typeof candidate.messages === "function" &&
    typeof candidate.readTarget === "function" &&
    typeof candidate.readConversationProjectionWatermark === "function" &&
    typeof candidate.readConversationProjectionView === "function" &&
    typeof candidate.commitConversationProjection === "function" &&
    typeof candidate.deleteConversationProjection === "function" &&
    typeof candidate.setConversationProjectionSink === "function"
  );
}

interface FoldState {
  running: boolean;
  pending: boolean;
}

interface ProjectionFoldHost {
  context: ZCodeProtocolAgentServerContext;
  store: ConversationProjectionStore;
  states: Map<string, FoldState>;
}

// 按 store 实例分桶：多个 SqliteSessionStore（测试里很常见）各自一套折叠状态，
// sessionId 不会跨库串台。WeakMap 让 host 随 store 一起回收。
const foldHosts = new WeakMap<object, ProjectionFoldHost>();
const installedStores = new WeakSet<object>();

function revisionOf(timeUpdated: number, seq: number): string {
  return `${timeUpdated}:${seq}:${CONV_PROJECTION_SCHEMA_VERSION}`;
}

/**
 * 幂等安装折叠 sink，返回 host。
 *
 * 两处调用：server 构造期（Main 批的 eager 变体，让后台预热在任何点击之前就开始累积）
 * 与本 handler 首行（lazy 兜底，宿主没走那条构造线时仍然工作）。
 */
export function installConversationProjectionSink(
  context: ZCodeProtocolAgentServerContext,
): ProjectionFoldHost | null {
  const store = context.deps.sessionStore;
  if (!store || !hasConversationProjection(store)) return null;
  let host = foldHosts.get(store);
  if (!host) {
    host = { context, store, states: new Map() };
    foldHosts.set(store, host);
  }
  if (!installedStores.has(store)) {
    installedStores.add(store);
    const installed = host;
    // 同步签名（端口方法返回 void）：sink 自己拥有异步与吞错，调用方在 agent 写入路径上，
    // 既不能 await 也不能被这里的异常打断。
    store.setConversationProjectionSink((input) => {
      scheduleFold(installed, String(input.sessionID));
    });
  }
  return host;
}

function foldStateFor(host: ProjectionFoldHost, sessionId: string): FoldState {
  let state = host.states.get(sessionId);
  if (!state) {
    state = { running: false, pending: false };
    host.states.set(sessionId, state);
  }
  return state;
}

/** 合并整个 burst：折叠进行中就只置 pending，不再起第二个。 */
function scheduleFold(host: ProjectionFoldHost, sessionId: string): void {
  const state = foldStateFor(host, sessionId);
  if (state.running) {
    state.pending = true;
    return;
  }
  state.running = true;
  void runFoldLoop(host, sessionId, state).catch((error) => {
    host.context.logger?.warn("Conversation projection fold failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.v4.conversation_projection_fold_failed",
      module: "bootstrap.zcode_protocol",
      sessionId,
    });
  });
}

/**
 * 折叠循环。丢弃后**自己重排**，不依赖 pending：pending 只由本进程的脏通知置位，
 * 而 WAL 下允许多个 Agent 共享同一个库（dwf-journal.ts 的同款注释），外来进程的写入
 * 推得动水位却到不了我的 sink。只靠 pending 就会停在「投影已过期且无人重排」的状态上。
 * 上限 MAX_CONSECUTIVE_DISCARDS：撞上它说明写入从未留出一次折叠的静默窗口，也就是会话正在
 * 流式生成 —— 那时 runtime 已激活、订阅才是权威，快路径本来就不是 renderer 的事实源；
 * 之后的收敛由 pull-on-read 保证（下一次读发现 revision 不匹配会再 kick）。
 */
async function runFoldLoop(
  host: ProjectionFoldHost,
  sessionId: string,
  state: FoldState,
): Promise<void> {
  let discards = 0;
  try {
    for (;;) {
      const outcome = await foldOnce(host, sessionId);
      if (outcome === "discard") {
        discards += 1;
        if (discards >= MAX_CONSECUTIVE_DISCARDS) {
          state.pending = false;
          host.context.logger?.info("Conversation projection fold gave up after discards", {
            discards,
            event: "zcode_protocol.v4.conversation_projection_fold_gave_up",
            module: "bootstrap.zcode_protocol",
            sessionId,
          });
          return;
        }
        continue;
      }
      discards = 0;
      if (!state.pending) return;
      state.pending = false;
    }
  } finally {
    state.running = false;
  }
}

type FoldOutcome = "committed" | "discard" | "skipped";

async function foldOnce(host: ProjectionFoldHost, sessionId: string): Promise<FoldOutcome> {
  const { context, store } = host;
  const sessionID = sessionId as SessionId;
  // 事务外读水位：折叠不持锁，所以流式写入永远不会被它阻塞。
  const expectedSeq = await store.readConversationProjectionWatermark(sessionID);
  const session = await store.getSession(sessionID);
  if (!session) {
    // 会话行不存在（本仓没有 session 删除原语，实际到不了这里）：清掉可能的孤儿投影。
    await store.deleteConversationProjection(sessionID);
    return "skipped";
  }
  if (session.revert != null) {
    // delete-on-uncertain：活跃分支不可由有界尾部重建（bridge 因此拒绝 messagesTail，
    // 实测 2703-part 会话被截成 6 条消息 -> 空会话）。watermark 保留，revision 不能倒退。
    await store.deleteConversationProjection(sessionID);
    return "skipped";
  }
  const revision = revisionOf(session.time.updated, expectedSeq);
  // 尾读必须与 resume / 视图冷物化共用同一份约定（readPersistedSessionMessages，
  // messagesTail limit=500）。turnId 是 hydrate-turn-${turnNumber}，turnNumber 从传入数组的
  // 第一条开始数；全量读与 500 尾部读对 >500 part 的会话会数出不同的 turn 序号，
  // rowId 与 turnId 双双分叉 —— 那正是 bridge 注释里钉住的那条 bug。
  const persistedMessages = await readPersistedSessionMessages(context, sessionId);
  const rows = await buildConversationProjectionRows(
    sessionId,
    materializationStoreOf(store),
    persistedMessages,
  );
  const stored: StoredProjectionRow[] = rows.map((row) => ({
    rowId: row.rowId,
    turnId: row.turnId,
    kind: row.kind,
    payload: JSON.stringify(row),
  }));
  const result = await store.commitConversationProjection({
    sessionID,
    expectedSeq,
    revision,
    schemaVersion: CONV_PROJECTION_SCHEMA_VERSION,
    rows: stored,
  });
  if (!result.committed) return "discard";
  host.context.logger?.debug("Conversation projection folded", {
    event: "zcode_protocol.v4.conversation_projection_folded",
    module: "bootstrap.zcode_protocol",
    rewritten: result.rewritten,
    rowCount: stored.length,
    sessionId,
  });
  return "committed";
}

/**
 * 折叠用的 store 窄面。刻意**不**转发 messagesTail：builder 总是显式拿到 500 尾部尾读，
 * 于是这里的回落只会是全量 messages()——万一哪天 persistedMessages 意外为空，
 * 得到的是一次响亮的全量读而不是一份静默换了 scope 的投影。与 bridge 的
 * buildMaterializationStore 同一取舍。
 */
function materializationStoreOf(store: ConversationProjectionStore): ProjectionMaterializationStore {
  return {
    getSession: (id) => store.getSession(id),
    messages: (input) => store.messages(input),
    readTarget: (input) => store.readTarget(input),
    ...(store.sessionEntries
      ? {
          sessionEntries: (input: { sessionID: SessionId }) =>
            store.sessionEntries!({ sessionID: input.sessionID }),
        }
      : {}),
  };
}

/**
 * 反序列化一行。刻意**只**做最小判别检查，不跑 conversationRowSchema：
 * 全量 zod 校验在宿主 services 那一跳已经做过一次（client.request 的 result schema 就是
 * z.array(conversationRowSchema)），而 renderer 只拿 ProxyChannel 代理、本来不解析 RPC 结果。
 * 在 CLI 侧再全量校验 60 条肥行是纯浪费，浪费的还正是我们想从点击路径上拿掉的那段时间。
 * 最小检查仍然 fail-closed：不合格就 partial + 后台重折叠，绝不把畸形行发出去。
 */
function parseStoredRow(payload: string): ConversationRow | null {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as { rowId?: unknown; turnId?: unknown; kind?: unknown };
  if (typeof row.rowId !== "number" || typeof row.turnId !== "string" || typeof row.kind !== "string") {
    return null;
  }
  return value as ConversationRow;
}

export async function getConversationRows(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4ConversationRowsResult> {
  const params = parseParams(v4ConversationRowsParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  if (!store || !hasConversationProjection(store)) return { ok: false, reason: "unavailable" };
  // lazy 兜底注册：宿主没走 server 构造期那行 install 时，这里补上（幂等）。
  const host = installConversationProjectionSink(context);
  if (!host) return { ok: false, reason: "unavailable" };

  const sessionId = params.sessionId;
  const sessionID = sessionId as SessionId;
  const session = await store.getSession(sessionID);
  if (!session) return { ok: false, reason: "missing" };
  if (session.revert != null) {
    // 删除交给后台折叠做：请求路径上一次写锁都不拿（见文件头的车道约束）。
    // 正确性不受影响——这里已经拒绝服务了，删除什么时候落地无关紧要，
    // 而且每次读都会重新判 revert。
    scheduleFold(host, sessionId);
    return { ok: false, reason: "unsupported" };
  }

  const seq = await store.readConversationProjectionWatermark(sessionID);
  const revision = revisionOf(session.time.updated, seq);
  const limit = params.limit ?? PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  const view = await store.readConversationProjectionView(sessionID, {
    ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
    limit,
  });
  const meta: ProjectionMeta | null = view.meta;
  if (!meta) {
    scheduleFold(host, sessionId);
    return { ok: false, reason: "building" };
  }
  if (meta.schemaVersion !== CONV_PROJECTION_SCHEMA_VERSION) {
    // 旧格式的行绝不外发。折叠会在 commit 里按 schema_version 不同强制整表重写。
    scheduleFold(host, sessionId);
    return { ok: false, reason: "partial" };
  }
  if (meta.revision !== revision) {
    // 只重排，**绝不**在这里同步重折叠：那会把 0.7~2s 的折叠压到串行车道上。
    scheduleFold(host, sessionId);
    return { ok: false, reason: "stale" };
  }
  if (params.minRevision !== undefined && meta.revision !== params.minRevision) {
    scheduleFold(host, sessionId);
    return { ok: false, reason: "stale" };
  }

  const rows: ConversationRow[] = [];
  for (const stored of view.rows) {
    const row = parseStoredRow(stored.payload);
    if (!row) {
      scheduleFold(host, sessionId);
      return { ok: false, reason: "partial" };
    }
    rows.push(row);
  }
  return { ok: true, revision: meta.revision, rows, hasMore: view.hasMore };
}
