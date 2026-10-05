import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_PAINT_SETTLE_IDLE_TIMEOUT_MS,
  INITIAL_ROW_OVERSCAN,
  SETTLED_ROW_OVERSCAN,
  resolveTimelineOverscan,
} from "../src/v4/timelineViewportOverscan.js";

test("首绘未落定时收窄 overscan，落定后回到常态值", () => {
  assert.equal(resolveTimelineOverscan({ escalated: false, unitCount: 3 }), INITIAL_ROW_OVERSCAN);
  assert.equal(resolveTimelineOverscan({ escalated: true, unitCount: 3 }), SETTLED_ROW_OVERSCAN);
});

test("常态值就是 timeline 一直用的 8，收窄值必须严格更小", () => {
  // 这条断言的意义在于把「收窄」这件事钉住：如果哪天有人把 INITIAL 调到 8，
  // 本模块就退化成一句恒等式，而冷开时 unitCount 只有 3（trace-summary.json 实测），
  // 8 的 overscan 会把整份列表挂上去——那正是要避免的。
  assert.equal(SETTLED_ROW_OVERSCAN, 8);
  assert.ok(INITIAL_ROW_OVERSCAN < SETTLED_ROW_OVERSCAN);
});

test("unitCount 为 0 时直接给常态值：没有行可挂，收窄只会白改一次虚拟器配置", () => {
  assert.equal(resolveTimelineOverscan({ escalated: false, unitCount: 0 }), SETTLED_ROW_OVERSCAN);
});

test("unitCount 很大时收窄同样生效：肥尾窗口才是这个旋钮真正要兜的场景", () => {
  // 60 行 x 每行最多 32 KiB head + 32 KiB tail 工具输出；这种窗口下少挂几个 unit
  // 省下的是实打实的主线程时间，而不只是「列表看起来短」。
  assert.equal(resolveTimelineOverscan({ escalated: false, unitCount: 60 }), INITIAL_ROW_OVERSCAN);
  assert.equal(resolveTimelineOverscan({ escalated: true, unitCount: 60 }), SETTLED_ROW_OVERSCAN);
});

test("idle 落定必须有兜底超时：窗口被遮挡时 idle 回调会被节流", () => {
  // 只靠 requestIdleCallback 的话，最小化/被遮挡的窗口里 overscan 会永远停在收窄档，
  // 用户一恢复窗口就看到空行。超时值与 hooks/useTabPersistence.ts 的既有写法同量级。
  assert.ok(FIRST_PAINT_SETTLE_IDLE_TIMEOUT_MS > 0);
  assert.ok(FIRST_PAINT_SETTLE_IDLE_TIMEOUT_MS <= 2000);
});
