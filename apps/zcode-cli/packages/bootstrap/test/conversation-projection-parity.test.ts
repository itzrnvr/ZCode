import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageWithParts,
  SessionEntryInfo,
  SessionGoal,
  SessionId,
} from "@zcode/contracts";
import type { ConversationRow, ConversationRowKind } from "@zcode/shared/zcode-protocol-v4";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import {
  buildConversationProjectionRows,
  CONV_PROJECTION_LOG_EPOCH,
  type ProjectionMaterializationStore,
} from "../src/zcode-protocol-v4/conversation-projection-store.js";

/**
 * 折叠 parity：0024 存下来的行必须与 view 路径**当场折出来**的行逐字相同。
 *
 * 参照实现刻意**不复用** buildConversationProjectionRows，而是照 v4-bridge.ts 的 record-less
 * 分支（loadPersistedEventsWithoutRecord，:1573-1660）逐字重接一遍六个 merge 输入。
 * 这样才能抓住真正的风险 —— builder 的**接线**漂移（多传了 contextWindow、漏了 target 的
 * hasOwnProperty 语义、memoryEvents 没给空数组），而不是「自己等于自己」的重言式。
 *
 * 参照口径（与 bridge 的 record-less 分支一一对应）：
 * - memoryEvents: []                     <- :1577
 * - messages: 同一份 500 尾部尾读         <- :1734 readPersistedSessionMessages
 * - goalVerificationEntries: source.*    <- :1613
 * - target: hasOwnProperty 展开           <- :1617-1619
 * - fileChangeSummariesByMessageId: 省略  <- :1588-1602 的 reader 直接抛
 *                                          fault.hydrate.artifactReaderRequiresRuntime，
 *                                          没有 record 就没有 CheckpointCreated，摘要恒为空
 * - contextWindow: 省略                   <- :1605-1609 解析得出，但它只进 snapshot.usage/config
 *                                          （onSessionCreated 返回 []；onModelSelected /
 *                                          onModelComplete 只发 state.updated），从不进任何一行
 */

type AnyId = MessageWithParts["info"]["id"];

function id(value: string): AnyId {
  return value as unknown as AnyId;
}

const SESSION = "sess_parity";
const CREATED = 1_700_000_000_000;

function userMessage(messageId: string, text: string, created: number): MessageWithParts {
  return {
    info: {
      id: id(messageId),
      role: "user",
      sessionID: id(SESSION),
      time: { created },
      semantics: { origin: "real_user", kind: "user_prompt" },
    },
    parts: [
      {
        id: id(`${messageId}-p0`),
        type: "text",
        text,
        sessionID: id(SESSION),
        messageID: id(messageId),
      },
    ],
  } as unknown as MessageWithParts;
}

function assistantMessage(
  messageId: string,
  created: number,
  parts: Array<Record<string, unknown>>,
): MessageWithParts {
  return {
    info: {
      id: id(messageId),
      role: "assistant",
      sessionID: id(SESSION),
      time: { created, completed: created + 5_000 },
      semantics: { origin: "agent_runtime", kind: "assistant_response" },
    },
    parts: parts.map((part, index) => ({
      ...part,
      id: id(`${messageId}-p${index}`),
      sessionID: id(SESSION),
      messageID: id(messageId),
    })),
  } as unknown as MessageWithParts;
}

function toolPart(callID: string, tool: string, output: string, start: number) {
  return {
    type: "tool",
    callID,
    tool,
    state: {
      status: "completed",
      input: { command: output },
      output,
      time: { start, end: start + 4_200 },
    },
  };
}

/** 两轮：user -> assistant(text + reasoning + tool) -> user -> assistant(text)。 */
function fixtureMessages(): MessageWithParts[] {
  return [
    userMessage("msg_u1", "first question", CREATED),
    assistantMessage("msg_a1", CREATED + 1_000, [
      { type: "reasoning", text: "thinking about it" },
      { type: "text", text: "first answer" },
      toolPart("call_1", "Bash", "ok", CREATED + 2_000),
    ]),
    userMessage("msg_u2", "second question", CREATED + 10_000),
    assistantMessage("msg_a2", CREATED + 11_000, [{ type: "text", text: "second answer" }]),
  ];
}

function materializationStore(messages: MessageWithParts[], target?: SessionGoal | null) {
  const store: ProjectionMaterializationStore = {
    getSession: async () => ({ title: "parity", time: { created: CREATED, updated: CREATED } }) as never,
    messages: async () => messages,
    readTarget: async () => target ?? null,
    sessionEntries: async (): Promise<SessionEntryInfo[]> => [],
  };
  return store;
}

/** 参照实现：照 bridge 的 record-less 分支重接一遍，然后折到底。 */
async function referenceFold(
  messages: MessageWithParts[],
  target?: SessionGoal | null,
): Promise<ConversationRow[]> {
  const source = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    persistedMessages: messages,
    sessionId: SESSION,
    store: materializationStore(messages, target),
  });
  const merged = mergeColdConversationEvents({
    memoryEvents: [],
    messages: source.messages,
    sessionId: SESSION,
    goalVerificationEntries: source.goalVerificationEntries,
    ...(Object.prototype.hasOwnProperty.call(source, "target") ? { target: source.target } : {}),
  });
  const projection = new ProductProjection(SESSION, CONV_PROJECTION_LOG_EPOCH);
  projection.beginHydrationReplay();
  for (const event of merged.events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay();
  return projection.getSnapshot().rows.window.slice();
}

function fold(messages: MessageWithParts[], target?: SessionGoal | null) {
  return buildConversationProjectionRows(
    SESSION,
    materializationStore(messages, target),
    messages,
  );
}

test("builder rows are byte-identical to the bridge record-less reference fold", async () => {
  const messages = fixtureMessages();
  const actual = await fold(messages);
  const expected = await referenceFold(messages);

  assert.ok(actual.length > 0, "fixture 必须真的折出行，否则这条断言是空的");
  // 逐字比较序列化结果，而不是 deepEqual：存进 SQLite 的就是这个字符串，
  // 所以「逐字相同」才是要保的性质（后缀 diff 也比字节）。
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});

test("the same input folds to the same rows twice (determinism is what licenses persisting rows)", async () => {
  const messages = fixtureMessages();
  const first = await fold(messages);
  const second = await fold(messages);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  // rowId 稠密自 1 递增，且与数组下标同序 —— 0024 的 seq 列就是数组下标，
  // 这条性质破了，游标翻页与后缀 diff 都会错位。
  first.forEach((row, index) => {
    assert.equal(row.rowId, index + 1);
  });
});

test("turnId is the durable user messageId, and a narrower tail shifts rowId but not turnId", async () => {
  const messages = fixtureMessages();
  const rows = await fold(messages);
  // 真实用户轮的 product turn 身份 = 持久 user messageId（event-normalizer.ts:220-228：
  // 「live 使用 runtime turnId、cold 使用 hydrate-turn-N …… 真实用户轮以持久 user messageId
  // 作为稳定 product turn 身份；legacy 缺 messageId 时才保留 runtime fallback」）。
  // 所以 turnId 不是合成计数器，而是持久标识 —— 这比按 hydrate-turn-N 认行强得多。
  assert.deepEqual(
    [...new Set(rows.map((row) => row.turnId))],
    ["msg_u1", "msg_u2"],
  );
  for (const row of rows) {
    assert.equal(row.productTurnId, row.turnId, "productTurnId 就是 turnId 的逐字副本");
  }

  // 丢掉第一轮 = 换了一份更窄的尾读。rowId 是 nextRowId++ 的计数器，于是从 1 重新数；
  // 但 turnId 仍然钉在持久 messageId 上，不跟着 scope 漂。
  // 这正是 renderer 用 turnId/entityId 认行、把 rowId 只当临时值的依据，
  // 也是 builder 仍须显式吃同一份尾读的理由：scope 变的是**哪些行在**与它们的 rowId，
  // 以及 legacy 无 messageId 消息的 hydrate-turn-N fallback。
  const tailOnly = messages.slice(2);
  const tailRows = await fold(tailOnly);
  assert.deepEqual(
    [...new Set(tailRows.map((row) => row.turnId))],
    ["msg_u2"],
    "turnId 不随 scope 漂移",
  );
  const fullSecondTurn = rows.filter((row) => row.turnId === "msg_u2");
  assert.deepEqual(
    tailRows.map((row) => row.rowId),
    fullSecondTurn.map((_, index) => index + 1),
    "rowId 从 1 重新数，与全量里同一轮的编号不同",
  );
  assert.notDeepEqual(
    tailRows.map((row) => row.rowId),
    fullSecondTurn.map((row) => row.rowId),
  );
  // 行内容除了 rowId/createdAtSeq 这类序数事实之外应当一致：turnId 与 entityId 都对得上。
  assert.deepEqual(
    tailRows.map((row) => [row.turnId, row.entityId, row.kind]),
    fullSecondTurn.map((row) => [row.turnId, row.entityId, row.kind]),
  );
});

test("durable-only rows carry no activation-bound fields, and the durable ones are present", async () => {
  const rows = await fold(fixtureMessages());
  const kinds = new Set(rows.map((row) => row.kind));

  // 该在的都在：这四类完全由持久 transcript 合成。
  const expectedKinds: ConversationRowKind[] = [
    "turnHeader",
    "userInput",
    "assistantText",
    "toolCall",
  ];
  for (const expected of expectedKinds) {
    assert.ok(kinds.has(expected), `缺 ${expected} 行`);
  }
  // hookInvocation 整个 kind 缺席：HookRun* 没有任何持久合成点，
  // cold-event-merge 只是把内存 hook 事件挪到 durable turn 上。
  assert.equal(kinds.has("hookInvocation"), false);
  // artifact 行在本分支根本没有 product-projection 发射器（唯一构造点是 share 期），
  // 所以它在权威快照里也不存在——不是快路径的缺失项。
  assert.equal(kinds.has("artifact"), false);

  for (const row of rows) {
    if (row.kind === "turnHeader") {
      // fileChanges 的源是 CheckpointCreated 内存事件 + record.app.readToolResultArtifact，
      // record-less 分支的 artifact reader 直接抛，于是摘要恒空、字段恒缺。
      assert.equal(row.fileChanges, undefined, "快路径不许伪造 fileChanges");
      // canRewindFiles 由 fileChanges 派生，所以它也必然缺席。
      assert.equal(row.actions?.canRewindFiles, undefined);
      // 轮次工时是**真的**：activeMsForCompletion 在没有 queue-drain split ordinal 时
      // 直接返回 transcript 算好的 duration，正是为了不被 cold 合成时间戳覆盖。
      assert.equal(typeof row.activeMs, "number");
      assert.equal(row.state, "completedSuccess");
    }
    if (row.kind === "toolCall") {
      assert.equal(row.status, "success");
      // pendingApproval / approvalInteractionId 只能由 PermissionRequested（内存事件）产生。
      assert.equal(row.approvalInteractionId, undefined);
      assert.equal(row.outputPreview, undefined);
      // entityId 是稳定键：toolCall 用 part.callID，renderer 靠它跨 swap 认行。
      assert.equal(row.entityId, row.toolCallId);
    }
    if (row.kind === "userInput") {
      // entityId = 持久 user messageId（与 turnId 同源），是 renderer 跨 swap 认行的稳定键。
      assert.equal(row.entityId, row.turnId);
      assert.ok(row.entityId === "msg_u1" || row.entityId === "msg_u2");
    }
  }
});

test("target shifts createdAtSeq only, and the builder tracks the bridge in both target states", async () => {
  const messages = fixtureMessages();
  const target = {
    id: "goal_1",
    sessionID: id(SESSION),
    objective: "ship it",
    status: "active",
    // mergeColdConversationEvents 用 target.time.updated 造 TargetChanged 的时间戳
    // （cold-event-merge.ts:800），缺了就是 undefined 读属性。
    time: { created: CREATED, updated: CREATED + 500 },
  } as unknown as SessionGoal;

  const withTarget = await fold(messages, target);
  const withNull = await fold(messages, null);
  const without = await fold(messages);

  // 有 target 时，cold-event-merge.ts:793-807 会在 SessionCreated 之后插一条 TargetChanged。
  // 它**不产生行**（onTargetChanged 只发 state，goalSet marker 在本分支从不发射），
  // 但它吃掉一个事件序号，于是每一行的 createdAtSeq 整体 +1。
  // 这条是实测出来的，不是推出来的：先前按「target 不影响行」断言，红在这里。
  // 对 0024 的含义很具体 —— createdAtSeq 不是跨构建稳定的键（renderer 也已被明确告知），
  // 而 rowId / turnId / entityId / kind 全部不受影响。
  assert.equal(withTarget.length, without.length, "target 不增行也不减行");
  assert.deepEqual(
    withTarget.map((row) => [row.rowId, row.turnId, row.entityId, row.kind]),
    without.map((row) => [row.rowId, row.turnId, row.entityId, row.kind]),
  );
  withTarget.forEach((row, index) => {
    assert.equal(
      row.createdAtSeq,
      without[index]!.createdAtSeq + 1,
      "注入的 TargetChanged 恰好让序号整体 +1",
    );
  });

  // 显式 null 与缺键都走 `input.target ? ... : transcriptEvents` 的假值分支，所以两者相同。
  // hasOwnProperty 的语义差别（显式 null 抑制 memory TargetChanged）只在有内存事件时才显现，
  // 而 record-less 构建的 memoryEvents 恒为空 —— 于是对 0024 而言两者等价，这里把它钉住。
  assert.equal(JSON.stringify(withNull), JSON.stringify(without));

  // 真正的 parity 断言：两种 target 状态下，builder 都必须与 bridge 的 record-less 参照逐字相同。
  // 接线漂移（多传/漏传 target）会让这条红，而上面那些结构性断言不会。
  assert.equal(JSON.stringify(withTarget), JSON.stringify(await referenceFold(messages, target)));
  assert.equal(JSON.stringify(without), JSON.stringify(await referenceFold(messages)));
});
