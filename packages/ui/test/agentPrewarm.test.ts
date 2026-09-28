import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentPrewarmController,
  workspacePrewarmKey,
  type AgentPrewarmEvent,
} from "../src/lib/agentPrewarm.js";

interface Harness {
  events: AgentPrewarmEvent[];
  calls: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  pending: Array<() => void>;
  now: number;
}

function createHarness(options: {
  execute?: (target: { workspacePath: string; workspaceIdentity?: string }) => unknown;
  policy?: Parameters<typeof createAgentPrewarmController>[0] extends infer T
    ? T extends { policy?: infer P }
      ? P
      : never
    : never;
} = {}) {
  const harness: Harness = { events: [], calls: [], pending: [], now: 1_000 };
  const execute =
    options.execute ??
    ((target: { workspacePath: string; workspaceIdentity?: string }) => {
      harness.calls.push(target);
      return Promise.resolve();
    });
  const controller = createAgentPrewarmController({
    execute,
    now: () => harness.now,
    schedule: (run) => {
      harness.pending.push(run);
      return () => {};
    },
    policy: { intentDelayMs: 100, minIntervalMs: 1000, maxDistinctWorkspaces: 3, ...options.policy },
    onEvent: (event) => harness.events.push(event),
  });
  const flush = () => {
    const queued = harness.pending.splice(0, harness.pending.length);
    for (const run of queued) run();
  };
  return { controller, harness, flush };
}

const target = (workspacePath: string, extra: Record<string, unknown> = {}) => ({
  workspacePath,
  ...extra,
});

test("workspacePrewarmKey prefers identity over path", () => {
  assert.equal(workspacePrewarmKey({ workspacePath: "D:/a" }), "D:/a");
  assert.equal(
    workspacePrewarmKey({ workspacePath: "D:/a", workspaceIdentity: "ws-1" }),
    "ws-1",
  );
  assert.equal(workspacePrewarmKey({ workspacePath: "D:/a", workspaceIdentity: "  " }), "D:/a");
});

test("skips remote rows, the active workspace, empty paths and missing executor", () => {
  const { controller, harness, flush } = createHarness();
  controller.request(target("D:/remote", { remoteSessionId: "rs-1" }));
  controller.request(target("D:/active", { isActiveWorkspace: true }));
  controller.request(target("   "));
  flush();
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(
    harness.events.map((event) => event.reason),
    ["remote_workspace", "active_workspace", "empty_workspace_path"],
  );

  const bare = createAgentPrewarmController({
    execute: null,
    schedule: () => () => {},
    onEvent: (event) => harness.events.push(event),
  });
  bare.request(target("D:/x"));
  assert.equal(harness.events.at(-1)?.reason, "no_executor");
});

test("repeat hover of the same row warms that workspace once", () => {
  const { controller, harness, flush } = createHarness();
  controller.request(target("D:/a"));
  controller.request(target("D:/a"));
  controller.request(target("D:/a", { workspaceIdentity: "ws-a" }));
  flush();
  // 第三个请求带 identity，key 不同 → 允许一次；同一 key 的重复 hover 不再排程。
  assert.deepEqual(harness.calls, [{ workspacePath: "D:/a" }, { workspacePath: "D:/a", workspaceIdentity: "ws-a" }]);
  assert.equal(harness.events.filter((event) => event.reason === "already_requested").length, 1);
});

test("distinct workspace capacity is enforced per run", () => {
  const { controller, harness, flush } = createHarness();
  for (const path of ["D:/a", "D:/b", "D:/c", "D:/d"]) controller.request(target(path));
  flush();
  assert.deepEqual(harness.calls.map((call) => call.workspacePath), ["D:/a", "D:/b", "D:/c"]);
  assert.equal(harness.events.at(-1)?.reason, "capacity_reached");
  assert.equal(controller.requestedCount(), 3);
});

test("consecutive distinct hovers respect the minimum interval", () => {
  const { controller, harness, flush } = createHarness();
  controller.request(target("D:/a"));
  flush(); // fires at now=1000 → lastStartedAt=1000
  assert.equal(harness.calls.length, 1);

  harness.now = 1_200; // only 200ms later, interval is 1000ms
  controller.request(target("D:/b"));
  // scheduled, not yet fired
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.pending.length, 1);

  harness.now = 2_000; // interval elapsed by the time the scheduler runs it
  flush();
  assert.deepEqual(harness.calls.map((call) => call.workspacePath), ["D:/a", "D:/b"]);
});

test("executor failures are swallowed and reported as events", async () => {
  const { controller, harness, flush } = createHarness({
    execute: () => Promise.reject(new Error("agent spawn failed")),
  });
  controller.request(target("D:/boom"));
  flush();
  await Promise.resolve();
  await Promise.resolve();
  const failed = harness.events.filter((event) => event.kind === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.error, "agent spawn failed");
  // 失败也占一次名额：不重试、不连环 spawn。
  assert.equal(controller.requestedCount(), 1);
});

test("synchronous executor throw does not escape request()", () => {
  const { controller, harness, flush } = createHarness({
    execute: () => {
      throw new Error("sync boom");
    },
  });
  controller.request(target("D:/sync"));
  assert.doesNotThrow(flush);
  assert.equal(harness.events.filter((event) => event.kind === "failed").length, 1);
});
