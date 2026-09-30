import assert from "node:assert/strict";
import test from "node:test";
import {
  coldHydrationCacheable,
  coldHydrationFingerprint,
  readColdHydrationCache,
  writeColdHydrationCache,
} from "../src/zcode-protocol-v4/cold-hydration-cache.js";

const base = {
  contextWindow: 200_000,
  goalVerificationEntries: [],
  revert: null,
  sessionId: "sess-a",
  targetUpdatedAt: undefined,
  title: "Titled",
  transcriptWatermark: 1_790_000_000_000,
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
    targetUpdatedAt: 1_790_000_000_999,
    title: "Renamed",
    transcriptWatermark: base.transcriptWatermark + 1,
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
