import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChromeBrowserDataImportError } from "@zcode/shared";

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface ChromeHistoryImportStats {
  visitsCopied: boolean;
  bookmarksCopied: boolean;
  preferencesCopied: boolean;
  error?: ChromeBrowserDataImportError;
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * History / Bookmarks / Preferences：文件级快照复制到 Electron partition 的
 * 对应 userData 位置。Electron 与 Chromium 同源（History/Bookmarks/Preferences
 * 都是同形态 SQLite/JSON），复制后由 Chromium 原生读取——不需要逐行解析。
 *
 * 为什么是文件级而不是逐行：
 * - History 是 40MB 级 SQLite（用户实测 40,730,624 B），逐行读再写 IndexedDB
 *   又慢又丢 favicon 关联；文件复制一次完成，Chromium 下次启动原生加载。
 * - Bookmarks/Preferences 是 JSON，直接可读；复制即导入。
 * - 活库被 Chrome 占用时复制快照（-wal 一并带走），与 Cookie 的 WAL 快照同理。
 * - Login Data 不走这里（密码要逐行 DPAPI 解，见 chromePasswordManager）。
 */
export async function importChromeHistoryData(options: {
  logger: BrowserDataLogger;
  profilePath: string;
  targetProfileDir: string;
}): Promise<ChromeHistoryImportStats> {
  const stats: ChromeHistoryImportStats = {
    visitsCopied: false,
    bookmarksCopied: false,
    preferencesCopied: false,
  };
  const copyWithWal = async (fileName: string): Promise<boolean> => {
    const source = join(options.profilePath, fileName);
    if (!(await pathExists(source))) return false;
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-browser-history-"));
    try {
      const staged = join(tempDir, fileName);
      await copyFile(source, staged);
      for (const suffix of ["-wal", "-shm"]) {
        const walSource = `${source}${suffix}`;
        if (await pathExists(walSource)) {
          await copyFile(walSource, `${staged}${suffix}`).catch(() => {});
        }
      }
      const target = join(options.targetProfileDir, fileName);
      await copyFile(staged, target);
      for (const suffix of ["-wal", "-shm"]) {
        const stagedWal = `${staged}${suffix}`;
        if (await pathExists(stagedWal)) {
          await copyFile(stagedWal, `${target}${suffix}`).catch(() => {});
        }
      }
      return true;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  };

  try {
    stats.visitsCopied = await copyWithWal("History");
    stats.bookmarksCopied = await copyWithWal("Bookmarks");
    // Preferences 含 payment/addresses 扩展偏好；复制即带上（密码除外，Login Data 另行）。
    stats.preferencesCopied = await copyWithWal("Preferences");
    options.logger.info("[browser-data] Chrome History/Bookmarks/Preferences 快照完成", {
      visitsCopied: stats.visitsCopied,
      bookmarksCopied: stats.bookmarksCopied,
      preferencesCopied: stats.preferencesCopied,
    });
  } catch (error) {
    options.logger.warn(
      "[browser-data] Chrome History 快照失败",
      error instanceof Error ? { name: error.name } : {},
    );
    stats.error = "chrome_data_import_failed";
  }
  return stats;
}
