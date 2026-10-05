import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONVERSATION_ROWS_PREFETCH_POLICY,
  createConversationRowsPrefetchController,
  notifyTaskListPrefetchOpened,
  registerConversationRowsPrefetchController,
} from "../src/v4/conversationRowsPrefetch.js";
import type {
  ConversationRowsPrefetchCandidate,
  ConversationRowsPrefetchEvent,
} from "../src/v4/conversationRowsPrefetch.js";
import { createPrefetchCache } from "../src/v4/conversationRowsFastPath.js";
import type { ConversationRowsFastOutcome } from "../src/v4/conversationRowsFastPath.js";

// 排空微任务，让 read() 的 .then 续体跑完再断言。
// 不用真实计时器也不用假时钟：读取 double 立即 resolve，续体本来就是 microtask，
// 轮次是确定的；而 Bun 的 node:test shim 没有 timer mocking（所以调度器全部走注入的
// scheduleIdle/scheduleDelay，同 test/agentPrewarm.test.ts:16-46 的手动 flush 做法）。
async function drainMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve();
  }
}

interface PrefetchHarness {
  submit(candidates: readonly ConversationRowsPrefetchCandidate[]): void;
  notifyInteraction(): void;
  notifyOpened(sessionId: string): void;
  queued(): readonly string[];
  requestedCount(): number;
  events(): readonly ConversationRowsPrefetchEvent[];
  reads(): readonly string[];
  /** 只跑 idle 回调、不推进时钟：用来证明「交互之后即使有 idle 机会也不会读」。 */
  flushIdle(): Promise<void>;
  /** 完整推进虚拟时钟：idle 回调 + 到期的延迟回调（min-interval / 交互延后）跑到静默。 */
  flush(): Promise<void>;
  advance(ms: number): void;
  idlePending(): number;
  delayPending(): number;
  dispose(): void;
  /** 把本 harness 的控制器注册到纯模块的全局注册点（数据层走的就是那个入口）。 */
  register(): void;
  unregister(): void;
}

function createHarness(options: {
  policy?: Partial<typeof DEFAULT_CONVERSATION_ROWS_PREFETCH_POLICY>;
  outcomes?: Record<string, ConversationRowsFastOutcome>;
} = {}): PrefetchHarness {
  let current = 10_000;
  const cache = createPrefetchCache(() => current);
  const idleQueue: (() => void)[] = [];
  const delayQueue: { run: () => void; at: number }[] = [];
  const reads: string[] = [];
  const events: ConversationRowsPrefetchEvent[] = [];
  const outcomes = options.outcomes ?? {};

  const controller = createConversationRowsPrefetchController({
    read: (candidate) => {
      reads.push(candidate.sessionId);
      return Promise.resolve(
        outcomes[candidate.sessionId] ?? {
          ok: true,
          revision: `${candidate.sessionId}:1:1`,
          rows: [],
          hasMore: false,
        },
      );
    },
    scheduleIdle: (run) => {
      idleQueue.push(run);
      return () => {
        const index = idleQueue.indexOf(run);
        if (index !== -1) idleQueue.splice(index, 1);
      };
    },
    scheduleDelay: (run, delayMs) => {
      const entry = { run, at: current + delayMs };
      delayQueue.push(entry);
      return () => {
        const index = delayQueue.indexOf(entry);
        if (index !== -1) delayQueue.splice(index, 1);
      };
    },
    cache,
    now: () => current,
    policy: options.policy,
    onEvent: (event) => events.push(event),
  });

  const drainIdle = async (): Promise<void> => {
    // pump 每次只发起 maxInFlight 条读取，读完再排下一次 idle，所以要循环到队列空。
    for (let guard = 0; guard < 256 && idleQueue.length > 0; guard++) {
      const run = idleQueue.shift();
      run?.();
      await drainMicrotasks();
    }
  };

  // 调度器在两次读取之间会排 minIntervalMs 的延迟（默认 120 ms），所以「跑到静默」
  // 必须同时推进虚拟时钟，否则队列永远停在第二条候选上。推进到「最早到期的延迟」
  // 而不是固定步长，断言才是确定的、也不依赖真实时间。
  const drainAll = async (): Promise<void> => {
    for (let guard = 0; guard < 256; guard++) {
      if (idleQueue.length > 0) {
        await drainIdle();
        continue;
      }
      if (delayQueue.length === 0) return;
      const earliest = delayQueue.reduce(
        (min, entry) => Math.min(min, entry.at),
        Number.POSITIVE_INFINITY,
      );
      if (earliest > current) current = earliest;
      const dueIndex = delayQueue.findIndex((entry) => entry.at <= current);
      if (dueIndex === -1) return;
      const [due] = delayQueue.splice(dueIndex, 1);
      due.run();
      await drainMicrotasks();
    }
  };

  return {
    submit: (candidates) => controller.submit(candidates),
    notifyInteraction: () => controller.notifyInteraction(),
    notifyOpened: (sessionId) => controller.notifyOpened(sessionId),
    queued: () => controller.queuedSessionIds(),
    requestedCount: () => controller.requestedCount(),
    events: () => events,
    reads: () => reads,
    flushIdle: drainIdle,
    flush: drainAll,
    advance: (ms) => {
      current += ms;
    },
    idlePending: () => idleQueue.length,
    delayPending: () => delayQueue.length,
    dispose: () => controller.dispose(),
    register: () => registerConversationRowsPrefetchController(controller),
    unregister: () => registerConversationRowsPrefetchController(null),
  };
}

function candidates(...sessionIds: string[]): ConversationRowsPrefetchCandidate[] {
  return sessionIds.map((sessionId) => ({
    sessionId,
    workspacePath: "/tmp/ws",
    remote: false,
  }));
}

function skipReasons(harness: PrefetchHarness, sessionId: string): readonly (string | undefined)[] {
  return harness
    .events()
    .filter((event) => event.kind === "skipped" && event.sessionId === sessionId)
    .map((event) => event.reason);
}

test("空列表是 no-op：不排 idle、不发读取、也不清掉已排好的队列", async () => {
  const harness = createHarness();
  harness.submit([]);
  assert.equal(harness.idlePending(), 0);
  assert.equal(harness.reads().length, 0);

  harness.submit(candidates("sess_a"));
  assert.deepEqual(harness.queued(), ["sess_a"]);
  // 侧栏在流式刷新/搜索无结果时会反复传空列表，不能因此把队列清掉。
  harness.submit([]);
  assert.deepEqual(harness.queued(), ["sess_a"]);
  await harness.flush();
  assert.deepEqual(harness.reads(), ["sess_a"]);
});

test("候选上限 K：超出部分被跳过，且保序（前 K 个才是会被读的那些）", async () => {
  const harness = createHarness({ policy: { candidateLimit: 3 } });
  harness.submit(candidates("s1", "s2", "s3", "s4", "s5"));
  assert.deepEqual(harness.queued(), ["s1", "s2", "s3"]);
  assert.deepEqual(skipReasons(harness, "s4"), ["candidate_limit"]);
  assert.deepEqual(skipReasons(harness, "s5"), ["candidate_limit"]);
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1", "s2", "s3"]);
  assert.equal(harness.requestedCount(), 3);
});

test("默认策略下 K = 6，且严格串行（在途永远只有一条）", async () => {
  assert.equal(DEFAULT_CONVERSATION_ROWS_PREFETCH_POLICY.candidateLimit, 6);
  assert.equal(DEFAULT_CONVERSATION_ROWS_PREFETCH_POLICY.maxInFlight, 1);
  const harness = createHarness();
  harness.submit(candidates("s1", "s2", "s3", "s4", "s5", "s6", "s7"));
  assert.equal(harness.queued().length, 6, "K=6，第 7 个被上限挡住");
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1", "s2", "s3", "s4", "s5", "s6"]);
  // 串行的证据：每次 pump 只发起一条，读完才排下一次；若并发，reads 会在一次 flush
  // 内一次性出现 6 条而 requestedCount 与队列消耗不同步。
  assert.equal(harness.requestedCount(), 6);
  assert.deepEqual(harness.queued(), []);
});

test("远端会话一律跳过：本地 host accessor 不能代表远端 workspace 读 store", async () => {
  const harness = createHarness();
  harness.submit([
    { sessionId: "s_local", workspacePath: "/tmp/ws", remote: false },
    { sessionId: "s_remote", workspacePath: "/tmp/ws", workspaceIdentity: "remote-a", remote: true },
  ]);
  assert.deepEqual(harness.queued(), ["s_local"]);
  assert.deepEqual(skipReasons(harness, "s_remote"), ["remote_session"]);
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s_local"]);
});

test("已有新鲜缓存的会话不重复付反序列化；TTL 过期后会重新请求", async () => {
  const harness = createHarness();
  harness.submit(candidates("s1"));
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1"]);

  harness.submit(candidates("s1"));
  assert.deepEqual(skipReasons(harness, "s1").slice(-1), ["already_cached"]);
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1"], "缓存新鲜时不该再读一次");

  // TTL 与两个 keep-warm 窗口同标度（30 s）：过期即丢弃，不自动刷新。
  harness.advance(30_000);
  harness.submit(candidates("s1"));
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1", "s1"], "TTL 过期后允许重新请求");
});

test("已被打开的会话出队且不再读取：pane 自己那次读取就是权威的那次", async () => {
  const harness = createHarness();
  harness.submit(candidates("s1", "s2", "s3"));
  harness.notifyOpened("s2");
  assert.deepEqual(harness.queued(), ["s1", "s3"]);
  assert.deepEqual(skipReasons(harness, "s2"), ["opened"]);
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1", "s3"]);

  // 打开之后再次提交同一份可见行，也不该把它排回去。
  harness.submit(candidates("s1", "s2", "s3"));
  assert.ok(!harness.queued().includes("s2"));
});

test("用户交互当场取消待跑的 idle 回调，延后到期才恢复", async () => {
  const harness = createHarness();
  harness.submit(candidates("s1", "s2"));
  assert.equal(harness.idlePending(), 1, "提交后应排了一个 idle 回调");
  harness.notifyInteraction();
  assert.equal(harness.idlePending(), 0, "交互必须取消掉待跑的 idle 回调");
  assert.equal(harness.delayPending(), 1, "改排一个延后回调，而不是直接丢掉队列");
  assert.equal(harness.reads().length, 0);
  // 只给 idle 机会、不推进时钟：证明取消是真的取消，而不是被立刻重排。
  await harness.flushIdle();
  assert.equal(harness.reads().length, 0, "取消后即使有 idle 机会也不该读");

  // 推进虚拟时钟到延后到期：队列恢复并跑完。
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1", "s2"]);
  assert.equal(harness.delayPending(), 0);
});

test("队列空时交互不产生任何延后调度", () => {
  const harness = createHarness();
  harness.notifyInteraction();
  assert.equal(harness.idlePending(), 0);
  assert.equal(harness.events().length, 0);
});

test("读取失败只记录不缓存，且不影响后续候选", async () => {
  const harness = createHarness({
    outcomes: { s2: { ok: false, reason: "unsupported" } },
  });
  harness.submit(candidates("s1", "s2", "s3"));
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1", "s2", "s3"]);
  const failed = harness.events().filter((event) => event.kind === "failed");
  assert.deepEqual(
    failed.map((event) => event.sessionId),
    ["s2"],
  );
});

test("重复提交同一份可见行不会产生重复候选（流式刷新会整份重建数组）", async () => {
  const harness = createHarness();
  harness.submit(candidates("s1", "s2"));
  harness.submit(candidates("s1", "s2"));
  assert.deepEqual(harness.queued(), ["s1", "s2"]);
  assert.deepEqual(skipReasons(harness, "s1"), ["already_queued"]);
  await harness.flush();
  assert.deepEqual(harness.reads(), ["s1", "s2"]);
});

test("dispose 之后不再提交、不再读取", async () => {
  const harness = createHarness();
  harness.submit(candidates("s1"));
  harness.dispose();
  assert.equal(harness.idlePending(), 0);
  harness.submit(candidates("s2"));
  await harness.flush();
  assert.deepEqual(harness.reads(), []);
});

test("注册点：注册之前 notifyTaskListPrefetchOpened 是 no-op，注册之后才会出队", async () => {
  // 数据层 import 的是纯模块上的这个入口，控制器由 React 胶水层创建后注册进来——
  // 这样 sessionDataLayer -> useTaskListPrefetch -> workspaceConnectionRegistry ->
  // sessionDataLayer 的环就断了。注册之前必须安静地什么都不做（侧栏还没渲染过，
  // 本来也没有预取可取消），不能抛。
  assert.doesNotThrow(() => notifyTaskListPrefetchOpened("sess_not_registered"));

  const harness = createHarness();
  harness.register();
  try {
    harness.submit(candidates("s1", "s2"));
    notifyTaskListPrefetchOpened("s1");
    assert.deepEqual(harness.queued(), ["s2"], "已打开的会话必须出队");
    await harness.flush();
    assert.deepEqual(harness.reads(), ["s2"], "出队之后不该再为它付一次读取");
  } finally {
    harness.unregister();
  }
  // 注销之后回到 no-op：胶水层卸载不能让数据层的调用炸掉。
  assert.doesNotThrow(() => notifyTaskListPrefetchOpened("s2"));
  harness.dispose();
});
