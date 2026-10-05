// 冷恢复的工具耗时：合成事件必须带持久 part 上的真实起止时间。
//
// 缺陷形状（修复前）：synthesizeToolPart 的三个 push 都只传三个参数，于是事件时间戳落到
// push 的缺省值 `baseMs + seq`（transcript-hydration.ts:1558），而 row 的 startedAt/endedAt
// 直接取事件时间戳（product-projection-bash-progress.ts:27、product-projection.ts:2966）。
// 结果每个冷开会话的工具耗时都等于"中间隔了几条合成事件"（1~3ms），与 live 路径的真实耗时
// 对不上；transcript 里明明已经算好了 duration（:784/:801）却没人消费它。
// turnHeader.activeMs 早就被 activeMsForCompletion 挡过同一类问题（product-projection.ts:3676-3684），
// 工具行没有同等待遇。
//
// 这里从**行**上断言，而不是只断言事件时间戳：行才是渲染消费的东西。

import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type MessageWithParts, type SessionId } from "@zcode/contracts";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

const START = 1_790_000_000_000;
const DURATION_MS = 4_200;
const END = START + DURATION_MS;
const CONTEXT_WINDOW = 200_000;
const EPOCH_GUARD_MS = 1_000_000_000_000;

const idOf = (value: string) => value as unknown as MessageWithParts["info"]["id"];

function transcript(sessionId: string, toolState: Record<string, unknown>): MessageWithParts[] {
  const user = {
    info: {
      id: idOf("m1"),
      role: "user",
      time: { created: START - 60_000 },
    },
    parts: [{ id: idOf("m1-p0"), text: "write the file", type: "text" }],
  } as unknown as MessageWithParts;
  const assistant = {
    info: {
      id: idOf("m2"),
      modelId: "big-model",
      providerId: "acme",
      role: "assistant",
      time: { completed: END + 1_000, created: START - 1_000 },
      tokens: { input: 1_200, output: 300 },
    },
    parts: [
      { id: idOf("m2-p0"), text: "on it", type: "text" },
      {
        callID: "call-1",
        id: idOf("m2-p1"),
        messageID: idOf("m2"),
        sessionID: sessionId as unknown as SessionId,
        state: toolState,
        tool: "Write",
        type: "tool",
      },
    ],
  } as unknown as MessageWithParts;
  return [user, assistant];
}

/** 冷折叠（三源合并的 transcript 半边）+ 真实投影重放，返回事件与工具行。 */
function toolRowAfterColdFold(sessionId: string, messages: MessageWithParts[]) {
  const merged = mergeColdConversationEvents({
    contextWindow: CONTEXT_WINDOW,
    memoryEvents: [],
    messages,
    sessionId,
  });
  const projection = new ProductProjection(sessionId, "epoch-1");
  projection.beginHydrationReplay();
  for (const event of merged.events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay();
  const row = projection
    .getSnapshot()
    .rows.window.find((candidate) => candidate.kind === "toolCall");
  return { events: merged.events, row };
}

test("completed tool part: the cold fold keeps the real duration on the row", () => {
  const sessionId = "sess_tool_duration_completed";
  const { events, row } = toolRowAfterColdFold(
    sessionId,
    transcript(sessionId, {
      input: { path: "src/a.txt" },
      metadata: {},
      output: "wrote 1 file",
      status: "completed",
      time: { start: START, end: END },
      title: "Write",
    }),
  );

  const started = events.find((event) => event.type === SessionEventType.ToolCallStarted);
  const result = events.find((event) => event.type === SessionEventType.ToolCallResult);
  assert.ok(started, "冷折叠必须合成 ToolCallStarted");
  assert.ok(result, "冷折叠必须合成 ToolCallResult");
  assert.equal(started.timestamp.getTime(), START, "started 用持久 part 的真实开始时间");
  assert.equal(result.timestamp.getTime(), END, "result 用持久 part 的真实结束时间");

  // 行才是渲染消费的东西：修复前这里的差值是 seq 差（1~3ms）。
  assert.ok(row, "工具行必须存在（否则断言是空的）");
  assert.equal(row.status, "success");
  assert.equal(row.startedAt, START);
  assert.equal(row.endedAt, END);
  assert.equal(
    (row.endedAt ?? 0) - (row.startedAt ?? 0),
    DURATION_MS,
    "冷开的工具耗时必须等于真实耗时",
  );
});

test("error tool part: the real end time survives too", () => {
  const sessionId = "sess_tool_duration_error";
  const { events, row } = toolRowAfterColdFold(
    sessionId,
    transcript(sessionId, {
      error: "command exited 1",
      input: { command: "false" },
      status: "error",
      time: { start: START, end: END },
    }),
  );
  const result = events.find((event) => event.type === SessionEventType.ToolCallResult);
  assert.ok(result);
  assert.equal(result.timestamp.getTime(), END);
  assert.ok(row);
  assert.equal(row.status, "error");
  assert.equal((row.endedAt ?? 0) - (row.startedAt ?? 0), DURATION_MS);
});

test("running tool part: start is honoured and nothing falls back to the 1970 epoch", () => {
  const sessionId = "sess_tool_duration_running";
  const { events, row } = toolRowAfterColdFold(
    sessionId,
    transcript(sessionId, {
      input: { command: "sleep 5" },
      status: "running",
      time: { start: START },
    }),
  );
  const started = events.find((event) => event.type === SessionEventType.ToolCallStarted);
  assert.ok(started);
  assert.equal(started.timestamp.getTime(), START);
  assert.equal(
    events.some((event) => event.type === SessionEventType.ToolCallResult),
    false,
    "未完成的工具不能合成结果（历史 pending/running 由 TurnComplete(cancelled) 收口）",
  );
  assert.ok(row);
  assert.equal(row.startedAt, START, "startedAt 用真实开始时间，绝不因为兜底落到 0（1970）");
  // 未完成的工具由 TurnComplete(cancelled) 收口：行被折叠成 cancelled，endedAt 取轮次结束时间
  // （product-projection.ts:3050），这是既有产品语义，不是本修复引入的。
  assert.equal(row.status, "cancelled");
  assert.ok((row.endedAt ?? 0) >= START, "收口的 endedAt 不得早于真实开始时间");
  for (const event of events) {
    assert.ok(
      event.timestamp.getTime() > EPOCH_GUARD_MS,
      `合成事件时间戳不得落到 epoch: ${event.type}`,
    );
  }
});
