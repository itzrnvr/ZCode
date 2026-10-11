import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * In-app diagnostics server：给 agent 看应用内部状态的第一方通道。
 * 不控制整台 PC、不碰用户指针、不抢焦点——只读应用自己的日志/状态/截图。
 *
 * 为什么不用 remote-debugging-port：那只在 dev 开（index.ts:258 `!app.isPackaged`
 * 门控），正式包没有 CDP 口。这个 server 打包态也开，但：
 * - 只绑 127.0.0.1（本机），外网到不了；
 * - token 鉴权：启动时随机生成，写进 userData 下的 `diagnostics-token` 文件，
 * - 默认开但只读；evaluate（renderer 求值）默认关，需设置里显式开；
 * - screenshot 只截本应用窗口，不截全屏。
 */

export interface DiagnosticsWindowInfo {
  id: number;
  title: string;
  visible: boolean;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface DiagnosticsServerDeps {
  port?: number;
  token?: string;
  evaluateEnabled?: boolean;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  listWindows?: () => DiagnosticsWindowInfo[];
  collectState?: () => Promise<Record<string, unknown>>;
  collectLogs?: (lines: number) => Promise<string[]>;
  captureScreenshot?: () => Promise<{ dataBase64: string; width: number; height: number } | null>;
  evaluateInRenderer?: (expression: string) => Promise<unknown>;
}

export interface DiagnosticsServer {
  port: number;
  token: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 3499;

function readBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      reject(new Error("body_too_large"));
      request.destroy();
    }
  });
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
  return promise;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function isAuthorized(request: IncomingMessage, url: URL, token: string): boolean {
  return url.searchParams.get("token") === token || request.headers["x-diagnostics-token"] === token;
}

export function startDiagnosticsServer(deps: DiagnosticsServerDeps = {}): DiagnosticsServer {
  const port = deps.port ?? DEFAULT_PORT;
  const token = deps.token ?? randomUUID().replaceAll("-", "");
  const log = deps.log ?? (() => {});
  let server: Server | null = null;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!isAuthorized(request, url, token)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const path = url.pathname;
      if (request.method === "GET" && path === "/health") {
        const windows = deps.listWindows ? deps.listWindows() : [];
        sendJson(response, 200, { ok: true, windows });
        return;
      }
      if (request.method === "GET" && path === "/state") {
        const state = deps.collectState ? await deps.collectState() : {};
        sendJson(response, 200, { ok: true, state });
        return;
      }
      if (request.method === "GET" && path === "/logs") {
        const lines = Math.min(Number(url.searchParams.get("lines") ?? 200), 2000);
        const entries = deps.collectLogs ? await deps.collectLogs(lines) : [];
        sendJson(response, 200, { ok: true, logs: entries });
        return;
      }
      if (request.method === "GET" && path === "/screenshot") {
        const shot = deps.captureScreenshot ? await deps.captureScreenshot() : null;
        if (!shot) {
          sendJson(response, 503, { ok: false, error: "no_window" });
          return;
        }
        sendJson(response, 200, { ok: true, ...shot });
        return;
      }
      if (request.method === "POST" && path === "/evaluate") {
        if (!deps.evaluateEnabled || !deps.evaluateInRenderer) {
          sendJson(response, 403, { ok: false, error: "evaluate_disabled" });
          return;
        }
        const body = JSON.parse((await readBody(request)) || "{}") as { expression?: string };
        if (typeof body.expression !== "string" || body.expression.length > 20000) {
          sendJson(response, 400, { ok: false, error: "bad_expression" });
          return;
        }
        const result = await deps.evaluateInRenderer(body.expression);
        sendJson(response, 200, { ok: true, result });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  server = createServer((request, response) => {
    void handler(request, response);
  });
  server.on("error", (error: unknown) => {
    log("[diagnostics] server unavailable", {
      port,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  server.listen(port, "127.0.0.1");

  return {
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
      }),
  };
}
