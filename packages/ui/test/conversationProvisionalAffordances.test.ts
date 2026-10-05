import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVISIONAL_SUPPRESSED_ROW_AFFORDANCES,
  resolveEditRewindExplanationMessageId,
  resolveEditWorkspaceRewindAvailability,
} from "../src/v4/conversationProvisionalAffordances.js";

type FileChanges = {
  additions: number;
  deletions: number;
  files: number;
  state?: "active" | "reverted";
};

function resolve(
  overrides: Partial<{
    provisional: boolean;
    fileChanges: FileChanges | undefined;
    isRunning: boolean;
    canRewindFiles: boolean | undefined;
  }> = {},
): { enabled: boolean; reason: string } {
  return resolveEditWorkspaceRewindAvailability({
    provisional: false,
    fileChanges: undefined,
    isRunning: false,
    canRewindFiles: undefined,
    ...overrides,
  });
}

test("快绘窗口里 fileChanges 缺席是「还不知道」，不是「没有改动」", () => {
  // 这是整条降级里唯一会说假话的地方：noFiles 会被 ConversationRowView 插进 i18n id
  // 生成一句「没有可撤销的文件改动」，而这一轮可能确实改过文件——fileChanges 要
  // buildColdFileChangeSummaries，它依赖 activation 才有的内存事件与 record。
  assert.deepEqual(resolve({ provisional: true, fileChanges: undefined }), {
    enabled: false,
    reason: "pending",
  });
});

test("非快绘时 fileChanges 缺席仍然是 noFiles（今天的判定顺序一字不改）", () => {
  assert.deepEqual(resolve({ fileChanges: undefined }), { enabled: false, reason: "noFiles" });
  assert.deepEqual(resolve({ fileChanges: { additions: 0, deletions: 0, files: 0 } }), {
    enabled: false,
    reason: "noFiles",
  });
});

test("快绘标记不会把已有的 fileChanges 判成 pending", () => {
  // 反方向也不能说谎：数据在场就按在场判，provisional 只补「缺席」这一种情况。
  assert.deepEqual(
    resolve({
      provisional: true,
      fileChanges: { additions: 3, deletions: 1, files: 2 },
      canRewindFiles: true,
    }),
    { enabled: true, reason: "available" },
  );
});

test("判定优先级保持原样：reverted 先于 running，running 先于 canRewindFiles", () => {
  const reverted: FileChanges = { additions: 1, deletions: 0, files: 1, state: "reverted" };
  const active: FileChanges = { additions: 1, deletions: 0, files: 1, state: "active" };
  assert.deepEqual(resolve({ fileChanges: reverted, isRunning: true, canRewindFiles: true }), {
    enabled: false,
    reason: "reverted",
  });
  assert.deepEqual(resolve({ fileChanges: active, isRunning: true, canRewindFiles: true }), {
    enabled: false,
    reason: "running",
  });
  assert.deepEqual(resolve({ fileChanges: active, canRewindFiles: false }), {
    enabled: false,
    reason: "unavailable",
  });
  assert.deepEqual(resolve({ fileChanges: active, canRewindFiles: undefined }), {
    enabled: false,
    reason: "unavailable",
  });
  assert.deepEqual(resolve({ fileChanges: active, canRewindFiles: true }), {
    enabled: true,
    reason: "available",
  });
});

test("解释文案 id：available 与 pending 都不生成句子，缺席回落 noFiles", () => {
  // 收口成一个函数是为了防止以后往 reason 闭集加值时悄悄拼出不存在的 message id。
  assert.equal(resolveEditRewindExplanationMessageId("available"), null);
  assert.equal(resolveEditRewindExplanationMessageId("pending"), null);
  assert.equal(
    resolveEditRewindExplanationMessageId(undefined),
    "chat.edit.resetConversationAndFiles.noFiles",
  );
  for (const reason of ["noFiles", "reverted", "running", "unavailable"] as const) {
    assert.equal(
      resolveEditRewindExplanationMessageId(reason),
      `chat.edit.resetConversationAndFiles.${reason}`,
    );
  }
});

test("快绘期必须静默的行级能力清单是这六项，一项不多一项不少", () => {
  // 这份清单是检查点：SessionPane 在对应 props 上逐个落地 provisional ? undefined : handler。
  // fetchFileChanges / previewFileRewind / applyFileRewind 需要 baseRevision + baseLogEpoch，
  // 快绘行没有水位；onFork / onRetry / onEdit 的命令目标带 rowId，而快绘 rowId 是投影计数器，
  // 跑过 hook 的会话会与权威 rowId 错位（服务端只会干净地回 proto.staleTarget）。
  // 两个 rewind 相关项在 onEdit 降级后已传递性不可达，仍然显式列出：显式列举胜过依赖传递性，
  // 将来有人给撤销加第二个入口时这道门不会自动失效。
  assert.deepEqual([...PROVISIONAL_SUPPRESSED_ROW_AFFORDANCES], [
    "fetchFileChanges",
    "previewFileRewind",
    "applyFileRewind",
    "onFork",
    "onRetry",
    "onEdit",
  ]);
});
