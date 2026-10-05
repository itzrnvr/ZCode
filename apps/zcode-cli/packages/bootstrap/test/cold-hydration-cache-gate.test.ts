// 冷缓存门槛修正（issue #4）的验收测试。
//
// 测试的**顺序**就是被验的东西：先把 resume 会追加的生命周期事件写进一个真实的
// `InMemorySessionEventStore`（resumeFromStore 走的就是它），再从那份 store 快照出发跑
// hydration 的判定面。任何"零活事件喂给合成器"的测法都证明不了缓存真的被读写 —— #42 就是
// 这样发的，结果门槛在真实冷开上永远判否。
//
// 逐条对准需求：
// (a) 有 live 生命周期事件时缓存确实被读/写（断在 cache 模块上）；
// (b) 第二次 hydration 命中，且事件数组与 miss 路径**逐字节相同**（含 sequenceNumber）；
// (c) 再 resume 一次（重数 +1）后命中路径仍等于 miss 路径（overlay 现贴，不是从载荷里拿的）；
// (d) 水位/revert/档位变化一律 miss；
// (e) 真正的非生命周期活事件仍然整条绕过缓存。
//
// 每个用例用各自的 sessionId：缓存是进程内全局表，复用 id 会让后面的用例提前命中。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemorySessionEventStore,
  createSessionEvent,
  reduce,
  SessionEventType,
  type MessageWithParts,
  type ModelSelection,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionGoal,
  type SessionId,
} from "@zcode/contracts";
import {
  readColdHydrationCache,
  writeColdHydrationCache,
} from "../src/zcode-protocol-v4/cold-hydration-cache.js";
import {
  COLD_HYDRATION_CACHE_LOG,
  isColdHydrationCacheFingerprintCurrent,
  planColdHydrationCache,
  type ColdHydrationCachePayload,
  type ColdHydrationCachePlan,
  type ColdHydrationCacheStore,
} from "../src/zcode-protocol-v4/cold-hydration-cache-plan.js";
import { buildColdFileChangeSummaries } from "../src/zcode-protocol-v4/cold-file-change-summaries.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
  type PersistedConversationMaterializationStore,
} from "../src/zcode-protocol-v4/cold-event-merge.js";
import type { ZCodeSessionContextUsage } from "@zcode/shared";

const WATERMARK = 1_790_000_000_000;
const BIG_MODEL: ModelSelection = { providerId: "acme", modelId: "big-model" };
const BIG_WINDOW = 200_000;
const SMALL_WINDOW = 32_000;
const sidOf = (sessionId: string) => sessionId as unknown as SessionId;
const idOf = (value: string) => value as unknown as MessageWithParts["info"]["id"];

// ── fixtures：真实形状，不是 partial 的强转 ─────────────────────────────────

function userMessage(messageId: string, selection: ModelSelection): MessageWithParts {
  return {
    info: {
      id: idOf(messageId),
      modelSelection: selection,
      role: "user",
      time: { created: WATERMARK },
    },
    parts: [{ id: idOf(`${messageId}-p0`), text: `${messageId}:0`, type: "text" }],
  } as unknown as MessageWithParts;
}

/** assistant 消息带 tokens：contextUsageFromPersistedMessages 靠它算 usageSeed。 */
function assistantMessage(messageId: string): MessageWithParts {
  return {
    info: {
      id: idOf(messageId),
      modelId: BIG_MODEL.modelId,
      providerId: BIG_MODEL.providerId,
      role: "assistant",
      time: { completed: WATERMARK + 1, created: WATERMARK },
      tokens: { input: 1_200, output: 300 },
    },
    parts: [{ id: idOf(`${messageId}-p0`), text: `${messageId}:0`, type: "text" }],
  } as unknown as MessageWithParts;
}

function modelSelectionEntry(selection: ModelSelection, sessionId: string): SessionEntryInfo {
  return {
    data: selection,
    id: "entry-model-selection",
    sessionID: sidOf(sessionId),
    time: { created: WATERMARK, updated: WATERMARK },
    touchSession: false,
    type: "runtime/model_selection",
  };
}

function goal(sessionId: string): SessionGoal {
  return {
    objective: "ship the gate fix",
    sessionID: sidOf(sessionId),
    status: "active",
    summaryTitle: null,
    targetID: "goal-1",
    time: { created: WATERMARK, updated: WATERMARK + 5 },
    timeUsedSeconds: 0,
    tokenBudget: null,
    tokensUsed: 0,
  };
}

type FixtureStore = ColdHydrationCacheStore & PersistedConversationMaterializationStore;

interface StoreFixture {
  calls: { getSession: number; messages: number; messagesTail: number; readTarget: number; sessionEntries: number };
  entries: SessionEntryInfo[];
  sessionId: string;
  store: FixtureStore;
}

interface StoreOptions {
  entries?: SessionEntryInfo[];
  messages?: MessageWithParts[];
  reverted?: boolean;
  target?: SessionGoal | null;
  title?: string;
  /** 会话行水位；动它就是"transcript 变了"。 */
  watermark?: number;
}

function createStore(sessionId: string, options: StoreOptions = {}): StoreFixture {
  const calls = { getSession: 0, messages: 0, messagesTail: 0, readTarget: 0, sessionEntries: 0 };
  const entries = options.entries ?? [];
  const messages = options.messages ?? [userMessage("m1", BIG_MODEL), assistantMessage("m2")];
  const watermark = options.watermark ?? WATERMARK;
  const store: FixtureStore = {
    async getSession() {
      calls.getSession += 1;
      return {
        ...(options.reverted ? { revert: { targetMessageID: idOf("m9") } } : {}),
        time: { created: WATERMARK, updated: watermark },
        title: options.title ?? "Warm session",
      };
    },
    async messages() {
      calls.messages += 1;
      return messages;
    },
    async messagesTail(input: { limit: number; sessionID?: SessionId }) {
      calls.messagesTail += 1;
      // 夹具消息很短，尾读即全量：语义与 store.messages 相同。
      return messages.slice(-input.limit);
    },
    async readTarget() {
      calls.readTarget += 1;
      return options.target ?? null;
    },
    async sessionEntries(input?: { sessionID: SessionId; type?: string }) {
      calls.sessionEntries += 1;
      return input?.type ? entries.filter((entry) => entry.type === input.type) : entries;
    },
  };
  return { calls, entries, sessionId, store };
}

// ── 真实 resume 顺序：往真实内存 store 追加生命周期事件 ────────────────────

async function appendResume(
  store: ReturnType<typeof createInMemorySessionEventStore>,
  sessionId: string,
  times = 1,
): Promise<SessionEvent[]> {
  for (let index = 0; index < times; index += 1) {
    await store.append(
      createSessionEvent(SessionEventType.SessionResumed, sidOf(sessionId), {
        directory: "/workspace",
        interruptedToolCount: 0,
        messageCount: 0,
        partCount: 0,
        recoveredCompactTimelineCount: 0,
        recoveredSteerInputCount: 0,
        resumedTodoCount: 0,
      }),
    );
    await store.append(
      createSessionEvent(SessionEventType.SessionTitleUpdated, sidOf(sessionId), {
        previousTitle: "",
        source: "generated",
        title: "Warm session",
      }),
    );
  }
  // 与 v4-bridge.ts:1805-1808 同一个快照读法。
  return store.getEvents(sidOf(sessionId));
}

/** reducer 是纯函数；同一对事件的同步版本，供投影断言使用。 */
function resumeEventsForReducer(sessionId: string): SessionEvent[] {
  return [
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
      title: "Warm session",
    }),
  ];
}

// ── 真实路径的两半 ────────────────────────────────────────────────────────

function usageSeedOf(
  usage: ZCodeSessionContextUsage | undefined,
  contextWindow: number | undefined,
): ColdHydrationCachePayload["usageSeed"] {
  if (!usage || usage.used <= 0) return null;
  return {
    contextWindow: {
      autoCompactThresholdTokens: null,
      maxTokens: contextWindow ?? null,
      usedTokens: usage.used,
    },
  };
}

/** miss 路径本体：materialization + artifact 摘要 + merge（v4-bridge.ts:1870-1936 同序）。 */
async function runFullPath(
  fixture: StoreFixture,
  liveEvents: readonly SessionEvent[],
  contextWindow: number,
) {
  const source = await loadPersistedConversationMaterialization({
    memoryEvents: liveEvents,
    sessionId: fixture.sessionId,
    store: fixture.store,
  });
  const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
    events: source.memoryEvents,
    messageIds: source.messages.map((message) => String(message.info.id)),
    readArtifact: async () => {
      throw new Error("resume 生命周期事件不含 workspace checkpoint：不该读 artifact");
    },
  });
  const usageSeed = usageSeedOf({ size: contextWindow, used: 1_500 }, contextWindow);
  const merged = mergeColdConversationEvents({
    contextWindow,
    fileChangeSummariesByMessageId,
    memoryEvents: source.memoryEvents,
    messages: source.messages,
    sessionId: fixture.sessionId,
    goalVerificationEntries: source.goalVerificationEntries,
    ...(Object.prototype.hasOwnProperty.call(source, "target") ? { target: source.target } : {}),
  });
  return {
    durableEvents: merged.durableEvents,
    events: merged.events,
    sharedContextImport: source.sharedContextImport,
    synthesized: merged.usedDurableTranscript,
    usageSeed,
  };
}

interface HydrationResult {
  events: SessionEvent[];
  plan: ColdHydrationCachePlan;
  usageSeed: ColdHydrationCachePayload["usageSeed"];
}

/**
 * 一次 hydration：判定面（真实 bridge 调的就是它）→ 命中则直接返回，否则跑全量路径并按
 * miss 写缓存。bypass 时既不读也不写（与 bridge 一致）。
 */
async function hydrate(
  fixture: StoreFixture,
  liveEvents: readonly SessionEvent[],
  contextWindow: number | undefined = BIG_WINDOW,
): Promise<HydrationResult> {
  const plan = await planColdHydrationCache({
    contextWindow,
    events: liveEvents,
    sessionId: fixture.sessionId,
    store: fixture.store,
  });
  if (plan.kind === "hit") {
    return { events: plan.events, plan, usageSeed: plan.payload.usageSeed };
  }
  const full = await runFullPath(fixture, liveEvents, contextWindow ?? BIG_WINDOW);
  if (plan.kind === "miss") {
    // 与 bridge 同一个写前复核：输入在合成期间变了就不写。
    const current = await isColdHydrationCacheFingerprintCurrent({
      contextWindow,
      events: liveEvents,
      fingerprint: plan.fingerprint,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    if (current) {
      writeColdHydrationCache<ColdHydrationCachePayload>(fixture.sessionId, plan.fingerprint, {
        durableEvents: full.durableEvents,
        synthesized: full.synthesized,
        usageSeed: full.usageSeed,
        ...(full.sharedContextImport ? { sharedContextImport: full.sharedContextImport } : {}),
      });
    }
  }
  return { events: full.events, plan, usageSeed: full.usageSeed };
}

function cachedPayload(fixture: StoreFixture, fingerprint: string): ColdHydrationCachePayload | null {
  return readColdHydrationCache<ColdHydrationCachePayload>(fixture.sessionId, fingerprint);
}

// ── (a) + (b)：真实顺序下读写缓存，且命中等于未命中 ───────────────────────

test("resume-then-hydrate: live 生命周期事件下缓存被写入，第二次被命中且逐字节等于 miss 路径", async () => {
  const sessionId = "sess_gate_write";
  const store = createInMemorySessionEventStore();
  const liveEvents = await appendResume(store, sessionId);
  assert.equal(liveEvents.length, 2, "resume 追加的就是 SessionResumed + SessionTitleUpdated");
  const fixture = createStore(sessionId, {
    entries: [modelSelectionEntry(BIG_MODEL, sessionId)],
    target: goal(sessionId),
  });

  const first = await hydrate(fixture, liveEvents);
  assert.equal(first.plan.kind, "miss", "第一次是 miss");
  if (first.plan.kind !== "miss") throw new Error("unreachable");
  const payload = cachedPayload(fixture, first.plan.fingerprint);
  assert.ok(payload, "(a) 有 live 生命周期事件时缓存确实被写入（断言在 cache 模块上）");

  const second = await hydrate(fixture, liveEvents);
  assert.equal(second.plan.kind, "hit", "(b) 同一水位第二次必须命中");
  assert.deepEqual(second.events, first.events, "(b) 命中路径的事件与 miss 路径逐字节相同");
  assert.deepEqual(
    second.events.map((event) => event.sequenceNumber),
    first.events.map((event) => event.sequenceNumber),
    "(b) sequenceNumber（尾部 bookkeeping）也必须一致",
  );
  assert.deepEqual(second.usageSeed, first.usageSeed, "命中路径的 usageSeed 与 miss 路径同值");

  // 约束 1：载荷里不能有生命周期事件（它们的重数每次 resume 都会涨）。
  const durableTypes = payload.durableEvents.map((event) => event.type);
  assert.ok(!durableTypes.includes(SessionEventType.SessionResumed));
  assert.ok(!durableTypes.includes(SessionEventType.SessionTitleUpdated));
  // 命中路径不读 transcript：loadPersistedConversationMaterialization 的读取计数不涨。
  const readsAfterFirst = fixture.calls.messages + fixture.calls.messagesTail;
  await hydrate(fixture, liveEvents);
  assert.equal(
    fixture.calls.messages + fixture.calls.messagesTail,
    readsAfterFirst,
    "(b) 命中路径一次 transcript 都不读",
  );
});

// ── (c)：重数增长后仍然命中，且命中结果等于当前 live 状态下的 miss 结果 ────

test("再 resume 一次后：指纹不变（重数不进键），命中路径仍等于 miss 路径", async () => {
  const sessionId = "sess_gate_multiplicity";
  const store = createInMemorySessionEventStore();
  const firstEvents = await appendResume(store, sessionId);
  const fixture = createStore(sessionId, { entries: [modelSelectionEntry(BIG_MODEL, sessionId)] });

  const first = await hydrate(fixture, firstEvents);
  assert.equal(first.plan.kind, "miss");
  if (first.plan.kind !== "miss") throw new Error("unreachable");
  const writeFingerprint = first.plan.fingerprint;

  // 第二次冷开：resume 再追加一份（重数 2），指纹必须不变（约束 2）。
  const secondEvents = await appendResume(store, sessionId);
  assert.equal(secondEvents.length, 4);
  const second = await hydrate(fixture, secondEvents);
  assert.equal(second.plan.kind, "hit", "(c) 重数增长不影响命中");
  if (second.plan.kind !== "hit") throw new Error("unreachable");
  assert.equal(second.plan.fingerprint, writeFingerprint, "约束 2：重数不进指纹");

  // 命中结果必须等于"当前 live 事件走 miss 路径"的结果 —— overlay 是现贴的。
  const fresh = await runFullPath(fixture, secondEvents, BIG_WINDOW);
  assert.deepEqual(second.events, fresh.events, "(c) 命中路径 == 当前 live 状态下的 miss 路径");
  assert.equal(
    second.events.filter((event) => event.type === SessionEventType.SessionResumed).length,
    2,
    "(c) 当前 live 的两条 SessionResumed 都被贴回来了",
  );
});

// ── (d)：指纹对不上就是 miss，绝不返回错行 ────────────────────────────────

test("水位/revert/档位变化一律 miss 并回落到全量路径", async () => {
  const sessionId = "sess_gate_mismatch";
  const store = createInMemorySessionEventStore();
  const liveEvents = await appendResume(store, sessionId);
  const fixture = createStore(sessionId, { entries: [modelSelectionEntry(BIG_MODEL, sessionId)] });
  const warmed = await hydrate(fixture, liveEvents);
  assert.equal(warmed.plan.kind, "miss");

  const moved = await hydrate(
    createStore(sessionId, {
      entries: [modelSelectionEntry(BIG_MODEL, sessionId)],
      watermark: WATERMARK + 1,
    }),
    liveEvents,
  );
  assert.equal(moved.plan.kind, "miss", "transcript 水位前移必须 miss");

  const reverted = await hydrate(
    createStore(sessionId, {
      entries: [modelSelectionEntry(BIG_MODEL, sessionId)],
      reverted: true,
    }),
    liveEvents,
  );
  assert.equal(reverted.plan.kind, "miss", "revert 是另一份持久事实，必须 miss");

  const otherWindow = await hydrate(
    createStore(sessionId, { entries: [modelSelectionEntry(BIG_MODEL, sessionId)] }),
    liveEvents,
    SMALL_WINDOW,
  );
  assert.equal(otherWindow.plan.kind, "miss", "档位不同必须 miss");
  assert.notEqual(
    (otherWindow.plan as Extract<ColdHydrationCachePlan, { kind: "miss" }>).fingerprint,
    (warmed.plan as Extract<ColdHydrationCachePlan, { kind: "miss" }>).fingerprint,
  );

  // 每个 miss 都回落到全量路径，结果与"没有缓存"时一致。
  const fresh = await runFullPath(fixture, liveEvents, BIG_WINDOW);
  assert.deepEqual(warmed.events, fresh.events);
});

// ── (e)：真正的活事件仍然整条绕过 ─────────────────────────────────────────

test("非 resume 生命周期的活事件整条绕过缓存，且不覆盖已有条目", async () => {
  const sessionId = "sess_gate_bypass";
  const store = createInMemorySessionEventStore();
  const liveEvents = await appendResume(store, sessionId);
  const fixture = createStore(sessionId, { entries: [modelSelectionEntry(BIG_MODEL, sessionId)] });
  const warmed = await hydrate(fixture, liveEvents);
  assert.equal(warmed.plan.kind, "miss");
  if (warmed.plan.kind !== "miss") throw new Error("unreachable");
  const before = cachedPayload(fixture, warmed.plan.fingerprint);

  const turnEvent = createSessionEvent(SessionEventType.TurnStarted, sidOf(sessionId), {
    inputVisibility: "user-visible",
    messageId: "m1",
  });
  const bypassed = await hydrate(fixture, [...liveEvents, turnEvent]);
  assert.equal(bypassed.plan.kind, "bypass");
  if (bypassed.plan.kind !== "bypass") throw new Error("unreachable");
  assert.equal(bypassed.plan.reason, "live-events");
  assert.deepEqual(bypassed.plan.liveEventTypes, [SessionEventType.TurnStarted]);
  assert.deepEqual(
    cachedPayload(fixture, warmed.plan.fingerprint),
    before,
    "(e) 绕过既不读也不写：已有条目原封不动",
  );

  // memory-only 但不是 resume 生命周期的类型同样绕过（它们能被 live 状态改写）。
  for (const type of [
    SessionEventType.ModelComplete,
    SessionEventType.RewindTriggered,
    SessionEventType.PermissionRequested,
    SessionEventType.DynamicWorkflowRunProgress,
  ]) {
    const plan = await planColdHydrationCache({
      contextWindow: BIG_WINDOW,
      events: [...liveEvents, createSessionEvent(type, sidOf(sessionId), {})],
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    assert.equal(plan.kind, "bypass", `${type} 必须绕过`);
    if (plan.kind !== "bypass") throw new Error("unreachable");
    assert.deepEqual(plan.liveEventTypes, [type]);
  }
});

test("零活事件（detached child 那种）仍然是可缓存的干净分支", async () => {
  const sessionId = "sess_gate_empty";
  const fixture = createStore(sessionId, { entries: [modelSelectionEntry(BIG_MODEL, sessionId)] });
  const empty = await createInMemorySessionEventStore().getEvents(sidOf(sessionId));
  const first = await hydrate(fixture, empty);
  assert.equal(first.plan.kind, "miss");
  const second = await hydrate(fixture, empty);
  assert.equal(second.plan.kind, "hit");
  assert.deepEqual(second.events, first.events);
});

// ── 判定面自己的两个跳过原因 ─────────────────────────────────────────────

test("no-store 与 context-window-unresolved 都是带原因的 bypass", async () => {
  const sessionId = "sess_gate_reasons";
  const store = createInMemorySessionEventStore();
  const liveEvents = await appendResume(store, sessionId);
  const fixture = createStore(sessionId);
  const noStore = await planColdHydrationCache({
    contextWindow: BIG_WINDOW,
    events: liveEvents,
    sessionId,
    store: undefined,
  });
  assert.deepEqual(noStore, { kind: "bypass", reason: "no-store" });

  const noWindow = await planColdHydrationCache({
    contextWindow: undefined,
    events: liveEvents,
    sessionId,
    store: fixture.store,
  });
  assert.deepEqual(noWindow, { kind: "bypass", reason: "context-window-unresolved" });
  assert.equal(fixture.calls.getSession, 0, "绕过发生在读 store 之前");
});

// ── 写前复核：合成期间输入变化 → 不写，宁可这次不缓存 ─────────────────────

test("写前复核挡下并发写入：水位前移、shared_context entry 变化都不写", async () => {
  const sessionId = "sess_gate_revalidate";
  const store = createInMemorySessionEventStore();
  const liveEvents = await appendResume(store, sessionId);
  const sharedContextEntry: SessionEntryInfo = {
    data: { contextId: "ctx-1", shareUrl: "https://example.invalid/s/1", status: "pending" },
    id: "entry-shared-context",
    sessionID: sidOf(sessionId),
    time: { created: WATERMARK, updated: WATERMARK },
    touchSession: false,
    type: "v4/shared_context_import",
  };
  const fixture = createStore(sessionId, {
    entries: [modelSelectionEntry(BIG_MODEL, sessionId), sharedContextEntry],
  });
  const plan = await planColdHydrationCache({
    contextWindow: BIG_WINDOW,
    events: liveEvents,
    sessionId,
    store: fixture.store,
  });
  assert.equal(plan.kind, "miss");
  if (plan.kind !== "miss") throw new Error("unreachable");

  const current = (target: StoreFixture) =>
    isColdHydrationCacheFingerprintCurrent({
      contextWindow: BIG_WINDOW,
      events: liveEvents,
      fingerprint: plan.fingerprint,
      sessionId,
      store: target.store,
    });

  assert.equal(await current(fixture), true, "没有写入时复核通过");
  assert.equal(
    await current(
      createStore(sessionId, {
        entries: [modelSelectionEntry(BIG_MODEL, sessionId), sharedContextEntry],
        watermark: WATERMARK + 1,
      }),
    ),
    false,
    "transcript 水位在合成期间前移 → 不写",
  );
  // session entry 不推进水位：只靠水位盖不住它，指纹里必须带上它的原始 data。
  assert.equal(
    await current(
      createStore(sessionId, {
        entries: [
          modelSelectionEntry(BIG_MODEL, sessionId),
          { ...sharedContextEntry, data: { ...(sharedContextEntry.data as object), status: "discarded" } },
        ],
      }),
    ),
    false,
    "shared_context entry 变化 → 不写",
  );

  // 未通过的复核不会留下条目：写路径跳过，下一次开合重新算。
  assert.equal(cachedPayload(fixture, plan.fingerprint), null);
});

// ── usageSeed 纯性的前提：resume 生命周期事件不写用量投影 ─────────────────

test("usageSeed 纯性前提：生命周期事件进 reducer 后不碰 contextUsed/contextWindow", () => {
  const empty = reduce([]);
  const resumed = reduce(resumeEventsForReducer("sess_gate_reducer"));
  assert.equal(empty.contextUsed, 0);
  assert.equal(resumed.contextUsed, empty.contextUsed, "没有 ModelComplete 就没有用量");
  assert.equal(
    resumed.contextWindow,
    empty.contextWindow,
    "没有 SessionCreated 就没有窗口改写（初值即投影值）",
  );
});

// ── 日志标记契约（沙箱验收要按字符串 grep）────────────────────────────────

test("三态标记是稳定 ASCII 且互不相同（沙箱按 event 名 grep）", () => {
  const markers = [
    COLD_HYDRATION_CACHE_LOG.hit,
    COLD_HYDRATION_CACHE_LOG.missWritten,
    COLD_HYDRATION_CACHE_LOG.bypassed,
  ];
  const events = markers.map((marker) => marker.event);
  assert.equal(new Set(events).size, 3);
  for (const marker of markers) {
    assert.match(marker.event, /^zcode_protocol\.v4\.cold_hydration_cache_[a-z_]+$/);
    assert.ok(marker.message.length > 0);
    // ASCII-only：带下标的字符串既 grep 不到，也说明复制粘贴被工具输出污染过。
    assert.ok(/^[\x20-\x7E]+$/.test(marker.message), marker.message);
    assert.ok(/^[\x20-\x7E]+$/.test(marker.event), marker.event);
  }
  assert.equal(COLD_HYDRATION_CACHE_LOG.hit.event, "zcode_protocol.v4.cold_hydration_cache_hit");
  assert.equal(
    COLD_HYDRATION_CACHE_LOG.missWritten.event,
    "zcode_protocol.v4.cold_hydration_cache_miss_written",
  );
  assert.equal(
    COLD_HYDRATION_CACHE_LOG.bypassed.event,
    "zcode_protocol.v4.cold_hydration_cache_bypassed",
  );
});
