import assert from "node:assert/strict";
import test from "node:test";
import { settleWithin } from "../src/runtime/methods/mcp.ts";

test("settleWithin returns the value when the work settles first", async () => {
  const started = Date.now();
  const value = await settleWithin(Promise.resolve("connected"), "fallback", 400);
  assert.equal(value, "connected");
  assert.ok(Date.now() - started < 200, "fast path must not wait for the deadline");
});

test("settleWithin falls back at the deadline when the work never settles", async () => {
  let timedOut = false;
  const started = Date.now();
  const value = await settleWithin(new Promise<never>(() => {}), "fallback", 150, () => {
    timedOut = true;
  });
  const elapsed = Date.now() - started;

  assert.equal(value, "fallback");
  assert.equal(timedOut, true, "onTimeout must fire so callers can log the partial path");
  // 这里刻意让事件循环空闲：unref 的计时器在空闲循环里不会触发，
  // 会让“首个轮次不被 MCP 拖住”的保证静默失效。
  assert.ok(elapsed >= 120 && elapsed < 600, `deadline fired after ${elapsed}ms, expected ~150ms`);
});

test("settleWithin propagates rejections so callers decide the fallback", async () => {
  await assert.rejects(
    settleWithin(Promise.reject(new Error("boom")), "fallback", 400),
    /boom/,
  );
});
