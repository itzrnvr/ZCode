// view/activate split 的验收测试（ruling 2 记录可选 hydration + ruling 5 分歧集收敛）。
//
// 被测的是**顺序**，不是某个纯函数：同一条持久 transcript，一条路径先 activation 再
// hydration（今天的行为），另一条路径先视图冷物化（不激活 runtime）再在第一条命令上升级。
// 两条路径最终必须落到逐字段相同的投影——这是"点击不再付 4663ms activation"这个优化
// 唯一可接受的正确性代价。
//
// 逐条对准验收面：
// (a) 视图订阅不创建 runtime record，而行与 activation-first 路径 deep-equal；
// (b) 随后的命令恰好激活一次，升级不重复任何东西（比较 sequenceNumber 全集）；
// (c) live-detached 会话永远不会拿到第二个 record；
// (d) 持久层查不到时抛 V4SubscribeSessionUnavailableError（与 resume 路径同一个错误类）。
//
// host 桩刻意复刻 v4-bridge 的 loadPersistedEvents 契约（record-less 分支报
// deferredColdSources，record 分支不报），并真的把 resume 生命周期事件 ingest 进 gateway：
// 生产路径上 record 的事件 sink 在 activation 期间就会推进 publisher，收敛必须在这种情况下
// 也成立，否则测试证明的是一个不会发生的时序。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemorySessionEventStore,
  createSessionEvent,
  SessionEventType,
  type MessageWithParts,
  type ModelSelection,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../src/zcode-protocol-v4/cold-event-merge.js";
import {
  COLD_VIEW_DEFERRED_SOURCES,
  V4SubscribeSessionUnavailableError,
} from "../src/zcode-protocol-v4/cold-session-resume.js";
import {
  ConversationV4Gateway,
  type V4GatewayHost,
} from "../src/zcode-protocol-v4/v4-gateway.js";
import {
  conversationTopicFrameSchema,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

const WATERMARK = 1_790_000_000_000;
const MODEL: ModelSelection = { modelId: "big-model", providerId: "acme" };
const sidOf = (sessionId: string) => sessionId as unknown as SessionId;
const idOf = (value: string) => value as unknown as MessageWithParts["info"]["id"];

// ── fixtures：真实形状的持久 transcript ─────────────────────────────────────

function userMessage(messageId: string, text: string): MessageWithParts {
  return {
    info: {
      id: idOf(messageId),
      modelSelection: MODEL,
      role: "user",
      time: { created: WATERMARK },
    },
    parts: [{ id: idOf(`${messageId}-p0`), text, type: "text" }],
  } as unknown as MessageWithParts;
}

function assistantMessage(messageId: string, text: string): MessageWithParts {
  return {
    info: {
      id: idOf(messageId),
      modelId: MODEL.modelId,
      mode: "build",
      providerId: MODEL.providerId,
      role: "assistant",
      time: { completed: WATERMARK + 1, created: WATERMARK },
      tokens: { input: 1_200, output: 300 },
    },
    parts: [{ id: idOf(`${messageId}-p0`), text, type: "text" }],
  } as unknown as MessageWithParts;
}

interface FixtureStore {
  calls: { getSession: number; messages: number; readTarget: number; sessionEntries: number };
  known: ReadonlySet<string>;
  messages: MessageWithParts[];
  store: {
    getSession(sessionId: SessionId): Promise<{ time: { created: number; updated: number }; title: string } | null>;
    messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
    /**
     * 刻意**不**提供 messagesTail：hydrate 的 store 窄面必须回落全量 messages()
     * （commit f141156：裸尾读对 revert/fork 会话选不出活跃分支）。视图路径的尾读
     * 走 readTail，与 resume 共用同一份 500 行界，不经这个窄面。
     */
    readTarget(input: { sessionID: SessionId }): Promise<null>;
    sessionEntries(input: { sessionID: SessionId }): Promise<[]>;
  };
}

function createStore(sessionIds: readonly string[], messages: MessageWithParts[]): FixtureStore {
  const calls = { getSession: 0, messages: 0, readTarget: 0, sessionEntries: 0 };
  const known = new Set(sessionIds);
  return {
    calls,
    known,
    messages,
    store: {
      async getSession(sessionId) {
        calls.getSession += 1;
        if (!known.has(String(sessionId))) return null;
        return { time: { created: WATERMARK, updated: WATERMARK }, title: "Persisted session" };
      },
      async messages() {
        calls.messages += 1;
        return messages;
      },
      async readTarget() {
        calls.readTarget += 1;
        return null;
      },
      async sessionEntries() {
        calls.sessionEntries += 1;
        return [];
      },
    },
  };
}

// ── host 桩：复刻 v4-bridge 的 record / record-less 双分支 ──────────────────

interface HarnessOptions {
  /** false = 宿主没有裸读面（旧 host），gateway 必须整条退回 activation。 */
  viewMaterial?: boolean;
  sessionIds?: readonly string[];
  messages?: MessageWithParts[];
}

interface Harness {
  gateway: ConversationV4Gateway;
  state: {
    activations: number;
    executed: string[];
    frames: unknown[];
    live: Set<string>;
    /** 每次 activation 收到的 resume 参数；升级必须原样兑现 subscribe 带的那一份。 */
    resumeCalls: { resumeThoughtLevel?: string; sessionId: string; workspace?: WorkspaceRef }[];
  };
  /** 与 readPersistedSessionMessages 同一条 500 行界尾读。 */
  readTail(sessionId: string): Promise<MessageWithParts[]>;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const messages = options.messages ?? [
    userMessage("m1", "what changed"),
    assistantMessage("m2", "the split landed"),
  ];
  const fixture = createStore(options.sessionIds ?? ["sess_view"], messages);
  const eventStore = createInMemorySessionEventStore();
  const state = {
    activations: 0,
    executed: [] as string[],
    frames: [] as unknown[],
    live: new Set<string>(),
    resumeCalls: [] as Harness["state"]["resumeCalls"],
  };
  let gateway: ConversationV4Gateway | undefined;

  const readTail = async (_sessionId: string) => messages.slice(-500);

  /** record 在册时 resume 会追加的三条：两条生命周期 + 一条只有 runtime 才知道的 mode 变更。 */
  const appendResumeEvents = async (sessionId: string): Promise<SessionEvent[]> => {
    const appended = [
      createSessionEvent(SessionEventType.SessionResumed, sidOf(sessionId), {
        directory: "/workspace",
        interruptedToolCount: 0,
        messageCount: 0,
        partCount: 0,
        recoveredCompactTimelineCount: 0,
        recoveredSteerInputCount: 0,
        resumedTodoCount: 0,
      }),
      createSessionEvent(SessionEventType.SessionTitleUpdated, sidOf(sessionId), {
        previousTitle: "",
        source: "generated",
        title: "Persisted session",
      }),
      // 收敛断言的靶子：memory-only 权威事件，视图路径永远看不到它。
      createSessionEvent(SessionEventType.SessionModeChanged, sidOf(sessionId), {
        mode: "yolo",
        planEnabled: false,
        previousMode: "build",
        source: "command",
      }),
    ];
    for (const event of appended) {
      await eventStore.append(event);
      // 生产路径上 record 的事件 sink 在 activation 期间就推进 publisher；收敛必须在
      // "视图投影已被 live 事件碰过" 的前提下也成立。
      gateway?.ingest(sessionId, event);
    }
    return appended;
  };

  const host: V4GatewayHost = {
    sessionExists: (sessionId) => state.live.has(sessionId),
    emitWireFrame: (frame) => {
      state.frames.push(frame);
    },
    executeCommand: async (envelope) => {
      state.executed.push(envelope.type);
      return undefined;
    },
    resumePersistedSession: async (sessionId, resumeThoughtLevel, workspace) => {
      const persisted = await fixture.store.getSession(sidOf(sessionId));
      if (!persisted) return { status: "notFound" };
      state.activations += 1;
      state.live.add(sessionId);
      state.resumeCalls.push({
        sessionId,
        ...(resumeThoughtLevel ? { resumeThoughtLevel } : {}),
        ...(workspace ? { workspace } : {}),
      });
      await appendResumeEvents(sessionId);
      return { status: "resumed", persistedMessages: await readTail(sessionId) };
    },
    // record-less 时缺席 config 真值；record 在册后 runtime 真值优先（bridge 同一姿态）。
    getSessionConfigSeed: (sessionId) =>
      state.live.has(sessionId)
        ? { mode: "build", model: MODEL.modelId, provider: MODEL.providerId }
        : null,
    loadPersistedEvents: async (sessionId, persistedMessages) => {
      const recordless = !state.live.has(sessionId);
      const memoryEvents = recordless
        ? []
        : await eventStore.getEvents(sidOf(sessionId));
      const sourceEventSeq = recordless
        ? 0
        : await eventStore.getLatestSequenceNumber(sidOf(sessionId));
      const source = await loadPersistedConversationMaterialization({
        memoryEvents,
        persistedMessages,
        sessionId,
        store: fixture.store,
      });
      const merged = mergeColdConversationEvents({
        fileChangeSummariesByMessageId: new Map(),
        goalVerificationEntries: source.goalVerificationEntries,
        memoryEvents: source.memoryEvents,
        messages: source.messages,
        sessionId,
        ...(Object.prototype.hasOwnProperty.call(source, "target")
          ? { target: source.target }
          : {}),
      });
      return {
        events: merged.events,
        sourceEventSeq,
        synthesized: merged.usedDurableTranscript,
        usageSeed: null,
        ...(recordless ? { deferredColdSources: COLD_VIEW_DEFERRED_SOURCES } : {}),
      };
    },
    ...(options.viewMaterial === false
      ? {}
      : {
          readColdViewMaterial: async (sessionId: string) => {
            const persisted = await fixture.store.getSession(sidOf(sessionId));
            if (!persisted) return { status: "notFound" as const };
            return { status: "available" as const, persistedMessages: await readTail(sessionId) };
          },
        }),
  };

  gateway = new ConversationV4Gateway(host, {
    createLogEpoch: () => "epoch-fixed",
    now: () => WATERMARK,
  });
  return { gateway, readTail, state };
}

interface WorkspaceRef {
  workspaceIdentity?: string;
  workspaceKey: string;
  workspacePath: string;
}

function subscribeParams(
  sessionId: string,
  connectionId: string,
  extra?: { resumeThoughtLevel?: string; workspace?: WorkspaceRef },
) {
  return {
    clientMode: "desktop-continuous" as const,
    connectionId,
    topic: `conversation/${sessionId}`,
    ...(extra?.resumeThoughtLevel ? { resumeThoughtLevel: extra.resumeThoughtLevel } : {}),
    ...(extra?.workspace ? { workspace: extra.workspace } : {}),
  };
}

function commandEnvelope(sessionId: string, commandId: string) {
  return {
    clientId: "client-1",
    commandId,
    issuedAt: WATERMARK,
    payload: {},
    sessionId,
    type: "compact" as const,
  };
}

/**
 * 帧是跨 topic 的联合类型（resyncReserved 回 RoutedTopicFrame），用 wire schema 收窄一次：
 * 既拿到完整类型，也顺带证明这一帧真的是合法 conversation 帧。快照在 `payload.snapshot`，
 * 行目录在 `payload.snapshot.rows.window`（rowsWindowSchema），不是 `frame.snapshot.rows`。
 */
function snapshotOf(frame: unknown): ConversationSnapshot {
  const parsed = conversationTopicFrameSchema.parse(frame);
  assert.equal(parsed.payload.kind, "snapshot", "订阅 / 强制 resync 必须回整份快照");
  if (parsed.payload.kind !== "snapshot") throw new Error("unreachable");
  return parsed.payload.snapshot;
}

function rowsOf(frame: unknown): ConversationSnapshot["rows"]["window"] {
  return snapshotOf(frame).rows.window;
}

// ── (a) + ruling 5：视图订阅不激活，且升级后与 activation-first 逐字段相同 ──

test("视图冷订阅不创建 runtime record，行与 activation-first 路径 deep-equal", async () => {
  const sessionId = "sess_view_rows";
  const activationFirst = createHarness({ sessionIds: [sessionId], viewMaterial: false });
  const viewFirst = createHarness({ sessionIds: [sessionId] });

  const first = await activationFirst.gateway.subscribe(subscribeParams(sessionId, "conn-a"));
  assert.equal(activationFirst.state.activations, 1, "activation-first 基线：订阅即激活");

  const view = await viewFirst.gateway.subscribe(subscribeParams(sessionId, "conn-b"));
  assert.equal(
    viewFirst.state.activations,
    0,
    "(a) 视图订阅必须完全不激活 runtime——这正是省下的 4663ms",
  );
  assert.deepEqual(
    rowsOf(view.initialFrame),
    rowsOf(first.initialFrame),
    "(a) 无 record 建出来的行与 activation-first 逐字段相同",
  );
  assert.ok(
    rowsOf(view.initialFrame).length > 0,
    "行不能是空的（空投影会把历史渲染成空会话）",
  );
});

test("升级后与 activation-first 逐字段相同：命令激活恰好一次，序列号不重复", async () => {
  const sessionId = "sess_view_upgrade";
  const activationFirst = createHarness({ sessionIds: [sessionId], viewMaterial: false });
  const viewFirst = createHarness({ sessionIds: [sessionId] });

  const first = await activationFirst.gateway.subscribe(subscribeParams(sessionId, "conn-a"));
  const firstSnapshot = snapshotOf(first.initialFrame);

  const view = await viewFirst.gateway.subscribe(subscribeParams(sessionId, "conn-b"));
  assert.equal(viewFirst.state.activations, 0);
  const subscriptionId = view.ack.subscriptionId;
  assert.notEqual(
    snapshotOf(view.initialFrame).config.mode,
    "yolo",
    "升级前看不到 record-only 的 mode 变更——这正是分歧集非空的证据",
  );

  const ack = await viewFirst.gateway.handleCommand(commandEnvelope(sessionId, "cmd-1"));
  assert.notEqual(
    ack.reasonCode,
    "proto.sessionNotFound",
    "(b) 升级必须发生在 inbox 裁决之前，否则命令拿不到 revision",
  );
  assert.equal(viewFirst.state.activations, 1, "(b) activation 恰好一次");

  // 并发第二条命令不得再激活一次（readyFlights 单飞）。
  await viewFirst.gateway.handleCommand(commandEnvelope(sessionId, "cmd-2"));
  assert.equal(viewFirst.state.activations, 1, "(b) 第二条命令复用同一次 activation");

  const resync = viewFirst.gateway.resyncReserved({
    base: null,
    connectionId: "conn-b",
    forceSnapshot: true,
    subscriptionId,
    topic: `conversation/${sessionId}`,
  });
  const convergedSnapshot = snapshotOf(resync.initialFrame);
  assert.deepEqual(
    convergedSnapshot,
    firstSnapshot,
    "ruling 5：视图冷开再激活，必须与直接 activation-first 逐字段相同",
  );

  // 只有 runtime 知道的事实确实落地了（否则上面的 deep-equal 可能是两边都空）。
  assert.equal(
    convergedSnapshot.config.mode,
    "yolo",
    "record-only 的 SessionModeChanged 已进投影",
  );

  // 升级不重复任何东西：水位与 rowId 全集必须与 activation-first 完全一致。
  assert.ok(convergedSnapshot.rows.window.length > 0, "行不能是空的");
  assert.equal(convergedSnapshot.seq, firstSnapshot.seq, "(b) 序列水位不漂移");
  assert.deepEqual(
    convergedSnapshot.rows.window.map((row) => row.rowId),
    firstSnapshot.rows.window.map((row) => row.rowId),
    "(b) rowId 全集一致（无重复、无缺段）",
  );
});

test("升级后事件序列号集合与 activation-first 相同（不重复补回 live 事件）", async () => {
  const sessionId = "sess_view_seq";
  const activationFirst = createHarness({ sessionIds: [sessionId], viewMaterial: false });
  const viewFirst = createHarness({ sessionIds: [sessionId] });

  await activationFirst.gateway.subscribe(subscribeParams(sessionId, "conn-a"));
  const view = await viewFirst.gateway.subscribe(subscribeParams(sessionId, "conn-b"));
  await viewFirst.gateway.handleCommand(commandEnvelope(sessionId, "cmd-1"));

  // rowsRange 是公开只读面，返回完整行；两边必须逐字段相同。
  const rangeParams = { clientMode: "desktop-continuous", limit: 100, sessionId };
  const [firstRows, convergedRows] = await Promise.all([
    activationFirst.gateway.rowsRange(rangeParams),
    viewFirst.gateway.rowsRange(rangeParams),
  ]);
  assert.deepEqual(convergedRows, firstRows, "升级后的行与 activation-first 逐字段相同");
  assert.ok(view.ack.subscriptionId.length > 0);
});

// ── (c) live-detached 永远不拿第二个 record ────────────────────────────────

test("live-detached 会话：订阅与命令都不激活，绝不物化第二个 record", async () => {
  const childId = "sess_detached_child";
  const parentId = "sess_detached_parent";
  const harness = createHarness({ sessionIds: [childId, parentId] });

  // 显式登记 detached live child（真 runtime 活在别处，宿主刻意没有 record）。
  harness.gateway.ingestDetachedLiveSession(
    childId,
    createSessionEvent(SessionEventType.TurnStarted, sidOf(childId), {
      inputVisibility: "user-visible",
      messageId: "m1",
    }),
    parentId,
  );

  await harness.gateway.subscribe(subscribeParams(childId, "conn-c"));
  assert.equal(harness.state.activations, 0, "(c) detached live 订阅不激活");

  await harness.gateway.handleCommand(commandEnvelope(childId, "cmd-detached"));
  assert.equal(
    harness.state.activations,
    0,
    "(c) detached live 命令也不激活——再 resume 一次就是第二个幽灵 record",
  );
  assert.equal(harness.state.live.has(childId), false);
});

// ── (d) not-found 分型 ─────────────────────────────────────────────────────

test("持久层查不到时抛 V4SubscribeSessionUnavailableError（与 resume 路径同一个错误类）", async () => {
  const harness = createHarness({ sessionIds: ["sess_exists"] });
  await assert.rejects(
    () => harness.gateway.subscribe(subscribeParams("sess_missing", "conn-d")),
    (error: unknown) => {
      assert.ok(
        error instanceof V4SubscribeSessionUnavailableError,
        `(d) 错误类必须是 V4SubscribeSessionUnavailableError，实际 ${String(error)}`,
      );
      assert.equal(error.reasonCode, "fault.subscribe.sessionNotFound");
      assert.equal(error.sessionId, "sess_missing");
      return true;
    },
  );
  assert.equal(harness.state.activations, 0, "notFound 不该顺带激活任何 runtime");
});

// ── 宿主没有裸读面：整条退回 activation（旧 host / 测试桩） ────────────────

test("宿主缺席 readColdViewMaterial 时退回 activation，语义与拆分前相同", async () => {
  const sessionId = "sess_view_unsupported";
  const harness = createHarness({ sessionIds: [sessionId], viewMaterial: false });
  await harness.gateway.subscribe(subscribeParams(sessionId, "conn-e"));
  assert.equal(harness.state.activations, 1, "unsupported 必须退回 activation 而不是报 notFound");
  // 退回后没有视图水位：命令不该再触发第二次 activation 或重建。
  await harness.gateway.handleCommand(commandEnvelope(sessionId, "cmd-1"));
  assert.equal(harness.state.activations, 1);
});

// ── 只读打开永远不付重建代价 ──────────────────────────────────────────────

test("只读打开（订阅 + rowsRange + plans）从不激活，也从不触发重建", async () => {
  const sessionId = "sess_view_readonly";
  const harness = createHarness({ sessionIds: [sessionId] });
  await harness.gateway.subscribe(subscribeParams(sessionId, "conn-f"));
  await harness.gateway.rowsRange({
    clientMode: "desktop-continuous",
    limit: 50,
    sessionId,
  });
  await harness.gateway.plans({ sessionId });
  assert.equal(harness.state.activations, 0, "只读入口一个都不许激活 runtime");
  // 三个只读入口共享同一份视图水位：hydration 只跑一次（transcript 全量读只发生一次）。
  assert.equal(harness.gateway.collectMemoryDiagnostics().publishers, 1);
});

// ── 推迟 activation 不能丢掉 subscribe 带的 resume 参数 ─────────────────────

test("升级时原样兑现 subscribe 的 workspace 与思考档位；后到的 subscribe 覆盖旧的", async () => {
  const sessionId = "sess_view_hints";
  const harness = createHarness({ sessionIds: [sessionId] });
  const firstWorkspace: WorkspaceRef = {
    workspaceIdentity: "remote:one",
    workspaceKey: "remote:one",
    workspacePath: "/ws/one",
  };

  await harness.gateway.subscribe(
    subscribeParams(sessionId, "conn-h1", {
      resumeThoughtLevel: "high",
      workspace: firstWorkspace,
    }),
  );
  assert.equal(harness.state.activations, 0, "视图订阅不激活，参数只是被记下");
  assert.deepEqual(harness.state.resumeCalls, []);

  await harness.gateway.handleCommand(commandEnvelope(sessionId, "cmd-hints-1"));
  assert.equal(harness.state.activations, 1);
  assert.deepEqual(
    harness.state.resumeCalls[0],
    { resumeThoughtLevel: "high", sessionId, workspace: firstWorkspace },
    "升级入口只有 sessionId；subscribe 的档位与 workspace 必须原样送到 activation",
  );

  // 会话被回收后再次冷开：新 subscribe 的 workspace 身份必须覆盖旧的，否则远端会话会
  // 用上一轮的 identity 命中不到按 workspaceID 隔离的 provider registry。
  harness.gateway.disposeSession(sessionId);
  harness.state.live.delete(sessionId);
  harness.state.activations = 0;
  harness.state.resumeCalls.length = 0;
  const secondWorkspace: WorkspaceRef = {
    workspaceIdentity: "remote:two",
    workspaceKey: "remote:two",
    workspacePath: "/ws/two",
  };
  await harness.gateway.subscribe(
    subscribeParams(sessionId, "conn-h2", {
      resumeThoughtLevel: "low",
      workspace: secondWorkspace,
    }),
  );
  assert.equal(harness.state.activations, 0);
  await harness.gateway.handleCommand(commandEnvelope(sessionId, "cmd-hints-2"));
  assert.deepEqual(
    harness.state.resumeCalls[0],
    { resumeThoughtLevel: "low", sessionId, workspace: secondWorkspace },
    "后到的 subscribe 覆盖旧参数（last-writer-wins）",
  );
});
