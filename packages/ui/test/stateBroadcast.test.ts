import assert from "node:assert/strict";
import test from "node:test";
import {
  BROADCAST_STATE_FIELDS,
  applyBroadcastField,
  broadcastFieldOfMessage,
  type BroadcastField,
  type BroadcastFieldSetters,
} from "../src/store/stateBroadcast.js";

/**
 * 跨窗口广播的入站契约：channel -> 字段 -> setter。
 * 这里只锁定映射与分发本身；取值的归一化规则归 lib/interfaceMode、lib/pointerCursors
 * 各自负责，所以本文件不固定它们的内部表示，只要求入站负载确实经过它们。
 */

type SetterCalls = Record<keyof BroadcastFieldSetters, unknown[]>;

/** 六路 setter 的名字（声明顺序无关，已按名字排序）。 */
const SETTER_NAMES = [
  "setInterfaceMode",
  "setLocale",
  "setPointerCursors",
  "setTheme",
  "setUiColors",
  "setUiFontSizePx",
] as const satisfies readonly (keyof BroadcastFieldSetters)[];

/** 只记录调用的假 setter：不引入 store、DOM 或任何副作用。 */
function createRecorder(): { calls: SetterCalls; setters: BroadcastFieldSetters } {
  const calls: SetterCalls = {
    setInterfaceMode: [],
    setLocale: [],
    setPointerCursors: [],
    setTheme: [],
    setUiColors: [],
    setUiFontSizePx: [],
  };
  const record = <K extends keyof BroadcastFieldSetters>(name: K) => (value: unknown) => {
    calls[name].push(value);
  };
  return {
    calls,
    setters: {
      setInterfaceMode: record("setInterfaceMode"),
      setLocale: record("setLocale"),
      setPointerCursors: record("setPointerCursors"),
      setTheme: record("setTheme"),
      setUiColors: record("setUiColors"),
      setUiFontSizePx: record("setUiFontSizePx"),
    },
  };
}

/** 被调用过的 setter 名单：一条广播打到多个 setter 就是串扰。 */
const activeSetters = (calls: SetterCalls) =>
  SETTER_NAMES.filter((name) => calls[name].length > 0).sort();

const totalCalls = (calls: SetterCalls) =>
  SETTER_NAMES.reduce((total, name) => total + calls[name].length, 0);

type InboundMessage = Parameters<typeof broadcastFieldOfMessage>[0];

/** 解析只读 channel；发送方、负载体等字段不参与本模块契约，故不伪造其形状。 */
const messageOn = (channel: string) => ({ channel }) as InboundMessage;

test("broadcastFieldOfMessage resolves state channels and rejects everything else", () => {
  assert.equal(broadcastFieldOfMessage(messageOn("state:uiColors")), "uiColors");
  assert.equal(broadcastFieldOfMessage(messageOn("state:theme")), "theme");
  assert.equal(broadcastFieldOfMessage(messageOn("state:locale")), "locale");
  assert.equal(broadcastFieldOfMessage(messageOn("state:interfaceMode")), "interfaceMode");
  assert.equal(broadcastFieldOfMessage(messageOn("state:uiFontSizePx")), "uiFontSizePx");
  assert.equal(broadcastFieldOfMessage(messageOn("state:pointerCursors")), "pointerCursors");

  assert.equal(broadcastFieldOfMessage(messageOn("other:theme")), null);
  assert.equal(broadcastFieldOfMessage(messageOn("stateful:theme")), null);
  assert.equal(broadcastFieldOfMessage(messageOn("state")), null);
  assert.equal(broadcastFieldOfMessage(messageOn("state:")), null);
  assert.equal(broadcastFieldOfMessage(messageOn("state:bogus")), null);
  assert.equal(broadcastFieldOfMessage(messageOn("state:theme:light")), null);
});

test("applyBroadcastField routes every broadcastable field to exactly its own setter", () => {
  const { calls, setters } = createRecorder();
  applyBroadcastField(setters, "theme", "dark");
  applyBroadcastField(setters, "locale", "zh-CN");
  applyBroadcastField(setters, "interfaceMode", "office");
  applyBroadcastField(setters, "uiFontSizePx", 15);
  applyBroadcastField(setters, "uiColors", { accent: "#8b5cf6" });
  applyBroadcastField(setters, "pointerCursors", true);

  assert.deepEqual(calls.setTheme, ["dark"]);
  assert.deepEqual(calls.setLocale, ["zh-CN"]);
  assert.deepEqual(calls.setInterfaceMode, ["office"]);
  assert.deepEqual(calls.setUiFontSizePx, [15]);
  assert.deepEqual(calls.setUiColors, [{ accent: "#8b5cf6" }]);
  assert.equal(calls.setPointerCursors.length, 1);
  assert.deepEqual(activeSetters(calls), [...SETTER_NAMES]);
  assert.equal(totalCalls(calls), 6);
});

test("every field in the outbound registry has an inbound channel and a setter", () => {
  const canonicalPayload: Record<BroadcastField, unknown> = {
    theme: "light",
    locale: "en-US",
    uiFontSizePx: 14,
    uiColors: { background: "#ffffff" },
    pointerCursors: true,
    interfaceMode: "coding",
  };
  const targetSetter: Record<BroadcastField, keyof BroadcastFieldSetters> = {
    theme: "setTheme",
    locale: "setLocale",
    uiFontSizePx: "setUiFontSizePx",
    uiColors: "setUiColors",
    pointerCursors: "setPointerCursors",
    interfaceMode: "setInterfaceMode",
  };
  assert.equal(
    BROADCAST_STATE_FIELDS.length,
    Object.keys(targetSetter).length,
    "a newly broadcast field needs an inbound branch and an expectation here",
  );

  for (const field of BROADCAST_STATE_FIELDS) {
    const { calls, setters } = createRecorder();
    assert.equal(broadcastFieldOfMessage(messageOn(`state:${field}`)), field);
    applyBroadcastField(setters, field, canonicalPayload[field]);
    assert.deepEqual(activeSetters(calls), [targetSetter[field]], `${field} must be handled`);
    assert.equal(totalCalls(calls), 1, `${field} must be handled exactly once`);
  }
});

test("applyBroadcastField drops theme/locale/uiFontSizePx payloads of the wrong type", () => {
  const { calls, setters } = createRecorder();
  for (const payload of [null, undefined, 42, true, {}, ["dark"], Symbol("dark")]) {
    applyBroadcastField(setters, "theme", payload);
    applyBroadcastField(setters, "locale", payload);
  }
  for (const payload of ["15", null, undefined, true, {}, [15]]) {
    applyBroadcastField(setters, "uiFontSizePx", payload);
  }

  assert.deepEqual(calls.setTheme, []);
  assert.deepEqual(calls.setLocale, []);
  assert.deepEqual(calls.setUiFontSizePx, []);
  assert.deepEqual(activeSetters(calls), []);
});

test("applyBroadcastField only accepts the two canonical interface modes", () => {
  const accepted = createRecorder();
  applyBroadcastField(accepted.setters, "interfaceMode", "coding");
  applyBroadcastField(accepted.setters, "interfaceMode", "office");
  assert.deepEqual(accepted.calls.setInterfaceMode, ["coding", "office"]);

  const rejected = createRecorder();
  for (const payload of [
    "Office",
    "CODING",
    "default",
    "",
    null,
    undefined,
    0,
    true,
    { mode: "office" },
  ]) {
    applyBroadcastField(rejected.setters, "interfaceMode", payload);
  }
  assert.deepEqual(rejected.calls.setInterfaceMode, []);
  assert.equal(totalCalls(rejected.calls), 0);
});

test("applyBroadcastField turns nullish uiColors payloads into an empty palette", () => {
  const palette = { background: "#0f172a", accent: "#14b8a6" };
  const { calls, setters } = createRecorder();
  applyBroadcastField(setters, "uiColors", palette);
  applyBroadcastField(setters, "uiColors", null);
  applyBroadcastField(setters, "uiColors", undefined);

  assert.deepEqual(calls.setUiColors, [palette, {}, {}]);
  assert.equal(totalCalls(calls), 3);
});

test("applyBroadcastField forwards a zero font size instead of treating it as absent", () => {
  const { calls, setters } = createRecorder();
  applyBroadcastField(setters, "uiFontSizePx", 0);

  assert.deepEqual(calls.setUiFontSizePx, [0]);
  assert.equal(totalCalls(calls), 1);
});

test("applyBroadcastField normalizes pointerCursors payloads for every inbound shape", () => {
  const payloads = [
    true,
    false,
    0,
    1,
    "pointer",
    "default",
    "system",
    { enabled: true },
    { enabled: false },
    null,
    undefined,
    42,
  ];
  const normalized: unknown[] = [];
  for (const payload of payloads) {
    const { calls, setters } = createRecorder();
    applyBroadcastField(setters, "pointerCursors", payload);
    assert.equal(calls.setPointerCursors.length, 1, `${String(payload)} must reach the setter`);
    assert.equal(totalCalls(calls), 1, `${String(payload)} must not touch another setter`);
    normalized.push(calls.setPointerCursors[0]);
  }

  // 入站负载必须真的参与归一化：所有负载塌缩成同一个值，要么分发把负载丢了，
  // 要么该状态的规范形态不在上面的样本里（归一化规则见 lib/pointerCursors）。
  const signatures = normalized.map((value) => JSON.stringify(value) ?? String(value));
  assert.ok(
    signatures.some((signature) => signature !== signatures[0]),
    `pointerCursors normalization collapsed every payload into ${signatures[0]}: no sample matched the canonical shape, or inbound payloads are dropped`,
  );

  // 归一化是纯函数：同一负载重复应用不会漂移。
  const repeated = createRecorder();
  applyBroadcastField(repeated.setters, "pointerCursors", "pointer");
  applyBroadcastField(repeated.setters, "pointerCursors", "pointer");
  assert.deepEqual(repeated.calls.setPointerCursors[0], repeated.calls.setPointerCursors[1]);
});
