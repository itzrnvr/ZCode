import { strict as assert } from "node:assert";
import { test } from "node:test";
import { startDiagnosticsServer } from "../src/main/diagnosticsServer.js";

async function get(port: number, path: string, token: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}?token=${token}`);
  return { status: response.status, body: await response.json() };
}

test("health reports windows without token fails", async () => {
  const server = startDiagnosticsServer({ port: 34991, token: "test-token-1" });
  try {
    const denied = await fetch(`http://127.0.0.1:34991/health`);
    assert.equal(denied.status, 401);
    const { status, body } = await get(34991, "/health", "test-token-1");
    assert.equal(status, 200);
    assert.equal((body as { ok: boolean }).ok, true);
  } finally {
    await server.close();
  }
});

test("state and logs endpoints serve injected collectors", async () => {
  const server = startDiagnosticsServer({
    port: 34992,
    token: "test-token-2",
    collectState: async () => ({ appVersion: "test", focusedWindowId: 7 }),
    collectLogs: async (lines) => [`log-line-1`, `log-line-2:${lines}`],
  });
  try {
    const state = await get(34992, "/state", "test-token-2");
    assert.equal((state.body as { state: { appVersion: string } }).state.appVersion, "test");
    const logs = await get(34992, "/logs", "test-token-2");
    assert.deepEqual((logs.body as { logs: string[] }).logs, ["log-line-1", "log-line-2:200"]);
  } finally {
    await server.close();
  }
});

test("evaluate disabled by default", async () => {
  const server = startDiagnosticsServer({ port: 34993, token: "test-token-3" });
  try {
    const response = await fetch(`http://127.0.0.1:34993/evaluate?token=test-token-3`, {
      method: "POST",
      body: JSON.stringify({ expression: "1+1" }),
    });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});

test("evaluate runs when enabled", async () => {
  const server = startDiagnosticsServer({
    port: 34994,
    token: "test-token-4",
    evaluateEnabled: true,
    evaluateInRenderer: async (expression) => ({ echoed: expression }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:34994/evaluate?token=test-token-4`, {
      method: "POST",
      body: JSON.stringify({ expression: "document.title" }),
    });
    const body = (await response.json()) as { ok: boolean; result: { echoed: string } };
    assert.equal(body.ok, true);
    assert.equal(body.result.echoed, "document.title");
  } finally {
    await server.close();
  }
});

test("screenshot 503 without window", async () => {
  const server = startDiagnosticsServer({ port: 34995, token: "test-token-5" });
  try {
    const { status, body } = await get(34995, "/screenshot", "test-token-5");
    assert.equal(status, 503);
    assert.equal((body as { error: string }).error, "no_window");
  } finally {
    await server.close();
  }
});
