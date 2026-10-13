import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ipcMain, app } from "electron";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  PlatformChannels,
  type ChromeBrowserDataImportOptions,
  type EmbeddedBrowserSitePermissionUpdateRequest,
} from "@zcode/shared";
import {
  clearEmbeddedBrowserData,
  importChromeBrowserData,
} from "./browserDataManager.js";
import {
  clearEmbeddedBrowserSitePermissions,
  getEmbeddedBrowserSitePermissionSnapshot,
  removeEmbeddedBrowserSitePermission,
  removeEmbeddedBrowserSitePermissionOrigin,
  writeEmbeddedBrowserSitePermission,
} from "./embeddedBrowserSitePermissions.js";

const execFileAsync = promisify(execFile);

/**
 * On-disk profile dir of the embedded browser partition
 * (persist:zcode-embedded-browser -> <userData>/Partitions/zcode-embedded-browser).
 * The history/bookmarks stage copies Chrome's History/Bookmarks/Preferences
 * files there so Chromium loads them natively on next start.
 */
async function resolveEmbeddedProfileDir(): Promise<string> {
  const partitionDir = join(app.getPath("userData"), "Partitions", "zcode-embedded-browser");
  await mkdir(partitionDir, { recursive: true });
  return partitionDir;
}

/**
 * Count chrome.exe processes, including background ones. Closing the last
 * window does NOT exit Chrome when background mode is on — those processes
 * keep the profile databases locked and cookie/password import fails with
 * EBUSY. The import dialog shows this count as a pre-flight warning.
 */
async function countChromeProcesses(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], {
      timeout: 5000,
      windowsHide: true,
    });
    return stdout
      .split("\n")
      .filter((line) => line.toLowerCase().includes('"chrome.exe"')).length;
  } catch {
    return 0;
  }
}

export function registerBrowserDataIpcHandlers(logger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(PlatformChannels.ImportChromeBrowserData, async (_event, value: unknown) => {
    const requested = value as ChromeBrowserDataImportOptions | undefined;
    // The renderer may only pass true explicitly per call; main never accepts
    // or persists any other authorization form.
    const allowElevatedChromeDecryption = requested?.allowElevatedChromeDecryption === true;
    const scopes = requested?.scopes;
    return await importChromeBrowserData({
      allowElevatedChromeDecryption,
      scopes,
      targetProfileDir: await resolveEmbeddedProfileDir(),
      logger,
    });
  });
  ipcMain.handle(PlatformChannels.GetChromeProcessCount, async () => {
    return { count: await countChromeProcesses() };
  });
  ipcMain.handle(PlatformChannels.ClearEmbeddedBrowserData, (_event, mode: unknown) => {
    if (mode !== "cache" && mode !== "all") {
      return { success: false, error: "invalid_clear_mode" };
    }
    return clearEmbeddedBrowserData({ logger, mode });
  });
  ipcMain.handle(PlatformChannels.GetEmbeddedBrowserSitePermissions, () =>
    getEmbeddedBrowserSitePermissionSnapshot(),
  );
  ipcMain.handle(PlatformChannels.SetEmbeddedBrowserSitePermission, (_event, value: unknown) => {
    const request = value as EmbeddedBrowserSitePermissionUpdateRequest | undefined;
    if (
      !request ||
      typeof request.origin !== "string" ||
      !request.origin ||
      typeof request.permission !== "string" ||
      !request.permission ||
      (request.state !== "allow" && request.state !== "deny" && request.state !== "ask")
    ) {
      logger.warn("[browser-data] ignored malformed site permission update");
      return getEmbeddedBrowserSitePermissionSnapshot();
    }
    if (request.state === "ask") {
      void removeEmbeddedBrowserSitePermission(request.origin, request.permission);
    } else {
      void writeEmbeddedBrowserSitePermission(request.origin, request.permission, request.state);
    }
    logger.info("[embedded-browser-permission] site permission updated from settings", {
      origin: request.origin,
      permission: request.permission,
      state: request.state,
    });
    return getEmbeddedBrowserSitePermissionSnapshot();
  });
  ipcMain.handle(PlatformChannels.ClearEmbeddedBrowserSitePermissions, () => {
    void clearEmbeddedBrowserSitePermissions();
    logger.info("[embedded-browser-permission] site permissions cleared from settings");
    return getEmbeddedBrowserSitePermissionSnapshot();
  });
  ipcMain.handle(PlatformChannels.ResetEmbeddedBrowserSitePermission, (_event, value: unknown) => {
    const request = value as { origin?: unknown } | undefined;
    if (!request || typeof request.origin !== "string" || !request.origin) {
      logger.warn("[browser-data] ignored malformed site permission reset");
      return getEmbeddedBrowserSitePermissionSnapshot();
    }
    void removeEmbeddedBrowserSitePermissionOrigin(request.origin);
    logger.info("[embedded-browser-permission] site permissions reset from settings tab", {
      origin: request.origin,
    });
    return getEmbeddedBrowserSitePermissionSnapshot();
  });
}
