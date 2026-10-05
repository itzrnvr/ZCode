import assert from "node:assert/strict";
import test from "node:test";
import { scheduleSessionDatabaseBackups } from "../src/storage/session-store/database-backups.js";
import type {
  CreateSnapshotOptions,
  SessionDatabaseBackupTimer,
  SnapshotResult,
} from "../src/storage/session-store/database-backups.js";
import type { LogContext, Logger } from "@zcode/contracts";

/**
 * 备份调度器的时序回归。
 *
 * 用**手搓的定时器队列**而不是假定时器库（仓库里没有 sinon/vitest fake timers，也不该为此
 * 引一个依赖），形状照 `adapters/src/logging/retention.ts` 的可注入 setTimeout 约定。
 * 被测的是三件真会坏的事：
 *  1. 启动那一次必须传 minAgeMs=0——否则 "启动后备份一次" 会被节奏闸门挡掉，
 *     用户崩溃前最近的一份可能是几小时前的；
 *  2. 自重排而不是 setInterval：一轮快照再慢也不会和自己重叠；
 *  3. 任何异常都只记日志并继续排下一轮，`cancel()` 之后彻底停。
 * 还有 `unref()`：备份定时器绝不能把一个本该退出的 CLI 进程吊住。
 */

interface FakeTimer extends SessionDatabaseBackupTimer {
  id: number;
  fireAt: number;
  callback: () => void;
  cleared: boolean;
  unrefCalls: number;
}

interface FakeTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): SessionDatabaseBackupTimer;
  clearTimeout(timer: SessionDatabaseBackupTimer): void;
  /** 把时间推到 +ms，期间到点的定时器按顺序触发（含触发过程中新排的）。 */
  advance(ms: number): Promise<void>;
  pending(): number;
  unrefCalls(): number;
}

function makeTimers(): FakeTimers {
  const queue: FakeTimer[] = [];
  let current = 1_800_000_000_000;
  let nextId = 1;

  const settle = async (): Promise<void> => {
    // 调度器的定时器回调是 `void run(...)`：触发之后要把那一轮的微任务/宏任务放完，
    // 否则 "自重排" 还没发生，断言就会看到假的空队列。
    for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  return {
    now: () => current,
    setTimeout(callback: () => void, delayMs: number): SessionDatabaseBackupTimer {
      const timer: FakeTimer = {
        id: nextId++,
        fireAt: current + delayMs,
        callback,
        cleared: false,
        unrefCalls: 0,
        unref(): void {
          this.unrefCalls += 1;
        },
      };
      queue.push(timer);
      return timer;
    },
    clearTimeout(timer: SessionDatabaseBackupTimer): void {
      const target = timer as FakeTimer;
      target.cleared = true;
    },
    async advance(ms: number): Promise<void> {
      const limit = current + ms;
      for (;;) {
        const due = queue
          .filter((timer) => !timer.cleared && timer.fireAt <= limit)
          .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id)[0];
        if (!due) break;
        due.cleared = true;
        current = due.fireAt;
        due.callback();
        await settle();
      }
      current = limit;
      await settle();
    },
    pending: () => queue.filter((timer) => !timer.cleared).length,
    unrefCalls: () => queue.reduce((total, timer) => total + timer.unrefCalls, 0),
  };
}

function created(file: string): SnapshotResult {
  return {
    status: "created",
    file,
    path: `/backups/${file}`,
    bytes: 1_000,
    createdAt: 0,
    removed: [],
    freedOldest: null,
  };
}

interface Recorder {
  calls: CreateSnapshotOptions[];
  minAges: (number | undefined)[];
  snapshot(options: CreateSnapshotOptions): Promise<SnapshotResult>;
}

function makeRecorder(results?: SnapshotResult[]): Recorder {
  const calls: CreateSnapshotOptions[] = [];
  const queue = results ? [...results] : [];
  return {
    calls,
    get minAges() {
      return calls.map((call) => call.minAgeMs);
    },
    async snapshot(options: CreateSnapshotOptions): Promise<SnapshotResult> {
      calls.push(options);
      return queue.shift() ?? created(`db-${calls.length}.sqlite`);
    },
  };
}

interface RecorderLog {
  level: string;
  message: string;
  context: Record<string, unknown>;
}

function makeLogger(): { logger: Logger; entries: RecorderLog[] } {
  const entries: RecorderLog[] = [];
  const record =
    (level: string) =>
    (message: string, context?: LogContext): void => {
      entries.push({ level, message, context: context ?? {} });
    };
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error(message: string, error?: Error, context?: LogContext): void {
      entries.push({ level: "error", message, context: { ...context, error: error?.message } });
    },
    child(): Logger {
      return logger;
    },
  };
  return { logger, entries };
}

test("the startup round always runs and periodic rounds carry the cadence guard", async () => {
  const timers = makeTimers();
  const recorder = makeRecorder();

  const handle = scheduleSessionDatabaseBackups({
    dbPath: "/db.sqlite",
    backupsDir: "/backups",
    intervalMs: 30 * 60_000,
    startupDelayMs: 60_000,
    generations: 3,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    snapshot: recorder.snapshot,
  });

  assert.equal(recorder.calls.length, 0, "nothing may run before the startup delay");
  await timers.advance(59_999);
  assert.equal(recorder.calls.length, 0);

  await timers.advance(1);
  assert.equal(recorder.calls.length, 1, "one snapshot at startupDelayMs");
  assert.equal(recorder.calls[0]?.minAgeMs, 0, "the startup round must bypass the cadence guard");
  assert.equal(recorder.calls[0]?.generations, 3);
  assert.equal(recorder.calls[0]?.dbPath, "/db.sqlite");

  await timers.advance(30 * 60_000);
  assert.equal(recorder.calls.length, 2, "one snapshot per intervalMs");
  assert.equal(
    recorder.calls[1]?.minAgeMs,
    30 * 60_000,
    "periodic rounds must pass the interval as the cadence guard",
  );

  await timers.advance(3 * 30 * 60_000);
  assert.equal(recorder.calls.length, 5);
  assert.equal(timers.pending(), 1, "self-rescheduling keeps exactly one timer armed");

  handle.cancel();
  assert.equal(timers.pending(), 0, "cancel must clear the armed timer");
  await timers.advance(10 * 30 * 60_000);
  assert.equal(recorder.calls.length, 5, "nothing runs after cancel");
});

test("a slow snapshot can never overlap itself", async () => {
  const timers = makeTimers();
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const handle = scheduleSessionDatabaseBackups({
    dbPath: "/db.sqlite",
    backupsDir: "/backups",
    intervalMs: 1_000,
    startupDelayMs: 0,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    snapshot: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return created("db-slow.sqlite");
    },
  });

  await timers.advance(1_000);
  assert.equal(inFlight, 1, "the first round is still running");
  assert.equal(timers.pending(), 0, "no second round may be armed while one is in flight");
  await timers.advance(10_000);
  assert.equal(inFlight, 1);
  assert.equal(maxInFlight, 1, "setInterval semantics would have stacked rounds here");

  releaseFirst?.();
  await timers.advance(0);
  assert.equal(timers.pending(), 1, "the next round is armed only after the previous one finished");
  handle.cancel();
});

test("a throwing snapshot round is logged and rescheduled instead of killing the timer", async () => {
  const timers = makeTimers();
  const { logger, entries } = makeLogger();
  const calls: string[] = [];

  const handle = scheduleSessionDatabaseBackups({
    dbPath: "/db.sqlite",
    backupsDir: "/backups",
    intervalMs: 1_000,
    startupDelayMs: 0,
    logger,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    snapshot: async () => {
      calls.push("round");
      throw new Error("boom");
    },
  });

  await timers.advance(3_000);
  assert.ok(calls.length >= 3, `the timer must survive the throw, got ${calls.length} rounds`);
  const warnings = entries.filter((entry) => entry.level === "warn");
  assert.ok(warnings.length >= 3, "every failed round is warned about");
  assert.equal(warnings[0]?.context.event, "session_store.backup.failed");
  assert.equal(warnings[0]?.context.message, "boom");
  assert.equal(timers.pending(), 1);
  handle.cancel();
});

test("skipped rounds are logged at the level their reason deserves", async () => {
  const timers = makeTimers();
  const { logger, entries } = makeLogger();
  const results: SnapshotResult[] = [
    { status: "skipped", reason: "unchanged", file: "db-1.sqlite" },
    { status: "skipped", reason: "recent", file: "db-1.sqlite", ageMs: 10, minAgeMs: 1_000 },
    { status: "skipped", reason: "in_flight" },
    { status: "skipped", reason: "low_space", message: "insufficient free space: 1 < 2" },
  ];

  const handle = scheduleSessionDatabaseBackups({
    dbPath: "/db.sqlite",
    backupsDir: "/backups",
    intervalMs: 1_000,
    startupDelayMs: 0,
    logger,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    snapshot: async () => results.shift() ?? created("db-x.sqlite"),
  });

  await timers.advance(4_000);
  handle.cancel();

  const skipped = entries.filter(
    (entry) => entry.context.event === "session_store.backup.skipped",
  );
  assert.equal(skipped.length, 4);
  // unchanged / recent / in_flight 是空闲应用的常态，刷 warn 会把日志淹掉；
  // low_space 是真需要用户知道的。
  assert.deepEqual(
    skipped.map((entry) => `${entry.level}:${String(entry.context.reason)}`),
    ["debug:unchanged", "debug:recent", "debug:in_flight", "warn:low_space"],
  );
});

test("the backup timer is unref'd so it can never hold the process open", async () => {
  const timers = makeTimers();
  const handle = scheduleSessionDatabaseBackups({
    dbPath: "/db.sqlite",
    backupsDir: "/backups",
    intervalMs: 1_000,
    startupDelayMs: 0,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    snapshot: async () => created("db-x.sqlite"),
  });

  assert.equal(timers.unrefCalls(), 1, "the startup timer must be unref'd");
  await timers.advance(2_000);
  assert.ok(timers.unrefCalls() >= 3, "every re-armed timer must be unref'd too");
  handle.cancel();
});
