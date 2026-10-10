import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createBrowserControlMainBridge } from "../src/host/browserControlMainBridge.js";
import {
  RealChromeExtensionBackend,
  RealChromeRelayClient,
  type RelaySocket,
} from "../src/host/realChromeRelayBackend.js";

function helloWith(tabs: Array<{ tabId: number; url: string; title: string; active: boolean }>) {
  return {
    t: "hello" as const,
    browserVersion: "Chrome/141.0",
    tabs: tabs.map((tab) => ({ ...tab, windowId: 1 })),
    attachedTabIds: [] as number[],
  };
}

function fakeShell() {
  const sent: string[] = [];
  const shell: RelaySocket = {
    readyState: 1,
    send: (data: string) => {
      sent.push(data);
    },
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return { sent, shell };
}

function connectedRelay(
  tabs: Array<{ tabId: number; url: string; title: string; active: boolean }>,
): { relay: RealChromeRelayClient; sent: string[] } {
  const relay = new RealChromeRelayClient();
  const { sent, shell } = fakeShell();
  relay.attachSocket(shell);
  relay.injectHello(helloWith(tabs));
  return { relay, sent };
}

test("unconnected relay advertises iab only (no stub extension)", async () => {
  const relay = new RealChromeRelayClient();
  const backend = new RealChromeExtensionBackend({ relay });
  const bridge = createBrowserControlMainBridge({
    postToMain: () => {},
    realChromeBackend: backend,
  });
  const backends = await bridge.list();
  assert.equal(backends.length, 1);
  assert.equal(backends[0].type, "iab");
});

test("connected relay advertises extension with tabCount", async () => {
  const { relay } = connectedRelay([
    { tabId: 101, url: "https://example.com", title: "Example", active: true },
  ]);
  const backend = new RealChromeExtensionBackend({ relay });
  assert.equal(backend.descriptor()?.type, "extension");
  assert.equal(backend.descriptor()?.metadata?.["tabCount"], "1");
  const bridge = createBrowserControlMainBridge({
    postToMain: () => {},
    realChromeBackend: backend,
  });
  const backends = await bridge.list();
  assert.equal(backends.length, 2);
  assert.ok(backends.some((candidate) => candidate.type === "extension"));
});

test("extension execute routes to relay, never to main", async () => {
  const relay = new RealChromeRelayClient();
  relay.attachSocket({
    readyState: 1,
    send: (data: string) => {
      // snapshot 经 attach+send 两次 rpc；发出即回成功，不猜时长。
      const msg = JSON.parse(data) as { id: string; op: string };
      queueMicrotask(() =>
        relay.injectRpcResult({ t: "rpcResult", id: msg.id, ok: true, result: {} }),
      );
    },
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  });
  relay.injectHello(
    helloWith([{ tabId: 101, url: "https://example.com", title: "Example", active: true }]),
  );
  const backend = new RealChromeExtensionBackend({ relay });
  let mainCalls = 0;
  const bridge = createBrowserControlMainBridge({
    postToMain: () => {
      mainCalls += 1;
    },
    realChromeBackend: backend,
  });
  const result = await bridge.execute({
    browserId: backend.browserId,
    browserGeneration: backend.generation,
    sessionId: "sess-test",
    command: { method: "snapshot", tabId: "ext-tab-101" },
  });
  assert.equal(mainCalls, 0);
  assert.equal(result.ok, true);
});


test("stale extension generation rejected", async () => {
  const { relay } = connectedRelay([]);
  const backend = new RealChromeExtensionBackend({ relay });
  const bridge = createBrowserControlMainBridge({
    postToMain: () => {},
    realChromeBackend: backend,
  });
  const result = await bridge.execute({
    browserId: backend.browserId,
    browserGeneration: backend.generation + 999,
    sessionId: "sess-test",
    command: { method: "listUserTabs" },
  });
  assert.equal(result.ok, false);
});

test("unclaimed tab navigate refused (claim first)", async () => {
  const { relay } = connectedRelay([
    { tabId: 101, url: "https://example.com", title: "Example", active: true },
  ]);
  const backend = new RealChromeExtensionBackend({ relay });
  const result = await backend.execute({
    method: "navigate",
    url: "https://example.com/next",
    tabId: "ext-tab-101",
  });
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /claim/i);
});

test("claim then navigate flows through relay attach+send", async () => {
  const relay = new RealChromeRelayClient();
  const sent: string[] = [];
  relay.attachSocket({
    readyState: 1,
    send: (data: string) => {
      sent.push(data);
      // 发出即回：extension 侧 attach/activateTab/send 的成功回包，不猜时长。
      const msg = JSON.parse(data) as { id: string; op: string };
      queueMicrotask(() =>
        relay.injectRpcResult({ t: "rpcResult", id: msg.id, ok: true, result: {} }),
      );
    },
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  });
  relay.injectHello(
    helloWith([{ tabId: 101, url: "https://example.com", title: "Example", active: true }]),
  );
  const backend = new RealChromeExtensionBackend({ relay });
  const claimed = await backend.execute({ method: "claimTab", tabId: "ext-tab-101" });
  assert.equal(claimed.ok, true);
  const navigated = await backend.execute({
    method: "navigate",
    url: "https://example.com/next",
    tabId: "ext-tab-101",
  });
  assert.equal(navigated.ok, true);
  assert.ok(sent.length >= 3);
});

test("hello without live socket still advertises nothing", async () => {
  const relay = new RealChromeRelayClient();
  const backend = new RealChromeExtensionBackend({ relay });
  assert.equal(backend.descriptor(), null);
  relay.injectHello(helloWith([]));
  assert.equal(backend.descriptor(), null);
});
