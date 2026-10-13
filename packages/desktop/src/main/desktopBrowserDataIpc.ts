import { ipcMain, app } from "electron";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PlatformChannels, type ChromeBrowserDataImportOptions } from "@zcode/shared";
import { clearEmbeddedBrowserData, importChromeBrowserData } from "./browserDataManager.js";

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
  ipcMain.handle(PlatformChannels.ClearEmbeddedBrowserData, (_event, mode: unknown) => {
    if (mode !== "cache" && mode !== "all") {
      return { success: false, error: "invalid_clear_mode" };
    }
    return clearEmbeddedBrowserData({ logger, mode });
  });
}
