import assert from "node:assert/strict";
import test from "node:test";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import {
  buildNewAgentProfilesAvailableBody,
  diffNewAgentProfileNames,
  normalizeAgentProfiles,
  type AgentProfile,
} from "../src/subagent/profile.js";
import type { SessionId, TraceContext } from "@zcode/contracts";

const createTestTrace = (traceId: string): TraceContext => ({
  traceId: traceId as unknown as TraceContext["traceId"],
  spanId: "span-1",
  sessionId: "sess-test" as unknown as SessionId,
});

const makeProfile = (name: string): AgentProfile => ({
  name,
  description: `${name} helper`,
  source: "user",
  systemPrompt: "do things",
});

test("diffNewAgentProfileNames reports only added names", () => {
  const before = [makeProfile("alpha")];
  const after = [makeProfile("alpha"), makeProfile("beta"), makeProfile("beta")];
  assert.deepEqual(diffNewAgentProfileNames(before, after), ["beta"]);
  assert.deepEqual(diffNewAgentProfileNames(after, before), []);
  assert.deepEqual(diffNewAgentProfileNames(before, before), []);
});

test("buildNewAgentProfilesAvailableBody lists new agents", () => {
  const body = buildNewAgentProfilesAvailableBody(["my-helper"]);
  assert.ok(body.includes("my-helper"));
  assert.ok(body.includes("Agent tool"));
});

test("createExploreSubagentPort resolves profiles from getAgentProfiles live getter", async () => {
  let live: AgentProfile[] = [makeProfile("first")];
  let launched = 0;
  const port = createExploreSubagentPort({
    profiles: [makeProfile("first")],
    getAgentProfiles: () => live,
    runExploreAgent: async () => {
      launched++;
      return {
        response: "ok",
        traceId: "t" as unknown as TraceContext["traceId"],
        events: [],
      };
    },
    emitParentEvent: async () => {},
  });

  await port.launch({
    sessionId: "sess-1" as unknown as SessionId,
    agentType: "first",
    description: "d",
    prompt: "p",
    workingDirectory: ".",
    workspaceRoot: ".",
    trace: createTestTrace("t1"),
    parentToolCallId: "c1",
  });
  assert.equal(launched, 1);

  // Simulate Settings creating a new agent after session start.
  live = [makeProfile("first"), makeProfile("second")];
  await port.launch({
    sessionId: "sess-1" as unknown as SessionId,
    agentType: "second",
    description: "d",
    prompt: "p",
    workingDirectory: ".",
    workspaceRoot: ".",
    trace: createTestTrace("t2"),
    parentToolCallId: "c2",
  });
  assert.equal(launched, 2);
});

test("createExploreSubagentPort falls back to construction profiles without getter", async () => {
  let launched = 0;
  const port = createExploreSubagentPort({
    profiles: [makeProfile("solo")],
    runExploreAgent: async () => {
      launched++;
      return {
        response: "ok",
        traceId: "t" as unknown as TraceContext["traceId"],
        events: [],
      };
    },
    emitParentEvent: async () => {},
  });
  await port.launch({
    sessionId: "sess-1" as unknown as SessionId,
    agentType: "solo",
    description: "d",
    prompt: "p",
    workingDirectory: ".",
    workspaceRoot: ".",
    trace: createTestTrace("t3"),
    parentToolCallId: "c3",
  });
  assert.equal(launched, 1);
  // normalize still injects built-ins around the construction list.
  assert.ok(
    normalizeAgentProfiles([makeProfile("solo")]).some((p) => p.name === "general-purpose"),
  );
});
