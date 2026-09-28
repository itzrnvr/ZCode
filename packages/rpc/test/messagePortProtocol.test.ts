import assert from "node:assert/strict";
import test from "node:test";
import { MessagePortProtocol, type MessagePortLike } from "../src/protocol.js";
import { VSBuffer } from "../src/buffer.js";

type Listener = (event: { data: unknown }) => void;

/** Minimal in-process stand-in for a MessagePort: records the listener, dispatches on demand. */
function createFakePort(): { port: MessagePortLike; dispatch: (data: unknown) => void; posted: unknown[] } {
  let listener: Listener | null = null;
  const posted: unknown[] = [];
  const port: MessagePortLike = {
    addEventListener(_type, next: Listener) {
      listener = next;
    },
    removeEventListener(_type, next: Listener) {
      if (listener === next) listener = null;
    },
    postMessage(message) {
      posted.push(message);
    },
    start() {},
    close() {},
  };
  return {
    port,
    posted,
    dispatch(data: unknown) {
      assert.ok(listener, "protocol must register a message listener on construction");
      listener({ data });
    },
  };
}

function createHarness() {
  const fake = createFakePort();
  const protocol = new MessagePortProtocol(fake.port);
  const messages: Uint8Array[] = [];
  const flowStates: string[] = [];
  protocol.onMessage((buffer) => messages.push(buffer.buffer));
  protocol.onFlowState((state) => flowStates.push(state));
  return { ...fake, protocol, messages, flowStates };
}

test("binary frames reach onMessage and never the flow-control branch", () => {
  const harness = createHarness();
  const payload = new Uint8Array([1, 2, 3, 250, 0, 7]);
  harness.dispatch(payload);
  assert.equal(harness.messages.length, 1);
  assert.deepEqual([...harness.messages[0]!], [1, 2, 3, 250, 0, 7]);
  assert.deepEqual(harness.flowStates, []);
});

test("flow-control objects route to onFlowState only", () => {
  const harness = createHarness();
  harness.dispatch({ __zcodeRpcControl: "connection-flow-v1", state: "saturated" });
  harness.dispatch({ __zcodeRpcControl: "connection-flow-v1", state: "drained" });
  assert.deepEqual(harness.flowStates, ["saturated", "drained"]);
  assert.deepEqual(harness.messages, []);
});

test("forged and unknown objects are dropped without touching the frame path", () => {
  const harness = createHarness();
  // right discriminator but an extra key -> not the 2-key control shape
  harness.dispatch({ __zcodeRpcControl: "connection-flow-v1", state: "saturated", extra: 1 });
  // right shape, wrong discriminator
  harness.dispatch({ __zcodeRpcControl: "nope", state: "saturated" });
  // right shape, impossible state
  harness.dispatch({ __zcodeRpcControl: "connection-flow-v1", state: "unknown" });
  // arbitrary object, array, ArrayBuffer, null, string
  harness.dispatch({ hello: "world" });
  harness.dispatch([1, 2, 3]);
  harness.dispatch(new ArrayBuffer(8));
  harness.dispatch(null);
  harness.dispatch("connection-flow-v1");
  assert.deepEqual(harness.flowStates, []);
  assert.deepEqual(harness.messages, [], "only Uint8Array frames may enter the RPC stream");
});

test("send posts the underlying buffer and flow state posts the control object", () => {
  const harness = createHarness();
  harness.protocol.send(VSBuffer.wrap(new Uint8Array([9, 8, 7])));
  harness.protocol.sendFlowState("saturated");
  assert.equal(harness.posted.length, 2);
  const [first, second] = harness.posted;
  assert.ok(first instanceof Uint8Array || first instanceof ArrayBuffer);
  assert.deepEqual(second, { __zcodeRpcControl: "connection-flow-v1", state: "saturated" });
});

/**
 * Regression guard for the O(payload bytes) type-guard: the previous implementation
 * called Object.keys() on every non-Array object, and `Array.isArray(new Uint8Array())`
 * is false, so each binary frame materialized one string key per byte. Measured cost in
 * the live renderer: 1325 ms self time (22.6% of a cold-session click profile) with a
 * 1.19 MB frame. The bound is calibrated from both arms at this exact size on this repo's
 * test runner: old guard 247.5 ms, fixed guard 0.95 ms - so 50 ms fails the old path by 5x
 * and passes the new one by 50x.
 */
test("large binary frames are classified without enumerating their bytes", () => {
  const harness = createHarness();
  const big = new Uint8Array(4 * 1024 * 1024);
  big[0] = 42;
  big[big.length - 1] = 7;

  const startedAt = performance.now();
  harness.dispatch(big);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0]!.byteLength, big.byteLength);
  assert.equal(harness.messages[0]![0], 42);
  assert.ok(
    elapsedMs < 50,
    `classifying a 4 MB frame took ${elapsedMs.toFixed(1)}ms; the guard must not enumerate bytes`,
  );
});
