import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";
import type { ZCodeSessionSideChat } from "@zcode/shared";

function wire(overrides: Partial<ZCodeSessionSideChat> & { sessionId: string }): ZCodeSessionSideChat {
  return {
    title: "Selection side chat",
    createdAt: 1_000,
    updatedAt: 2_000,
    isActive: false,
    ...overrides,
  };
}

test("no side chats leaves the section empty and does not fabricate content", () => {
  const model = buildConversationStatusPanelModel({});
  assert.deepEqual(model.sideChats, []);
  assert.equal(model.hasContent, false);
});

test("side chats alone make the panel non-empty (they were the only entry point, #38)", () => {
  const model = buildConversationStatusPanelModel({
    sideChats: [wire({ sessionId: "sess-child-1" })],
  });
  assert.equal(model.sideChats.length, 1);
  assert.equal(model.hasContent, true, "a session with side chats must render a panel section");
});

test("active side chats sort first, then most-recently-updated", () => {
  const model = buildConversationStatusPanelModel({
    sideChats: [
      wire({ sessionId: "sess-old", updatedAt: 100 }),
      wire({ sessionId: "sess-new", updatedAt: 900 }),
      wire({ sessionId: "sess-live-old", updatedAt: 200, isActive: true }),
    ],
  });
  assert.deepEqual(
    model.sideChats.map((sideChat) => sideChat.sessionId),
    ["sess-live-old", "sess-new", "sess-old"],
  );
});

test("side chat identity/titles/activity survive the projection", () => {
  const model = buildConversationStatusPanelModel({
    sideChats: [
      wire({
        sessionId: "sess-9da2e8e2",
        title: "Selection side chat",
        updatedAt: 1_790_649_239_312,
        isActive: true,
      }),
    ],
  });
  assert.deepEqual(model.sideChats, [
    {
      sessionId: "sess-9da2e8e2",
      title: "Selection side chat",
      updatedAt: 1_790_649_239_312,
      isActive: true,
    },
  ]);
});

test("builder does not mutate or reorder the caller's array", () => {
  const input = [
    wire({ sessionId: "sess-a", updatedAt: 1 }),
    wire({ sessionId: "sess-b", updatedAt: 2, isActive: true }),
  ];
  const snapshot = input.map((entry) => entry.sessionId);
  buildConversationStatusPanelModel({ sideChats: input });
  assert.deepEqual(
    input.map((entry) => entry.sessionId),
    snapshot,
  );
});

test("side chats coexist with other sections instead of suppressing them", () => {
  const model = buildConversationStatusPanelModel({
    sideChats: [wire({ sessionId: "sess-child-1" })],
    goal: { status: "active", text: "keep going" } as never,
  });
  assert.equal(model.sideChats.length, 1);
  assert.notEqual(model.goal, null);
  assert.equal(model.hasContent, true);
});
