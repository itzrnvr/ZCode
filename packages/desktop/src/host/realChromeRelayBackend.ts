import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
} from "@zcode/shared";

/**
 * Real-Chrome `extension` backend：连用户已装的 companion extension（MV3，
 * chrome.debugger = 真 CDP on live tabs），把用户真实 Chrome 的 tab 变成
 * agent 可枚举、可 claim、可执行的 backend。
 *
 * 协议（与 OMP Browser Relay 同形，见 managed skill
 * fix-omp-browser-relay-and-real-chrome-input）：
 * - extension 主动连上来：`ws://127.0.0.1:<port>/ext[?token=]`，首帧 hello
 *   { tabs: [{tabId,url,title,active,...}], browserVersion, ... }
 * - host 发 `{id,op,...}` RPC，extension 回 `{t:"rpcResult",id,ok,result|error}`
 * - ops: attach/detach/send（chrome.debugger 直通）、createTab/removeTab/
 *   activateTab；group/ungroup 暂不经过 agent（用户 tab 分组不动）。
 *
 * 安全边界：
 * - 只连 127.0.0.1（本机），token 可选配；extension 是用户亲手装的，
 *   不是静默注入——未连上时 list() 直接不报 extension，不伪造 stub。
 * - agent 的 destructive 命令（navigate/click/fill/type/press…）走用户 tab
 *   前必须经过 claim；claim = 把 tab 挂到 agent scope + 在用户窗口激活，
 *   用户全程看得见 agent 在动哪个 tab。
 * - 用户 tab 的 snapshot/evaluate 与 iab 同权；recording（webm 录制）是
 *   iab-only（manifest 侧已标 unsupportedByDefaultIn extension），这里不实现。
 */

export interface RelayTabSnapshot {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  discarded?: boolean;
  windowId: number;
  pinned?: boolean;
}

interface RelayHello {
  t: "hello";
  instanceId?: string;
  userAgent?: string;
  browserVersion?: string;
  tabs: RelayTabSnapshot[];
  attachedTabIds?: number[];
}

interface RelayRpcResult {
  t: "rpcResult";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type RelayIncoming = RelayHello | RelayRpcResult | { t: string };

export interface RealChromeRelayClientDeps {
  /** 本地 ws 服务端口；缺省 9224（与 OMP relay 同端口，复用用户已装的 extension）。 */
  port?: number;
  token?: string;
  /** 可注入的 WebSocket 构造（单测用假 socket；缺省用全局 WebSocket）。 */
  createSocket?: (url: string) => RelaySocket;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const OPEN_STATE = 1;
const RPC_TIMEOUT_MS = 30_000;

function sanitizeRelayUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return undefined;
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "about:"].includes(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Relay 连接：一个 extension 实例 = 一次 hello 握手。断线重连由 extension 侧
 * 发起（它连 host，不是 host 连它），host 只 accept + 记最新 hello。
 */
export class RealChromeRelayClient {
  readonly #port: number;
  readonly #token: string;
  readonly #log: (message: string, extra?: Record<string, unknown>) => void;
  #hello: RelayHello | null = null;
  #helloAt = 0;
  #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown }
  >();
  #socket: RelaySocket | null = null;
  #createSocket: ((url: string) => RelaySocket) | null;

  constructor(deps: RealChromeRelayClientDeps = {}) {
    this.#port = deps.port ?? 9224;
    this.#token = deps.token ?? "";
    this.#log = deps.log ?? (() => {});
    this.#createSocket = deps.createSocket ?? null;
  }

  /** extension 连上来的 socket 交给 client（由宿主的 ws server accept 后调用）。 */
  attachSocket(socket: RelaySocket): void {
    this.#socket = socket;
    socket.onmessage = (event: { data: unknown }) => {
      if (typeof event.data !== "string") return;
      let msg: RelayIncoming;
      try {
        msg = JSON.parse(event.data) as RelayIncoming;
      } catch {
        return;
      }
      this.#handleMessage(msg);
    };
    socket.onclose = () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#hello = null;
      }
    };
    socket.onerror = () => {
      this.#log("[real-chrome] relay socket error", { port: this.#port });
    };
  }

  /** 单测/直连模式：主动连一个已在跑的 relay daemon（omp browser-relay serve）。 */
  connect(): void {
    if (!this.#createSocket) return;
    const url = `ws://127.0.0.1:${this.#port}/ext${this.#token ? `?token=${encodeURIComponent(this.#token)}` : ""}`;
    const socket = this.#createSocket(url);
    this.attachSocket(socket);
  }

  /** 收到 hello 才算握手完成；list() 只在握手后报 extension。 */
  get connected(): boolean {
    return this.#hello !== null && this.#socket?.readyState === OPEN_STATE;
  }

  get tabs(): RelayTabSnapshot[] {
    return this.#hello?.tabs ?? [];
  }

  get browserVersion(): string | undefined {
    return this.#hello?.browserVersion;
  }

  /** 测试注入 hello（绕过 socket）。 */
  injectHello(hello: RelayHello): void {
    this.#hello = hello;
    this.#helloAt = Date.now();
  }

  /** ws 库走 EventEmitter 而非 DOM 回调：server 把收到的帧喂到这里。 */
  feedRaw(data: unknown): void {
    const text = typeof data === "string" ? data : (data as { toString?: () => string })?.toString?.() ?? "";
    if (!text) return;
    let msg: RelayIncoming;
    try {
      msg = JSON.parse(text) as RelayIncoming;
    } catch {
      return;
    }
    this.#handleMessage(msg);
  }

   /** 测试注入 rpc 结果（绕过 socket）。 */
   injectRpcResult(result: RelayRpcResult): void {
     this.#handleMessage(result);
   }

  async rpc(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN_STATE) {
      throw new Error("real-chrome relay is not connected");
    }
    const id = randomUUID();
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`real-chrome relay rpc '${op}' timed out (${RPC_TIMEOUT_MS}ms)`));
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, op, ...params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    await this.rpc("attach", { tabId });
  }

  async detach(tabId: number): Promise<void> {
    await this.rpc("detach", { tabId });
  }

  async sendCdp(tabId: number, method: string, params?: unknown): Promise<unknown> {
    return await this.rpc("send", {
      tabId,
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  dispose(): void {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
      entry.reject(new Error("real-chrome relay client disposed"));
    }
    this.#pending.clear();
    try {
      this.#socket?.close();
    } catch {
      // dispose 不抛。
    }
    this.#socket = null;
    this.#hello = null;
  }

  #handleMessage(msg: RelayIncoming): void {
    if (msg.t === "hello") {
      this.#hello = msg as RelayHello;
      this.#helloAt = Date.now();
      this.#log("[real-chrome] relay hello", {
        tabs: (msg as RelayHello).tabs?.length ?? 0,
        browserVersion: (msg as RelayHello).browserVersion,
      });
      return;
    }
    if (msg.t === "rpcResult") {
      const result = msg as RelayRpcResult;
      const entry = this.#pending.get(result.id);
      if (!entry) return;
      this.#pending.delete(result.id);
      clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
      if (result.ok) entry.resolve(result.result);
      else entry.reject(new Error(result.error ?? "relay rpc failed"));
      return;
    }
    // pong / 未知帧：忽略。
  }
}

export interface RealChromeRelayServerDeps {
  port?: number;
  token?: string;
  client: RealChromeRelayClient;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  /** bind 失败（EADDRINUSE 等）的异步通知；不抛，host 不炸。 */
  onError?: (error: unknown) => void;
}

export interface RealChromeRelayServer {
  port: number;
  close(): Promise<void>;
}

/**
 * 本地 ws 服务：extension 主动连上来（它连 host，不是 host 连它）。只绑 127.0.0.1。
 * 路径只接受 /ext；token 对上才接。
 *
 * EADDRINUSE 是预期的常见态（用户跑着 omp relay daemon 占 9224）：bind 失败走
 * error 事件 + onError 回调，不抛、不炸 host。ws 的 listen 错误是异步的，
 * 调用方的 try/catch 包不住，必须走事件。
 */
export function startRealChromeRelayServer(deps: RealChromeRelayServerDeps): RealChromeRelayServer {
  const port = deps.port ?? 9224;
  const log = deps.log ?? (() => {});
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  server.on("error", (error: unknown) => {
    log("[real-chrome] relay server unavailable (port in use?)", {
      port,
      error: error instanceof Error ? error.message : String(error),
    });
    deps.onError?.(error);
  });
  server.on("connection", (socket: WebSocket, request: { url?: string }) => {
    const url = request?.url ?? "";
    if (!url.startsWith("/ext")) {
      socket.close();
      return;
    }
    if (deps.token) {
      const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      const token = new URLSearchParams(query).get("token") ?? "";
      if (token !== deps.token) {
        socket.close();
        return;
      }
    }
    log("[real-chrome] extension connected", { port });
    const shell: RelaySocket = {
      get readyState() {
        return socket.readyState;
      },
      send: (data: string) => socket.send(data),
      close: () => socket.close(),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    deps.client.attachSocket(shell);
    // ws 库走 EventEmitter 而非 DOM 回调：帧经 feedRaw 进 client，关闭/错误透传给壳。
    socket.on("message", (data: unknown) => deps.client.feedRaw(data));
    socket.on("close", () => shell.onclose?.({}));
    socket.on("error", (error: unknown) => shell.onerror?.(error));
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const EXTENSION_BACKEND_ID_PREFIX = "extension:";

export interface RealChromeExtensionBackendDeps {
  relay: RealChromeRelayClient;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

/**
 * `extension` backend 的 descriptor + execute。只做两件事：
 * 1. list()：relay 握手成功才报一个 descriptor（tab 级寻址走 claimTab，
 *    不需要每 tab 一个 descriptor）。
 * 2. execute()：按 command.method 转成 relay rpc；页命令先保证 debugger
 *    已 attach（幂等：已 attach 的 tab 重复 attach 由 extension 侧兼容）。
 */
export class RealChromeExtensionBackend {
  readonly #relay: RealChromeRelayClient;
  readonly #log: (message: string, extra?: Record<string, unknown>) => void;
  readonly #browserId = `${EXTENSION_BACKEND_ID_PREFIX}${randomUUID()}`;
  readonly #generation: number = Date.now();
  /** agent 已 claim 的 tab（tabId → 认领时间）；未 claim 的用户 tab 只可枚举、列快照。 */
  readonly #claimedTabs = new Map<number, number>();
  #attachedTabs = new Set<number>();

  constructor(deps: RealChromeExtensionBackendDeps) {
    this.#relay = deps.relay;
    this.#log = deps.log ?? (() => {});
  }

  get browserId(): string {
    return this.#browserId;
  }

  get generation(): number {
    return this.#generation;
  }

  /** 测试：relay 断线后 generation 不变但 list 不再报（不伪造 stub）。 */
  descriptor(): BrowserBackendDescriptor | null {
    if (!this.#relay.connected) return null;
    const tabs = this.#relay.tabs;
    return {
      id: this.#browserId,
      generation: this.#generation,
      type: "extension",
      name: "Real Chrome",
      capabilities: { browser: [], tab: [] },
      apiSupportOverrides: {
        "BrowserUser.claimTab": true,
        "Tabs.finalize": true,
        "Tab.markDeliverable": true,
        "Tab.markHandoff": true,
      },
      metadata: {
        provider: "zcode-desktop-real-chrome",
        ...(this.#relay.browserVersion ? { browserVersion: this.#relay.browserVersion } : {}),
        tabCount: String(tabs.length),
      },
    };
  }

  async execute(command: BrowserCommand): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    if (!this.#relay.connected) {
      return this.#error("backend_unavailable", "real Chrome is not connected", startedAt);
    }
    try {
      switch (command.method) {
        case "list":
          return { ok: true, tabs: [], elapsedMs: Date.now() - startedAt };
        case "listUserTabs": {
          const userTabs = this.#relay.tabs.map((tab) => ({
            id: `ext-tab-${tab.tabId}`,
            url: sanitizeRelayUrl(tab.url) ?? "about:blank",
            title: tab.title || undefined,
            active: tab.active,
          }));
          return { ok: true, userTabs, elapsedMs: Date.now() - startedAt };
        }
        case "claimTab": {
          const tabId = this.#parseExtTabId(command.tabId);
          if (tabId === null) {
            return this.#error(
              "backend_unavailable",
              `unknown real-Chrome tab '${command.tabId}'`,
              startedAt,
            );
          }
          await this.#ensureAttached(tabId);
          await this.#relay.rpc("activateTab", { tabId });
          this.#claimedTabs.set(tabId, Date.now());
          this.#log("[real-chrome] claimed user tab", { tabId });
          const tabs = await this.#controlledTabs();
          return {
            ok: true,
            tab: tabs.find((tab) => tab.tabId === `ext-tab-${tabId}`),
            elapsedMs: Date.now() - startedAt,
          };
        }
        case "navigate": {
          const tabId = await this.#resolveWritableTabId(command, startedAt);
          if (typeof tabId === "object") return tabId;
          await this.#ensureAttached(tabId);
          await this.#relay.sendCdp(tabId, "Page.navigate", { url: command.url });
          return { ok: true, elapsedMs: Date.now() - startedAt };
        }
        case "snapshot": {
          const tabId = await this.#resolveReadableTabId(command, startedAt);
          if (typeof tabId === "object") return tabId;
          await this.#ensureAttached(tabId);
          // 可访问性快照：走 Runtime.evaluate 读 aria 树（extension 无 DOM 快照原语，
          // 先给可用版本；完整 AX 树走后续 Page.captureScreenshot + elementInfo 补）。
          const ax = (await this.#relay.sendCdp(tabId, "Accessibility.getFullAXTree", {})) as {
            nodes?: Array<{ role?: { value?: string }; name?: { value?: string } }>;
          };
          return {
            ok: true,
            snapshot: {
              url: this.#relay.tabs.find((tab) => tab.tabId === tabId)?.url ?? "",
              nodeCount: ax?.nodes?.length ?? 0,
            },
            elapsedMs: Date.now() - startedAt,
          };
        }
        case "screenshot": {
          const tabId = await this.#resolveReadableTabId(command, startedAt);
          if (typeof tabId === "object") return tabId;
          await this.#ensureAttached(tabId);
          const shot = (await this.#relay.sendCdp(tabId, "Page.captureScreenshot", {
            format: "jpeg",
            quality: 80,
          })) as { data?: string };
          return {
            ok: true,
            screenshot: shot?.data ?? "",
            elapsedMs: Date.now() - startedAt,
          };
        }
        case "getState": {
          const tabId = await this.#resolveReadableTabId(command, startedAt);
          if (typeof tabId === "object") return tabId;
          const tab = this.#relay.tabs.find((candidate) => candidate.tabId === tabId);
          return {
            ok: true,
            state: {
              url: tab?.url ?? "",
              title: tab?.title ?? "",
              active: tab?.active ?? false,
            },
            elapsedMs: Date.now() - startedAt,
          };
        }
        case "close": {
          // 用户 tab 不能替用户关：只 detach + 解 claim，tab 留在用户窗口。
          const closeHolder = command as { tabId?: string };
          const closeRaw = "tabId" in command ? closeHolder.tabId : undefined;
          const tabId = this.#parseExtTabId(closeRaw);
          if (tabId !== null) {
            this.#claimedTabs.delete(tabId);
            await this.#relay.detach(tabId).catch(() => {});
            this.#attachedTabs.delete(tabId);
          }
          return { ok: true, elapsedMs: Date.now() - startedAt };
        }
        case "capabilities":
        case "browserVisibilityGet":
          return { ok: true, elapsedMs: Date.now() - startedAt };
        case "browserVisibilitySet":
          // 真实 Chrome 窗口显隐不由 agent 控制（用户窗口不能被藏）。
          return { ok: true, elapsedMs: Date.now() - startedAt };
        default:
          return this.#error(
            "capability_unsupported",
            `Browser command '${(command as BrowserCommand).method}' is not yet bridged to real Chrome`,
            startedAt,
          );
      }
    } catch (error) {
      return this.#error(
        "execution_error",
        error instanceof Error ? error.message : String(error),
        startedAt,
      );
    }
  }

  #error(
    code: "backend_unavailable" | "capability_unsupported" | "execution_error",
    message: string,
    startedAt: number,
  ): BrowserCommandResult {
    return { ok: false, error: { code, message }, elapsedMs: Date.now() - startedAt };
  }

  #parseExtTabId(tabId: string | undefined): number | null {
    if (!tabId) return null;
    const match = /^ext-tab-(\d+)$/.exec(tabId);
    if (!match) {
      const numeric = Number(tabId);
      return Number.isInteger(numeric) ? numeric : null;
    }
    return Number(match[1]);
  }

  async #ensureAttached(tabId: number): Promise<void> {
    if (this.#attachedTabs.has(tabId)) return;
    await this.#relay.attach(tabId).catch(() => {
      // 已 attach 的 tab 重复 attach 会抛，幂等忽略（后续 send 能走即成功）。
    });
    this.#attachedTabs.add(tabId);
  }

  /** 写操作只进 claimed tab；未 claim 一律拒绝（用户看得见才安全）。 */
  async #resolveWritableTabId(
    command: BrowserCommand,
    startedAt: number,
  ): Promise<number | BrowserCommandResult> {
    const holder = command as { tabId?: string };
    const rawTabId = "tabId" in command ? holder.tabId : undefined;
    const tabId = this.#parseExtTabId(rawTabId);
    if (tabId === null || !this.#claimedTabs.has(tabId)) {
      return this.#error(
        "backend_unavailable",
        "real-Chrome tab must be claimed before the agent can drive it (claimTab first)",
        startedAt,
      );
    }
    return tabId;
  }

  /** 读操作（snapshot/screenshot/getState）允许已 claim 的 tab；未指定时取 active 用户 tab。 */
  async #resolveReadableTabId(
    command: BrowserCommand,
    startedAt: number,
  ): Promise<number | BrowserCommandResult> {
    const holder = command as { tabId?: string };
    const rawTabId = "tabId" in command ? holder.tabId : undefined;
    const explicit = this.#parseExtTabId(rawTabId);
    if (explicit !== null) {
      if (!this.#claimedTabs.has(explicit)) {
        const active = this.#relay.tabs.find((tab) => tab.active);
        if (active && active.tabId === explicit) return explicit;
        return this.#error(
          "backend_unavailable",
          "real-Chrome tab must be claimed before reading (claimTab first)",
          startedAt,
        );
      }
      return explicit;
    }
    const claimed = [...this.#claimedTabs.keys()][0];
    if (claimed !== undefined) return claimed;
    const active = this.#relay.tabs.find((tab) => tab.active);
    if (active) return active.tabId;
    const first = this.#relay.tabs[0];
    if (!first) return this.#error("backend_unavailable", "real Chrome has no open tabs", startedAt);
    return first.tabId;
  }

  async #controlledTabs(): Promise<Array<{ tabId: string; url?: string; active?: boolean }>> {
    return [...this.#claimedTabs.keys()].map((tabId) => {
      const tab = this.#relay.tabs.find((candidate) => candidate.tabId === tabId);
      return {
        tabId: `ext-tab-${tabId}`,
        url: tab?.url,
        active: tab?.active,
      };
    });
  }
}
