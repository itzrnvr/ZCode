import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TID_CHAT_SUMMARY_PANEL } from "@zcode/shared";
import type { GoalState } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeSessionSideChat } from "@zcode/shared";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ConversationStatusPanel } from "../src/v4/ConversationStatusPanel.js";

/**
 * 组件级回归：副屏区块此前从未进过 DOM（issue #38 的收尾）。
 *
 * `sideChatPanelModel.test.ts` 只覆盖纯 builder，而真实故障在 **prop 边界**：
 * `ConversationStatusPanelProps` 没有 `sideChats`，SessionPane 只传了 `onOpenSideChat`
 * 回调，于是面板自建模型时 `model.sideChats` 恒为 []——`canRenderSideChats` 关掉区块，
 * 且"只有副屏"的会话连 `model.hasContent` 都是 false，整个面板 return null。
 * builder 测试对此全绿，所以这一层必须由组件自己守。
 *
 * 用 SSR（renderToStaticMarkup）而不是 DOM 环境：仓库没有 jsdom/testing-library，
 * 而这段逻辑全在 render 期（prop -> useMemo builder -> 闸门 -> 区块），一次静态渲染就能
 * 完整走过。TooltipProvider 必须由调用方给（ControlHintTooltip 不再自建 Provider，
 * 共享在 Root），ZCodeIntlProvider 提供区块标题与计数文案。
 */

type PanelProps = ComponentProps<typeof ConversationStatusPanel>;

function sideChat(
  overrides: Partial<ZCodeSessionSideChat> & { sessionId: string },
): ZCodeSessionSideChat {
  return {
    title: "Selection side chat",
    createdAt: 1_000,
    updatedAt: 2_000,
    isActive: false,
    ...overrides,
  };
}

function renderPanel(props: Partial<PanelProps> = {}): string {
  const panel = createElement(ConversationStatusPanel, {
    workspacePath: "D:/work/demo",
    ...props,
  } as PanelProps);
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(TooltipProvider, { children: panel }),
    }),
  );
}

/** 完整 GoalState（zod 输出类型没有可选字段）：只给 status/text 会在 GoalStatusSection 里炸。 */
function activeGoal(): GoalState {
  return {
    targetId: "goal-1",
    objective: "keep going",
    summaryTitle: null,
    timeUsedSeconds: 12,
    activeRunStartedAtMs: null,
    status: "active",
    iteration: 1,
    verifications: [],
    iterations: [],
  };
}

test("side chats alone keep the panel mounted and render the section (#38 prop boundary)", () => {
  const html = renderPanel({
    parentSessionId: "sess_parent",
    sideChats: [
      sideChat({
        sessionId: "sess_child_live",
        title: "Refactor auth",
        isActive: true,
        updatedAt: 900,
      }),
      sideChat({ sessionId: "sess_child_old", title: "Draft release notes", updatedAt: 100 }),
    ],
    onOpenSideChat: () => {},
  });

  // 修复前这里就是 ""：只有副屏的会话整个面板被 hasContent 闸门卸掉。
  assert.notEqual(html, "", "a session whose only content is side chats must not null the panel");
  assert.ok(
    html.includes(`data-testid="${TID_CHAT_SUMMARY_PANEL}"`),
    `summary panel shell missing: ${html.slice(0, 400)}`,
  );
  assert.ok(
    html.includes('data-status-section="sideChats"'),
    `Side chats section never reached the DOM: ${html.slice(0, 800)}`,
  );
  assert.ok(html.includes('data-status-section-trigger="sideChats"'), "section header missing");
  assert.ok(html.includes("Side chats"), "section title must be localized");
  // 区块默认收起（defaultOpen=false，与 workflow/agent/terminal 同），收起态 Radix 不渲染
  // 行；表头徽标则直接由条目算出，所以它们就是"条目确实到了区块"的证据。
  assert.ok(html.includes("2 chats"), `entry count badge missing: ${html}`);
  assert.ok(html.includes("1 active"), `active count badge missing: ${html}`);
});

test("counts in the collapsed header follow the entries", () => {
  const html = renderPanel({
    parentSessionId: "sess_parent",
    sideChats: [
      sideChat({ sessionId: "sess_a", isActive: true }),
      sideChat({ sessionId: "sess_b", isActive: true }),
      sideChat({ sessionId: "sess_c" }),
    ],
  });
  assert.ok(html.includes("3 chats"), html);
  assert.ok(html.includes("2 active"), html);
});

test("an empty side chat directory renders no section and fabricates no rows", () => {
  const html = renderPanel({
    parentSessionId: "sess_parent",
    sideChats: [],
    goal: activeGoal(),
    onOpenSideChat: () => {},
  });
  assert.notEqual(html, "", "the goal alone still mounts the panel");
  assert.ok(!html.includes('data-status-section="sideChats"'), "empty directory must not render");
  assert.ok(!html.includes("data-side-chat-trigger"), "rows must not be invented");
});

test("panel still renders nothing when there is no content at all", () => {
  assert.equal(renderPanel(), "");
});
