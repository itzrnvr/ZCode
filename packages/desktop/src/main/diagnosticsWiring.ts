import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { startDiagnosticsServer, type DiagnosticsServer } from "./diagnosticsServer.js";
import { getZCodeCliLogDir } from "./exportLogs.js";

interface DiagnosticsWiringLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

const DIAGNOSTICS_TOKEN_FILE = "diagnostics-token";
const DIAGNOSTICS_PORT = 3499;

/**
 * 诊断通道装配：main ready 后起本地 server，token 落盘到 userData。
 * agent 读 token 文件 → 调 127.0.0.1:3499/health|state|logs|screenshot。
 * evaluate 默认关闭（renderer 任意求值是强能力，需设置显式开）。
 */
export function wireDiagnosticsServer(options: {
  logger: DiagnosticsWiringLogger;
  evaluateEnabled?: boolean;
}): { getServer: () => DiagnosticsServer | null } {
  let server: DiagnosticsServer | null = null;

  const start = async (): Promise<void> => {
    try {
      const userData = app.getPath("userData");
      const tokenPath = join(userData, DIAGNOSTICS_TOKEN_FILE);
      let token: string | undefined;
      try {
        token = (await readFile(tokenPath, "utf8")).trim() || undefined;
      } catch {
        token = undefined;
      }
      server = startDiagnosticsServer({
        port: DIAGNOSTICS_PORT,
        ...(token ? { token } : {}),
        evaluateEnabled: options.evaluateEnabled ?? false,
        log: (message, extra) => options.logger.warn(message, extra ?? {}),
        listWindows: () =>
          BrowserWindow.getAllWindows()
            .filter((win) => !win.isDestroyed())
            .map((win) => ({
              id: win.id,
              title: win.getTitle(),
              visible: win.isVisible(),
              focused: win.isFocused(),
              bounds: win.getBounds(),
            })),
        collectState: async () => collectAppState(),
        collectLogs: async (lines) => collectRecentLogs(lines),
        captureScreenshot: async () => captureFocusedWindow(),
        evaluateInRenderer: async (expression) => evaluateInFocusedWindow(expression),
      });
      if (!token) {
        await writeFile(tokenPath, server.token, "utf8").catch(() => {});
      }
      options.logger.info("[diagnostics] server listening", { port: DIAGNOSTICS_PORT });
    } catch (error) {
      // 诊断通道挂了不影响主流程：记一条 warn，应用照常跑。
      options.logger.warn(
        "[diagnostics] server failed to start",
        error instanceof Error ? { message: error.message } : {},
      );
    }
  };

  void start();
  return { getServer: () => server };
}

function focusedWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null;
  return win && !win.isDestroyed() ? win : null;
}

async function collectAppState(): Promise<Record<string, unknown>> {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  return {
    appVersion: app.getVersion(),
    windows: windows.map((win) => ({
      id: win.id,
      title: win.getTitle(),
      visible: win.isVisible(),
      focused: win.isFocused(),
      bounds: win.getBounds(),
    })),
    focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
  };
}

async function collectRecentLogs(lines: number): Promise<string[]> {
  try {
    const logDir = getZCodeCliLogDir();
    const files = (await readdir(logDir)).filter((name) => name.endsWith(".jsonl")).sort();
    const latest = files.at(-1);
    if (!latest) return [];
    const content = await readFile(join(logDir, latest), "utf8");
    return content.split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

async function captureFocusedWindow(): Promise<{
  dataBase64: string;
  width: number;
  height: number;
} | null> {
  const win = focusedWindow();
  if (!win) return null;
  try {
    const image = await win.webContents.capturePage();
    const { width, height } = image.getSize();
    return { dataBase64: image.toPNG().toString("base64"), width, height };
  } catch {
    return null;
  }
}

async function evaluateInFocusedWindow(expression: string): Promise<unknown> {
  const win = focusedWindow();
  if (!win) throw new Error("no_window");
  return await win.webContents.executeJavaScript(expression, true);
}
