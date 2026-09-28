import assert from "node:assert/strict";
import test from "node:test";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import {
  normalizeBuiltInSelectionOverrides,
  DEFAULT_SUBAGENT_TYPE,
  EXPLORE_AGENT_TYPE,
} from "../src/subagent/profile.js";
import type { ModelSelection } from "@zcode/shared";
import type { SessionId, TraceContext } from "@zcode/contracts";

const createTestTrace = (traceId: string): TraceContext => ({
  traceId,
  spanId: "span-1",
  sessionId: "sess-test" as unknown as SessionId,
});

test("normalizeBuiltInSelectionOverrides handles valid and invalid input", () => {
  const valid = normalizeBuiltInSelectionOverrides({
    "general-purpose": { providerId: "provider-a", modelId: "model-a" },
    Explore: { providerId: "provider-b", modelId: "model-b", options: { reasoningLevel: "high" } },
  });
  assert.equal(valid["general-purpose"]?.providerId, "provider-a");
  assert.equal(valid["general-purpose"]?.modelId, "model-a");
  assert.equal(valid.Explore?.providerId, "provider-b");
  assert.equal(valid.Explore?.options?.reasoningLevel, "high");

  // Invalid inputs safely normalize to empty object
  assert.deepEqual(normalizeBuiltInSelectionOverrides(null), {});
  assert.deepEqual(normalizeBuiltInSelectionOverrides(undefined), {});
  assert.deepEqual(normalizeBuiltInSelectionOverrides("invalid"), {});
  assert.deepEqual(normalizeBuiltInSelectionOverrides({ "general-purpose": { invalid: true } }), {});
});

test("createExploreSubagentPort updates model selection dynamically via updateBuiltInModelSelectionOverrides", async () => {
  const initialOverride: ModelSelection = { providerId: "initial-prov", modelId: "initial-model" };
  const updatedOverride: ModelSelection = { providerId: "updated-prov", modelId: "updated-model" };

  let capturedProfileModel: ModelSelection | undefined;

  const port = createExploreSubagentPort({
    builtInModelSelectionOverrides: {
      [DEFAULT_SUBAGENT_TYPE]: initialOverride,
    },
    runExploreAgent: async (request) => {
      capturedProfileModel = request.profile.modelSelection;
      return {
        response: "ok",
        traceId: "trace-1",
        events: [],
      };
    },
    emitParentEvent: async () => {},
  });

  // First launch should use initialOverride
  await port.launch({
    sessionId: "sess-1" as unknown as SessionId,
    agentType: DEFAULT_SUBAGENT_TYPE,
    description: "test initial",
    prompt: "do something",
    workingDirectory: ".",
    workspaceRoot: ".",
    trace: createTestTrace("t1"),
    parentToolCallId: "call-1",
  });
  assert.deepEqual(capturedProfileModel, initialOverride);

  // Update overrides live (simulating Settings save)
  port.updateBuiltInModelSelectionOverrides({
    [DEFAULT_SUBAGENT_TYPE]: updatedOverride,
  });

  // Next launch should use updatedOverride without restarting port or session
  await port.launch({
    sessionId: "sess-1" as unknown as SessionId,
    agentType: DEFAULT_SUBAGENT_TYPE,
    description: "test updated",
    prompt: "do something else",
    workingDirectory: ".",
    workspaceRoot: ".",
    trace: createTestTrace("t2"),
    parentToolCallId: "call-2",
  });
  assert.deepEqual(capturedProfileModel, updatedOverride);
});

test("createExploreSubagentPort resolves live overrides via getBuiltInModelSelectionOverrides getter", async () => {
  let liveOverride: ModelSelection = { providerId: "live-prov-1", modelId: "live-model-1" };
  let capturedProfileModel: ModelSelection | undefined;

  const port = createExploreSubagentPort({
    getBuiltInModelSelectionOverrides: () => ({
      [EXPLORE_AGENT_TYPE]: liveOverride,
    }),
    runExploreAgent: async (request) => {
      capturedProfileModel = request.profile.modelSelection;
      return {
        response: "ok",
        traceId: "trace-2",
        events: [],
      };
    },
    emitParentEvent: async () => {},
  });

  await port.launch({
    sessionId: "sess-2" as unknown as SessionId,
    agentType: EXPLORE_AGENT_TYPE,
    description: "test explore 1",
    prompt: "search files",
    workingDirectory: ".",
    workspaceRoot: ".",
    trace: createTestTrace("t3"),
    parentToolCallId: "call-3",
  });
  assert.deepEqual(capturedProfileModel, liveOverride);

  // Simulate file change on disk picked up by getter
  liveOverride = { providerId: "live-prov-2", modelId: "live-model-2" };

  await port.launch({
    sessionId: "sess-2" as unknown as SessionId,
    agentType: EXPLORE_AGENT_TYPE,
    description: "test explore 2",
    prompt: "search more files",
    workingDirectory: ".",
    workspaceRoot: ".",
    trace: createTestTrace("t4"),
    parentToolCallId: "call-4",
  });
  assert.deepEqual(capturedProfileModel, liveOverride);
});
