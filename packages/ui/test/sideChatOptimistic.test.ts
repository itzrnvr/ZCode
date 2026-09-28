import assert from "node:assert/strict";
import test from "node:test";
import {
  closeSidePaneTab,
  getActiveSelectionSideChatTab,
  openSelectionSideChatPane,
  type OpenSelectionSideChatRequest,
  type SelectionSideChatPaneTab,
  type WorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";

function baseRequest(overrides?: Partial<OpenSelectionSideChatRequest>): OpenSelectionSideChatRequest {
  return {
    workspacePath: "C:/proj",
    parentSessionId: "sess-parent",
    childSessionId: "sess-child-1",
    ...overrides,
  };
}

test("same child request reuses ordinal and activates without duplicating the tab", () => {
  let state: WorkspaceSidePaneState | null = null;
  state = openSelectionSideChatPane(state, { ...baseRequest(), workspaceKey: "ws" });
  const first = state?.tabs.filter(
    (tab): tab is SelectionSideChatPaneTab => tab.type === "selection-side-chat",
  );
  assert.equal(first?.length, 1);
  assert.equal(first?.[0]?.ordinal, 1);

  state = openSelectionSideChatPane(state, { ...baseRequest(), workspaceKey: "ws" });
  const second = state?.tabs.filter(
    (tab): tab is SelectionSideChatPaneTab => tab.type === "selection-side-chat",
  );
  assert.equal(second?.length, 1);
  assert.equal(second?.[0]?.ordinal, 1);
  assert.equal(state?.activeTabId, second?.[0]?.id);
});

test("a renamed child id can atomically replace the stale optimistic tab", () => {
  // Placeholder optimistic tab stands in for the not-yet-acknowledged create.
  let state: WorkspaceSidePaneState | null = openSelectionSideChatPane(null, {
    ...baseRequest({ childSessionId: "optimistic-sess-child-1" }),
    workspaceKey: "ws",
  });
  const placeholder = state?.tabs.find(
    (tab): tab is SelectionSideChatPaneTab => tab.type === "selection-side-chat",
  );
  assert.ok(placeholder);

  // ACK arrives with the real child id: the stale placeholder must disappear.
  state = closeSidePaneTab(state, placeholder!.id);
  state = openSelectionSideChatPane(state, {
    ...baseRequest({ childSessionId: "sess-child-1" }),
    workspaceKey: "ws",
  });
  const tabs = (state?.tabs ?? []).filter(
    (tab): tab is SelectionSideChatPaneTab => tab.type === "selection-side-chat",
  );
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]?.childSessionId, "sess-child-1");
});

test("the active side chat tab stays resolvable for the parent scope", () => {
  let state: WorkspaceSidePaneState | null = openSelectionSideChatPane(null, {
    ...baseRequest(),
    workspaceKey: "ws",
  });
  const active = getActiveSelectionSideChatTab(state, {
    workspaceKey: "ws",
    parentSessionId: "sess-parent",
  });
  assert.ok(active);
  assert.equal(active?.childSessionId, "sess-child-1");
});
