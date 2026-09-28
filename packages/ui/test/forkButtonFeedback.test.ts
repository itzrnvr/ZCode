import assert from "node:assert/strict";
import test from "node:test";

interface ForkButtonState {
  isForking: boolean;
  disabled: boolean;
  ariaBusy: boolean;
  label: string;
  tooltip: string;
}

function createForkActionController(options: {
  forkLabel?: string;
  forkingLabel?: string;
  onFork?: (target: { rowId: number; entityId: string }) => Promise<unknown> | void;
}) {
  const forkLabel = options.forkLabel ?? "Fork";
  const forkingLabel = options.forkingLabel ?? "Forking...";
  let isForking = false;
  let callCount = 0;

  const getState = (): ForkButtonState => ({
    isForking,
    disabled: isForking,
    ariaBusy: isForking,
    label: isForking ? forkingLabel : forkLabel,
    tooltip: isForking ? forkingLabel : forkLabel,
  });

  const handleClick = async (target: { rowId: number; entityId: string }) => {
    if (isForking) {
      return; // prevent duplicate clicks while pending
    }
    isForking = true;
    try {
      callCount++;
      const res = options.onFork?.(target);
      if (res && typeof res === "object" && "then" in res) {
        await res;
      }
    } catch {
      // Handled gracefully so unhandled rejection does not crash the UI
    } finally {
      isForking = false;
    }
  };

  return {
    getState,
    handleClick,
    getCallCount: () => callCount,
  };
}

test("fork button shows idle state initially", () => {
  const controller = createForkActionController({});
  const initial = controller.getState();
  assert.equal(initial.isForking, false);
  assert.equal(initial.disabled, false);
  assert.equal(initial.ariaBusy, false);
  assert.equal(initial.label, "Fork");
});

test("fork button switches to forking state, disables, and prevents duplicate clicks while pending", async () => {
  let resolveFork: () => void = () => {};
  const pendingPromise = new Promise<void>((resolve) => {
    resolveFork = resolve;
  });

  const controller = createForkActionController({
    onFork: () => pendingPromise,
  });

  const clickPromise = controller.handleClick({ rowId: 1, entityId: "msg-1" });

  // While pending, state must reflect forking
  const pendingState = controller.getState();
  assert.equal(pendingState.isForking, true);
  assert.equal(pendingState.disabled, true);
  assert.equal(pendingState.ariaBusy, true);
  assert.equal(pendingState.label, "Forking...");

  // Attempting second click while pending must be ignored
  await controller.handleClick({ rowId: 1, entityId: "msg-1" });
  assert.equal(controller.getCallCount(), 1);

  // Resolve the fork promise
  resolveFork();
  await clickPromise;

  // After completion, button returns to idle state
  const completedState = controller.getState();
  assert.equal(completedState.isForking, false);
  assert.equal(completedState.disabled, false);
  assert.equal(completedState.ariaBusy, false);
  assert.equal(completedState.label, "Fork");
});

test("fork button restores idle state even if onFork rejects", async () => {
  let rejectFork: (err: Error) => void = () => {};
  const failingPromise = new Promise<void>((_, reject) => {
    rejectFork = reject;
  });

  const controller = createForkActionController({
    onFork: () => failingPromise,
  });

  const clickPromise = controller.handleClick({ rowId: 2, entityId: "msg-2" });
  assert.equal(controller.getState().isForking, true);

  rejectFork(new Error("CAS mismatch"));
  await clickPromise;

  assert.equal(controller.getState().isForking, false);
  assert.equal(controller.getState().disabled, false);
});
