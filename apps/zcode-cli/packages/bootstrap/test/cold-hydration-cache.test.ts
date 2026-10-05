import assert from "node:assert/strict";
import test from "node:test";
import {
  coldHydrationCacheable,
  coldHydrationCheckpointDigest,
  coldHydrationFingerprint,
  readColdHydrationCache,
  writeColdHydrationCache,
} from "../src/zcode-protocol-v4/cold-hydration-cache.js";

const base = {
  contextWindow: 200_000,
  goalVerificationEntries: [],
  revert: null,
  sessionId: "sess-a",
  sharedContextEntry: null,
  targetUpdatedAt: undefined,
  title: "Titled",
  transcriptScope: "tail-500" as const,
  transcriptWatermark: 1_790_000_000_000,
  workspaceCheckpoints: [] as readonly string[],
};

interface Entry {
  events: number[];
  synthesized: boolean;
  usageSeed: null;
}

const payload: Entry = { events: [1, 2, 3], synthesized: true, usageSeed: null };

test("only a cold open with no live events may use the cache", () => {
  assert.equal(coldHydrationCacheable(0), true);
  assert.equal(coldHydrationCacheable(1), false, "one live event already breaks purity");
  assert.equal(coldHydrationCacheable(5268), false);
});

test("round-trips a payload under a matching fingerprint", () => {
  const fp = coldHydrationFingerprint({ ...base, sessionId: "sess-roundtrip" });
  writeColdHydrationCache("sess-roundtrip", fp, payload);
  assert.deepEqual(readColdHydrationCache<Entry>("sess-roundtrip", fp), payload);
});

test("a moved transcript watermark invalidates instead of returning stale rows", () => {
  const sid = "sess-watermark";
  const fp = coldHydrationFingerprint({ ...base, sessionId: sid });
  writeColdHydrationCache(sid, fp, payload);
  const moved = coldHydrationFingerprint({ ...base, sessionId: sid, transcriptWatermark: base.transcriptWatermark + 1 });
  assert.equal(readColdHydrationCache<Entry>(sid, moved), null);
});

test("every fingerprint input is load-bearing", () => {
  const sid = "sess-inputs";
  const fp = coldHydrationFingerprint({ ...base, sessionId: sid });
  writeColdHydrationCache(sid, fp, payload);
  const variants: Record<string, unknown> = {
    contextWindow: 128_000,
    goalVerificationEntries: [{ verificationId: "v1" }],
    revert: { targetMessageID: "msg-1" },
    sharedContextEntry: { contextId: "ctx-1", status: "discarded" },
    targetUpdatedAt: 1_790_000_000_999,
    title: "Renamed",
    // 尾读与全量读在同一水位下合成出不同的行，所以范围必须参与键。
    transcriptScope: "full",
    transcriptWatermark: base.transcriptWatermark + 1,
    // checkpoint 经 file-change 摘要进载荷，而它的持久来源是不推进水位的 session entry。
    workspaceCheckpoints: ["7|cp-1|workspace|zcode-artifact://snap-1|m1"],
  };
  for (const [field, value] of Object.entries(variants)) {
    const changed = coldHydrationFingerprint({ ...base, sessionId: sid, [field]: value } as typeof base);
    assert.notEqual(changed, fp, `${field} must participate in the fingerprint`);
    assert.equal(
      readColdHydrationCache<Entry>(sid, changed),
      null,
      `${field} changed but the cache still hit`,
    );
  }
});

test("fingerprint is stable and order-insensitive to object key order", () => {
  const a = coldHydrationFingerprint(base);
  const b = coldHydrationFingerprint({
    transcriptWatermark: base.transcriptWatermark,
    title: base.title,
    targetUpdatedAt: base.targetUpdatedAt,
    sessionId: base.sessionId,
    revert: base.revert,
    goalVerificationEntries: base.goalVerificationEntries,
    contextWindow: base.contextWindow,
    transcriptScope: base.transcriptScope,
    workspaceCheckpoints: base.workspaceCheckpoints,
  });
  assert.equal(a, b);
});

test("sessions are keyed separately", () => {
  const fpA = coldHydrationFingerprint({ ...base, sessionId: "sess-x" });
  const fpB = coldHydrationFingerprint({ ...base, sessionId: "sess-y" });
  writeColdHydrationCache("sess-x", fpA, { ...payload, events: [1] });
  writeColdHydrationCache("sess-y", fpB, { ...payload, events: [2] });
  assert.deepEqual(readColdHydrationCache<Entry>("sess-x", fpA)?.events, [1]);
  assert.deepEqual(readColdHydrationCache<Entry>("sess-y", fpB)?.events, [2]);
});

test("rewriting the same session replaces rather than duplicates", () => {
  const sid = "sess-rewrite";
  const fp = coldHydrationFingerprint({ ...base, sessionId: sid });
  writeColdHydrationCache(sid, fp, { ...payload, events: [1] });
  writeColdHydrationCache(sid, fp, { ...payload, events: [9, 9] });
  assert.deepEqual(readColdHydrationCache<Entry>(sid, fp)?.events, [9, 9]);
});

test("evicts past the cap, oldest first", () => {
  const fingerprints: string[] = [];
  // 16 is the cap; write 18 distinct sessions.
  for (let i = 0; i < 18; i += 1) {
    const sid = `sess-evict-${i}`;
    const fp = coldHydrationFingerprint({ ...base, sessionId: sid });
    fingerprints.push(fp);
    writeColdHydrationCache(sid, fp, { ...payload, events: [i] });
  }
  assert.equal(readColdHydrationCache<Entry>("sess-evict-0", fingerprints[0]!), null, "oldest evicted");
  assert.equal(readColdHydrationCache<Entry>("sess-evict-1", fingerprints[1]!), null, "second oldest evicted");
  assert.deepEqual(readColdHydrationCache<Entry>("sess-evict-17", fingerprints[17]!)?.events, [17]);
});

test("reading an unknown session misses rather than throwing", () => {
  assert.equal(readColdHydrationCache<Entry>("sess-never-written", "fp"), null);
});

test("checkpoint digest pins the set buildColdFileChangeSummaries consumes, and nothing else", () => {
  const event = (
    sequenceNumber: number,
    payload: Record<string, unknown>,
    type: string = "checkpoint_created",
  ) =>
    ({
      payload,
      sequenceNumber,
      type,
    }) as unknown as Parameters<typeof coldHydrationCheckpointDigest>[0][number];
  const checkpoint = {
    checkpointId: "cp-1",
    messageId: "m1",
    scope: "workspace",
    snapshotRef: "zcode-artifact://snap-1",
    targetMessageId: "m0",
  };

  // 非 checkpoint 事件不进 digest（它们要么本来就在白名单外整条绕过，要么不进载荷）。
  assert.deepEqual(coldHydrationCheckpointDigest([event(1, {}, "session_resumed")]), []);
  // 分组键取 targetMessageId ?? messageId；摘要内容 = 消费面那四项 + seq。
  assert.deepEqual(coldHydrationCheckpointDigest([event(7, checkpoint)]), [
    "7|cp-1|workspace|zcode-artifact://snap-1|m0",
  ]);
  assert.deepEqual(
    coldHydrationCheckpointDigest([event(7, { ...checkpoint, targetMessageId: undefined })]),
    ["7|cp-1|workspace|zcode-artifact://snap-1|m1"],
  );
  // 只依赖集合：restore 的重放顺序由 (sequenceNumber, time.created) 唯一决定，
  // 所以两次冷开的输入顺序不同也必须产出同一个键，否则缓存永远命中不了。
  const second = { ...checkpoint, checkpointId: "cp-2", sequenceNumber: undefined, snapshotRef: "s2" };
  const forward = coldHydrationCheckpointDigest([event(7, checkpoint), event(9, second)]);
  const backward = coldHydrationCheckpointDigest([event(9, second), event(7, checkpoint)]);
  assert.deepEqual(forward, backward);
  assert.equal(forward.length, 2);
  // 多一条 checkpoint（真实写入）就是另一个键：这是白名单放行它的前提。
  assert.notDeepEqual(forward, coldHydrationCheckpointDigest([event(7, checkpoint)]));
  // 畸形载荷不抛：最多让这次不缓存，不能打断 hydration（join 把 null 收成空段）。
  assert.deepEqual(coldHydrationCheckpointDigest([event(3, null)]), ["3||||"]);
});
