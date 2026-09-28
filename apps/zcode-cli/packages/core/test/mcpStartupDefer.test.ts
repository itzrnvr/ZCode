import assert from "node:assert/strict";
import test from "node:test";
import {
  initializeMcp,
  shouldStartMcpStartupEagerly,
  startMcpStartup,
} from "../src/runtime/methods/mcp.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { TraceContext } from "@zcode/contracts";

const trace = { traceId: "t", spanId: "s" } as unknown as TraceContext;

interface FakePortState {
  connectCalls: number;
}

function createFakeRuntime(options: {
  deferStartupUntilResumed?: boolean;
  servers?: Record<string, { type: "stdio"; command: string }>;
}): { runtime: AgentRuntimeInternal; state: FakePortState } {
  const state: FakePortState = { connectCalls: 0 };
  const registered: string[] = [];
  const runtime = {
    mcpInitialized: false,
    mcpStartupPromise: undefined,
    mcpToolsRegistered: false,
    config: {
      mcp: {
        enabled: true,
        servers: options.servers ?? { demo: { type: "stdio", command: "demo" } },
        ...(options.deferStartupUntilResumed === undefined
          ? {}
          : { deferStartupUntilResumed: options.deferStartupUntilResumed }),
      },
    },
    registry: {
      register: (entry: { metadata: { name: string } }) => {
        registered.push(entry.metadata.name);
      },
    },
    invalidateToolCache: () => {
      registered.length = 0;
    },
    trackResidencyBlockingWork: <T,>(work: Promise<T>): Promise<T> => work,
    mcpPort: {
      connectConfiguredServers: async () => {
        state.connectCalls += 1;
        return { statuses: {}, tools: [] };
      },
      status: async () => ({}),
      listTools: async () => [],
    },
    logger: undefined,
    workingDirectory: ".",
    // startMcpStartup/initializeMcp are prototype methods bound via `this`.
    startMcpStartup,
    initializeMcp,
  } as unknown as AgentRuntimeInternal;
  return { runtime, state };
}

test("shouldStartMcpStartupEagerly gates only the deferred-resume flag", () => {
  assert.equal(shouldStartMcpStartupEagerly({}), true);
  assert.equal(shouldStartMcpStartupEagerly({ mcp: {} }), true);
  assert.equal(shouldStartMcpStartupEagerly({ mcp: { deferStartupUntilResumed: false } }), true);
  assert.equal(shouldStartMcpStartupEagerly({ mcp: { deferStartupUntilResumed: true } }), false);
});

test("startMcpStartup connects once and is idempotent across repeat calls", async () => {
  const { runtime, state } = createFakeRuntime({});
  const first = startMcpStartup.call(runtime, trace);
  const second = startMcpStartup.call(runtime, trace);
  assert.equal(first, second, "repeat call must reuse the same startup promise");
  await first;
  assert.equal(state.connectCalls, 1);
});

test("deferred runtime that never resumes still starts MCP on first initializeMcp", async () => {
  const { runtime, state } = createFakeRuntime({ deferStartupUntilResumed: true });
  // Construction-time gate: deferred sessions must not connect eagerly.
  assert.equal(shouldStartMcpStartupEagerly(runtime.config), false);
  assert.equal(state.connectCalls, 0);

  await initializeMcp.call(runtime, trace);

  assert.equal(state.connectCalls, 1, "first turn must start MCP even without resume");
  assert.equal(runtime.mcpToolsRegistered, true);
});

test("deferred runtime started at resume tail does not reconnect on first turn", async () => {
  const { runtime, state } = createFakeRuntime({ deferStartupUntilResumed: true });
  // resumeFromStore 收尾调用同一条幂等入口。
  const startup = startMcpStartup.call(runtime, trace);
  await startup;
  assert.equal(state.connectCalls, 1);

  await initializeMcp.call(runtime, trace);
  assert.equal(state.connectCalls, 1, "initializeMcp must reuse the resume-tail startup");
});
