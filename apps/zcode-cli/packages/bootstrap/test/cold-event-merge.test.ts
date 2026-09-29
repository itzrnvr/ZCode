import assert from "node:assert/strict";
import test from "node:test";
import { loadPersistedConversationMaterialization } from "../src/zcode-protocol-v4/cold-event-merge.js";
import type { MessageWithParts, SessionEntryInfo, SessionGoal } from "@zcode/contracts";

type AnyId = MessageWithParts["info"]["id"];

const id = (value: string) => value as unknown as AnyId;

interface FixtureMessage {
  messageId: string;
  role?: "user" | "assistant";
  source?: string;
  semantics?: { origin?: string; kind?: string };
  partCount?: number;
}

function sessionEntry(data: unknown): SessionEntryInfo {
  return {
    id: "entry-1",
    sessionID: "sess-1" as unknown as SessionEntryInfo["sessionID"],
    type: "test/entry",
    time: { created: 1, updated: 1 },
    data,
  } as SessionEntryInfo;
}

function message(fixture: FixtureMessage): MessageWithParts {
  return {
    info: {
      id: id(fixture.messageId),
      role: fixture.role ?? "user",
      time: { created: 1_700_000_000_000 },
      ...(fixture.source ? { source: fixture.source } : {}),
      ...(fixture.semantics ? { semantics: fixture.semantics } : {}),
    },
    parts: Array.from({ length: fixture.partCount ?? 1 }, (_, index) => ({
      id: id(`${fixture.messageId}-part-${index}`),
      type: "text",
      text: `${fixture.messageId}:${index}`,
    })),
  } as unknown as MessageWithParts;
}

interface StoreCalls {
  messages: number;
  messagesTail: number;
  getSession: number;
  readTarget: number;
  sessionEntries: number;
}

function createStore(options: {
  all: MessageWithParts[];
  revert?: Record<string, unknown>;
  title?: string;
  target?: SessionGoal | null;
  entries?: SessionEntryInfo[];
  withMessagesTail?: boolean;
}) {
  const calls: StoreCalls = {
    messages: 0,
    messagesTail: 0,
    getSession: 0,
    readTarget: 0,
    sessionEntries: 0,
  };
  const store = {
    async getSession() {
      calls.getSession += 1;
      return {
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.revert ? { revert: options.revert } : {}),
      };
    },
    async messages() {
      calls.messages += 1;
      return options.all;
    },
    async readTarget() {
      calls.readTarget += 1;
      return options.target ?? null;
    },
    async sessionEntries() {
      calls.sessionEntries += 1;
      return options.entries ?? [];
    },
    ...(options.withMessagesTail
      ? {
          async messagesTail(input: { limit: number }) {
            calls.messagesTail += 1;
            // mimic the real repository: limit counts PARTS taken by raw part id DESC,
            // i.e. branch-blind.
            const flattened: Array<{ message: MessageWithParts; partIndex: number }> = [];
            for (const entry of options.all) {
              entry.parts.forEach((_part, partIndex) => flattened.push({ message: entry, partIndex }));
            }
            const tailParts = flattened.slice(-input.limit);
            const byMessage = new Map<string, MessageWithParts>();
            for (const item of tailParts) {
              const key = String(item.message.info.id);
              if (!byMessage.has(key)) byMessage.set(key, item.message);
            }
            return [...byMessage.values()];
          },
        }
      : {}),
  };
  return { calls, store };
}

test("caller-supplied tail read is reused and the full transcript read is skipped", async () => {
  const all = [message({ messageId: "m1" }), message({ messageId: "m2" }), message({ messageId: "m3" })];
  const { calls, store } = createStore({ all });
  const tail = all.slice(-2);

  const result = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    persistedMessages: tail,
    sessionId: "sess-1",
    store,
  });

  assert.equal(calls.messages, 0, "must not re-read the whole transcript when resume supplied a tail");
  assert.deepEqual(
    result.messages.map((entry) => String(entry.info.id)),
    ["m2", "m3"],
  );
});

test("an empty caller tail falls back to a store read instead of rendering an empty session", async () => {
  const all = [message({ messageId: "m1" }), message({ messageId: "m2" })];
  const { calls, store } = createStore({ all });

  const result = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    persistedMessages: [],
    sessionId: "sess-1",
    store,
  });

  assert.equal(calls.messages, 1, "empty array means 'no usable tail', not 'no history'");
  assert.equal(result.messages.length, 2);
});

test("revert/fork sessions are reduced to the active branch", async () => {
  // append-only store: the abandoned branch stays on disk after a rewind. The cut cursor
  // points at the tail of the pre-rewind transcript, so everything after it is the new
  // branch and `keptMessageIDs` is the prefix that survived the rewind.
  const all = [
    message({ messageId: "m1" }),
    message({ messageId: "m2-abandoned" }),
    message({ messageId: "m3-abandoned" }),
    message({ messageId: "m2-kept" }),
    message({ messageId: "m4-new-branch" }),
  ];
  const { store } = createStore({
    all,
    revert: {
      targetMessageID: id("m3-abandoned"),
      keptMessageIDs: [id("m1")],
      branchCutAfterMessageID: id("m3-abandoned"),
    },
  });

  const result = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: "sess-fork",
    store,
  });

  assert.deepEqual(
    result.messages.map((entry) => String(entry.info.id)),
    ["m1", "m2-kept", "m4-new-branch"],
    "abandoned-branch messages must not reach the projection",
  );
});

/**
 * Regression guard for the documented failure mode: a branch-blind part tail (last N parts
 * by raw part id) can drop the kept prefix of a rewound session, so branch selection then
 * yields a fragment - measured in production as a 2 703-part fork collapsing to 6 messages
 * and rendering an empty conversation. The full read must not degrade that way.
 */
test("a branch-blind part tail loses the kept prefix of a rewound session, the full read does not", async () => {
  // 60 pre-rewind messages x 10 parts = 600 parts, so a 500-part tail excludes p0..p9.
  const preRewind: MessageWithParts[] = Array.from({ length: 60 }, (_, index) =>
    message({ messageId: `p${index}`, partCount: 10 }),
  );
  const afterRewind = message({ messageId: "n1", partCount: 1 });
  const all = [...preRewind, afterRewind];
  const revert = {
    targetMessageID: id("p59"),
    keptMessageIDs: [id("p0")],
    branchCutAfterMessageID: id("p59"),
  };

  const tailStore = createStore({ all, revert, withMessagesTail: true });
  const tailResult = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: "sess-fork-tail",
    store: tailStore.store,
  });
  assert.equal(tailStore.calls.messagesTail, 1);

  const fullStore = createStore({ all, revert });
  const fullResult = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: "sess-fork-full",
    store: fullStore.store,
  });

  assert.deepEqual(
    fullResult.messages.map((entry) => String(entry.info.id)),
    ["p0", "n1"],
    "the full read keeps the survived prefix plus the new branch",
  );
  assert.deepEqual(
    tailResult.messages.map((entry) => String(entry.info.id)),
    ["n1"],
    "the branch-blind tail drops p0 because its parts are outside the last 500",
  );
});

test("target, session entries and memory events are passed through", async () => {
  const target = { id: "goal-1", status: "active" } as unknown as SessionGoal;
  const { calls, store } = createStore({
    all: [message({ messageId: "m1" })],
    target,
    entries: [sessionEntry({ kind: "unrelated" })],
  });

  const result = await loadPersistedConversationMaterialization({
    memoryEvents: [{ id: "evt-1" } as never],
    sessionId: "sess-1",
    store,
  });

  assert.equal(result.target, target);
  assert.equal(calls.readTarget, 1);
  assert.equal(calls.sessionEntries, 1);
  assert.deepEqual(result.goalVerificationEntries, [], "unrelated entries produce no verifications");
  assert.equal(result.memoryEvents.length, 1);
});

test("shared_context imports are surfaced only from a matching import message plus a title", async () => {
  const withImport = createStore({
    all: [
      message({
        messageId: "m1",
        role: "user",
        source: "shared_context",
        semantics: { origin: "import", kind: "shared_context" },
      }),
    ],
    title: "  Handover  ",
  });
  const imported = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: "sess-share",
    store: withImport.store,
  });
  assert.deepEqual(imported.sharedContextImport, { title: "Handover" });

  const untitled = createStore({
    all: [
      message({
        messageId: "m1",
        role: "user",
        source: "shared_context",
        semantics: { origin: "import", kind: "shared_context" },
      }),
    ],
    title: "   ",
  });
  const blank = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: "sess-share-blank",
    store: untitled.store,
  });
  assert.equal(blank.sharedContextImport, undefined, "a blank title is not a share import");
});

test("without a store the result is empty rather than a fabricated 'no history'", async () => {
  const result = await loadPersistedConversationMaterialization({
    memoryEvents: [{ id: "evt-1" } as never],
    sessionId: "sess-1",
  });
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.goalVerificationEntries, []);
  assert.equal(result.memoryEvents.length, 1);
  assert.equal(result.target, undefined);
});
