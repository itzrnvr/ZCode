import assert from "node:assert/strict";
import test from "node:test";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
import { ConversationProjectionStore } from "../src/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "../src/v4/transport.js";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";

// 这两条测试钉住一个别人提醒过的隐患：快绘临时层的「权威 snapshot 落地后永久拒绝播种」
// 标记是**按 store 实例**存的（conversationFastRowsLayer.ts 的 authoritativeApplied）。
// 如果哪天有人为了省构造成本把 store 做成对象池、跨会话复用同一个实例，那个标记就会
// 泄漏到下一个会话，表现为「快绘再也不命中」——不报错，只是静默失效，极难查。
//
// 两道防线，各测一条：
// 1. 数据层对同一 topic 永远只构造一个实例、对不同 topic 一定构造不同实例，且退订时
//    先 entries.delete 再 store.close（sessionDataLayer.ts:145-155），所以过期后重新
//    acquire 必然是新实例，不存在把已关闭实例塞回表里的路径。
// 2. 已关闭的 store 拒绝播种——即使将来真的出现池化，也毒不到下一个使用者。
//
// 传输面双按「手写内存 double」的口径给（先例：packages/rpc/test/messagePortProtocol.test.ts:8-33
// 的 createFakePort）：只实现被测路径会碰到的成员，其余成员在被测路径上不可达。
function createTransportDouble(options: { withFastRows?: boolean } = {}): {
  transport: ConversationTransport;
  frameListeners: Set<(frame: unknown) => void>;
  unsubscribeCalls: string[];
  /** 按调用先后记录成员名：用来断言载荷顺序（顺序不会在负载下抖，毫秒阈值会）。 */
  callOrder: string[];
} {
  const frameListeners = new Set<(frame: unknown) => void>();
  const unsubscribeCalls: string[] = [];
  const callOrder: string[] = [];
  const noopUnsubscribe = (): (() => void) => () => {};
  const double = {
    // subscribe 直接失败：本测试只关心实例身份与播种门，不关心订阅成功路径。
    // 失败会落到 store.state.status = "error"，不影响 store 实例的构造与复用规则。
    subscribe: () => {
      callOrder.push("subscribe");
      return Promise.reject(new Error("test: subscribe not exercised"));
    },
    activate: () => {},
    resync: () => Promise.reject(new Error("test: unused")),
    unsubscribe: (subscriptionId: string) => {
      unsubscribeCalls.push(subscriptionId);
      return Promise.resolve();
    },
    onFrame: (listener: (frame: unknown) => void) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onAssemblyFault: noopUnsubscribe,
    onRuntimeRestart: noopUnsubscribe,
    rowsRange: () => Promise.reject(new Error("test: unused")),
    // 缺省带上快绘读；withFastRows: false 用来测「传输面没有该成员」的降级路径。
    ...(options.withFastRows === false
      ? {}
      : {
          conversationRows: () => {
            callOrder.push("conversationRows");
            return Promise.resolve(okOutcome());
          },
        }),
  };
  return {
    transport: double as ConversationTransport,
    frameListeners,
    unsubscribeCalls,
    callOrder,
  };
}

function okOutcome() {
  return {
    ok: true as const,
    revision: "1:1:1",
    rows: [{ kind: "turnHeader", rowId: 1, turnId: "turn-1" }],
    hasMore: false,
  };
}

test("同一 topic 复用同一个 store 实例，不同 topic 一定是不同实例", () => {
  const { transport } = createTransportDouble();
  // keepWarmMs 给一个大值：本测试不触发过期，因此不需要任何计时器推进。
  const layer = new SessionDataLayer({ transport, keepWarmMs: 600_000 });

  const firstA = layer.acquire("sess_a");
  const secondA = layer.acquire("sess_a");
  assert.equal(firstA.store, secondA.store, "同 session 多 pane = 多视图，必须共享一个 store");
  assert.equal(layer.size, 1);

  const firstB = layer.acquire("sess_b");
  assert.notEqual(firstA.store, firstB.store, "不同 session 绝不能共用实例");
  assert.equal(layer.size, 2);

  // 引用未归零时 release 不改变实例身份。
  secondA.release();
  const thirdA = layer.acquire("sess_a");
  assert.equal(thirdA.store, firstA.store);

  layer.dispose();
});

test("引用归零进入 keep-warm 期间，重新 acquire 拿到的仍是同一个暖实例", () => {
  const { transport } = createTransportDouble();
  const layer = new SessionDataLayer({ transport, keepWarmMs: 600_000 });
  const first = layer.acquire("sess_a");
  first.release();
  // keep-warm 窗口内 openKind 应该是 keep_warm，且实例不变——这正是暖切换省掉
  // 那 1 287 ms 的机制，也是 pane keep-alive 之外第二层复用。
  const second = layer.acquire("sess_a");
  assert.equal(second.store, first.store);
  assert.equal(second.openKind, "keep_warm");
  layer.dispose();
});

test("已关闭的 store 永久拒绝播种：即使将来出现实例池化也毒不到下一个使用者", async () => {
  const { transport, unsubscribeCalls } = createTransportDouble();
  const store = new ConversationProjectionStore(conversationTopic("sess_a"), transport);
  assert.equal(store.seedFastRows(okOutcome()), true, "新鲜 store 可以播种");
  assert.notEqual(store.getState().fastRows, null);

  await store.close();
  assert.equal(store.getState().fastRows, null, "close 必须清掉临时行");
  assert.equal(store.seedFastRows(okOutcome()), false, "close 之后永久拒绝");
  assert.equal(store.getState().fastRows, null);
  assert.deepEqual(unsubscribeCalls, [], "订阅从未成功，因此没有可退订的 subscriptionId");
});

// 这条在 EDITS.md 步骤 7c 落地之前是**红的**，这是刻意的：它钉住整个设计里最容易被
// 「顺手整理」掉的一个性质。
test("快绘读取必须在 subscribe 之前发出：串行队列上载荷顺序就是延迟", () => {
  const { transport, callOrder } = createTransportDouble();
  const layer = new SessionDataLayer({ transport, keepWarmMs: 600_000 });
  const lease = layer.acquire("sess_a");
  // CLI 把同一连接上的所有请求串在一个 FIFO 上
  // （bootstrap/src/zcode-protocol/transport.ts:186-195，shouldBypassProcessingQueue :224-233
  // 只放行 sessionStop / workspaceCancelGenerateText），而 subscribe 的处理函数里就是
  // 视图冷物化（约 2 280 ms hydration）。subscribe 先进队列，快绘就排在整段 hydration 后面，
  // 功能等于没做。断言顺序而不是耗时：顺序不会在负载下抖，毫秒阈值会（projection lane
  // 的同类保证也是用顺序测的——handler resolve 时零次 commit）。
  assert.deepEqual(callOrder.slice(0, 2), ["conversationRows", "subscribe"]);
  lease.release();
  layer.dispose();
});

test("传输面没有 conversationRows 成员时，acquire 仍然照常订阅（降级不影响权威路径）", () => {
  const { transport, callOrder } = createTransportDouble({ withFastRows: false });
  const layer = new SessionDataLayer({ transport, keepWarmMs: 600_000 });
  const lease = layer.acquire("sess_a");
  assert.deepEqual(callOrder, ["subscribe"], "没有快绘读可发，就不该凭空多一次调用");
  assert.equal(lease.store.getState().fastRows, null);
  lease.release();
  layer.dispose();
});
