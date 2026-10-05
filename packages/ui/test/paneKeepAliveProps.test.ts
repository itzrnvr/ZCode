import assert from "node:assert/strict";
import test from "node:test";
import {
  RETAINED_PANE_HIDDEN_CLASS_NAME,
  RETAINED_PANE_NEUTRALIZED_PROPS,
  resolveRetainedPaneProps,
} from "../src/v4/paneKeepAliveProps.js";
import type { SessionPaneProps } from "../src/v4/SessionPane.js";

// 每个键给一个可辨识的哨兵值，断言看的是「输出里这个键变成了什么」。
// SessionPaneProps 的三个必填项照实给；其余键的类型在这里不重要，所以整体做一次
// 具名断言（测试不参与 tsc：packages/ui/tsconfig.json:20 只 include src/**）。
const SENTINEL = "sentinel";

// 必须保留原值的 pane 身份键：改了就会 remount，keep-alive 的收益当场归零。
const PRESERVED_PROPS = [
  "workspaceIdentity",
  "remoteSessionId",
  "readOnly",
  "isDesktop",
  "allowWorkspaceFileRewind",
  "rootSessionId",
  "selectionSideChat",
  "openTrigger",
  "onSplitRight",
  "onClosePane",
  "onOpenBrowserUrl",
] as const;

// 每个被降级键的期望中性值；不在表里的一律 undefined。
const NEUTRAL_VALUES: Partial<Record<(typeof RETAINED_PANE_NEUTRALIZED_PROPS)[number], unknown>> = {
  searchResultHighlightRequest: null,
  activeSelectionSideChatSessionId: null,
  conversationFindQuery: "",
  conversationFindActiveIndex: -1,
  conversationFindNavigationRequestId: 0,
  focused: false,
  telemetryVisible: false,
};

function createActiveProps(): SessionPaneProps {
  const record: Record<string, unknown> = {
    paneId: "workspace-main",
    sessionId: "sess_active",
    workspacePath: "/tmp/ws",
  };
  for (const key of [...RETAINED_PANE_NEUTRALIZED_PROPS, ...PRESERVED_PROPS]) {
    record[key] = `${SENTINEL}:${key}`;
  }
  // 必填三项不能被哨兵覆盖。
  record.paneId = "workspace-main";
  record.sessionId = "sess_active";
  record.workspacePath = "/tmp/ws";
  const active = record as SessionPaneProps;
  return active;
}

test("隐藏保留 pane 拿到的是它自己的 sessionId，且焦点与遥测可见性都关掉", () => {
  const retained = resolveRetainedPaneProps(createActiveProps(), "sess_retained");
  assert.equal(retained.sessionId, "sess_retained");
  assert.equal(retained.focused, false);
  // 这个 prop 的存在理由就是「forceMount 的隐藏 tab 传 false」（SessionPane.tsx:316-320）。
  assert.equal(retained.telemetryVisible, false);
});

test("活跃任务级、shell 共享状态级、会改路由的回调，全部降级", () => {
  const retained = resolveRetainedPaneProps(createActiveProps(), "sess_retained") as unknown as Record<
    string,
    unknown
  >;
  for (const key of RETAINED_PANE_NEUTRALIZED_PROPS) {
    const expected = key in NEUTRAL_VALUES ? NEUTRAL_VALUES[key] : undefined;
    assert.deepEqual(
      retained[key],
      expected,
      `${key} 必须降级为 ${String(expected)}：发给隐藏 pane 会造成路由改写 / 双写入方 / 多 pane 同时高亮`,
    );
  }
});

test("pane 身份与会话级回调原样保留：改它们会导致 remount，keep-alive 就白做了", () => {
  const retained = resolveRetainedPaneProps(createActiveProps(), "sess_retained") as unknown as Record<
    string,
    unknown
  >;
  // paneId / workspacePath 是必填项，哨兵会被真实值覆盖，所以单独断言。
  assert.equal(retained.paneId, "workspace-main");
  assert.equal(retained.workspacePath, "/tmp/ws");
  for (const key of PRESERVED_PROPS) {
    assert.equal(retained[key], `${SENTINEL}:${key}`, `${key} 必须原样保留`);
  }
});

test("被改动的键集合恰好等于降级表 + sessionId（防漂移：多降一个或少降一个都会红）", () => {
  const active = createActiveProps() as unknown as Record<string, unknown>;
  const retained = resolveRetainedPaneProps(createActiveProps(), "sess_retained") as unknown as Record<
    string,
    unknown
  >;
  const changed = new Set<string>();
  for (const key of Object.keys(active)) {
    if (!Object.is(active[key], retained[key])) changed.add(key);
  }
  const expected = new Set<string>([...RETAINED_PANE_NEUTRALIZED_PROPS, "sessionId"]);
  assert.deepEqual([...changed].sort(), [...expected].sort());
});

test("隐藏类名用 opacity + pointer-events，绝不用 display:none", () => {
  // display:none 会把滚动容器 clientHeight 归零、虚拟器测量作废，reshow 时整列重测；
  // RootWorkspaceContent.tsx:113-123 还记了三种布局/弹层失效。
  assert.ok(RETAINED_PANE_HIDDEN_CLASS_NAME.includes("opacity-0"));
  assert.ok(RETAINED_PANE_HIDDEN_CLASS_NAME.includes("pointer-events-none"));
  assert.ok(RETAINED_PANE_HIDDEN_CLASS_NAME.includes("absolute"));
  assert.ok(!RETAINED_PANE_HIDDEN_CLASS_NAME.includes("hidden"));
  assert.ok(!RETAINED_PANE_HIDDEN_CLASS_NAME.includes("display"));
});
