import assert from "node:assert/strict";
import test from "node:test";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import { createZCodeAgentConnectionScope } from "../src/zcode-agent/zcodeAgentConnectionScope.js";

const ROWS_PARAMS = {
  workspacePath: "D:/workspace",
  sessionId: "sess_probe",
} as const;

function makeBase(capture: { params: Record<string, unknown> | null }) {
  return {
    async conversationRowsV4(params: Record<string, unknown>) {
      capture.params = params;
      return { ok: false as const, reason: "missing" as const };
    },
  } as unknown as IZCodeAgentService;
}

async function handshookScope(
  base: IZCodeAgentService,
  connectionId: string,
) {
  const scope = createZCodeAgentConnectionScope(base, {
    connectionId,
    clientMode: "desktop-continuous",
  });
  await scope.service.helloConversationV4();
  await scope.service.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: 3,
    clientId: `probe-${connectionId}`,
    appVersion: "probe",
  });
  return scope;
}

// 作用域 facade 持有的是 host 真值（connectionId 由 create 时的 context 来，
// clientMode 由同一个 context 来）。调用方第一次握手就固定了 clientMode，
// UI 面永远不自己传 connectionId/clientMode —— 传了也会被 withTrustedConnection
// 的 delete 清掉（共享 service 暴露在多个 RPC port 上时，调用方曾能传 profile，
// 且所有 port 共用 workspace fan-out；facade 在此统一清可伪造字段再写 host 真值）。
test("scoped conversationRowsV4 drops top-level identity so base must reject it", async () => {
  const capture: { params: Record<string, unknown> | null } = { params: null };
  const scope = await handshookScope(makeBase(capture), "host-rpc-probe");
  await scope.service.conversationRowsV4({
    ...ROWS_PARAMS,
    connectionId: "evil",
    clientMode: "web-remote-replayable",
  } as unknown as Parameters<IZCodeAgentService["conversationRowsV4"]>[0]);
  assert.ok(capture.params, "base must be reached");
  const sent = capture.params as Record<string, unknown>;
  // withTrustedConnection 先删（connectionId/clientMode/deliveryProfile/subscriberScope/
  // workflowRunDeltas）再只写 carrier：顶层 connectionId 绝不出现在 base 侧。
  // base 侧 readTrustedZCodeAgentV4Connection 只认 carrier 里的那一份。
  assert.equal(
    "connectionId" in sent,
    false,
    "top-level connectionId must be stripped before base sees params",
  );
  assert.equal(
    "clientMode" in sent,
    false,
    "top-level clientMode must be stripped before base sees params",
  );
  const carrier = sent.__zcodeTrustedV4Connection as
    | { connectionId?: string; clientMode?: string }
    | undefined;
  assert.ok(carrier, "scope must attach its own carrier for base to accept");
  assert.equal(
    carrier?.connectionId,
    "host-rpc-probe",
    "carrier holds host connection identity, not caller fields",
  );
  assert.equal(
    carrier?.clientMode,
    "desktop-continuous",
    "carrier holds host clientMode, not caller-supplied mode",
  );
  await scope.dispose().catch(() => {});
});
// 回归 `fault.conversation.rowsConnectionUntrusted` 的正向路径：scope 始终给 base 挂
// 上 host carrier，base 侧 readTrustedZCodeAgentV4Connection 必须读到它。缺了这一层，
// renderer 的快绘读取静默回落到 subscribe（慢 100x），和「没做」没有区别。
test("scoped conversationRowsV4 reaches base only through the scoped wrapper", async () => {
  const capture: { params: Record<string, unknown> | null } = { params: null };
  const scope = await handshookScope(makeBase(capture), "host-rpc-probe-2");
  await scope.service.conversationRowsV4({
    ...ROWS_PARAMS,
  } as unknown as Parameters<IZCodeAgentService["conversationRowsV4"]>[0]);
  assert.ok(capture.params, "base must be reached through the scope override");
  await scope.dispose().catch(() => {});
});

// 缺席载体直接 fail-closed：assertReady 在握手完成前拒绝，fail-closed 到
// conversationRowsFastPath 的 "unavailable" 退回桶，绝不放行无身份的读取。
test("scoped conversationRowsV4 refuses reads before handshake", async () => {
  const capture: { params: Record<string, unknown> | null } = { params: null };
  const scope = createZCodeAgentConnectionScope(makeBase(capture), {
    connectionId: "host-rpc-probe-3",
    clientMode: "desktop-continuous",
  });
  await assert.rejects(
    () =>
      scope.service.conversationRowsV4({
        ...ROWS_PARAMS,
      } as unknown as Parameters<IZCodeAgentService["conversationRowsV4"]>[0]),
    /handshakeRequired/,
  );
  assert.equal(capture.params, null, "base must not be reached before handshake");
  await scope.dispose().catch(() => {});
});
