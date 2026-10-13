import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { session as electronSession } from "electron";
import type {
  ChromeBrowserDataImportError,
  ChromeBrowserDataImportResult,
  EmbeddedBrowserDataClearResult,
} from "@zcode/shared";
import {
  importChromeCookies,
  type ChromeCookieDatabaseBackup,
  type ChromeCookieHelper,
} from "./chromeCookieManager.js";
import {
  ChromeCookieAccessDeniedError,
  type MacChromeSafeStorageSecretReader,
} from "./chromeCredentialManager.js";
import { importChromeHistoryData } from "./chromeHistoryManager.js";
import {
  emptyChromeLocalStorageImportStats,
  importChromeLocalStorage,
  type ChromeLocalStorageImportStats,
} from "./chromeLocalStorageManager.js";
import { importChromePasswords } from "./chromePasswordManager.js";
import { discoverChromeImportableProfiles } from "./chromeImportableProfiles.js";
import {
  discoverChromeProfile,
  resolveChromeExecutablePath,
  type ChromeProfileDiscoveryResult,
} from "./chromeProfileDiscovery.js";
import type { LinuxChromePasswordStore } from "./chromeInstallationCandidates.js";
import type { WindowsChromeAppBoundKeyReader } from "./windowsChromeAppBoundKey.js";
import { clearEmbeddedBrowserSitePermissions } from "./embeddedBrowserSitePermissions.js";

export const EMBEDDED_BROWSER_PARTITION = "persist:zcode-embedded-browser";
const CACHE_STORAGE_TYPES: Electron.ClearStorageDataOptions["storages"] = [
  "shadercache",
  "serviceworkers",
  "cachestorage",
];

interface BrowserSessionLike {
  clearCache(): Promise<void>;
  clearStorageData(options?: Electron.ClearStorageDataOptions): Promise<void>;
  cookies: {
    set(details: Electron.CookiesSetDetails): Promise<void>;
    flushStore(): Promise<void>;
  };
}

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** One importable Chrome profile resolved for the run (explicit or discovered). */
interface ImportProfileTarget {
  executablePath?: string;
  passwordStore?: LinuxChromePasswordStore;
  profileDirectory: string;
  profilePath: string;
  historyModifiedAt: number;
  userDataDir: string;
}

function toSafeBrowserDataError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function isProfileLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EBUSY" || code === "EACCES" || code === "EPERM" || code === "ERR_SQLITE_ERROR";
/** 兼容旧调用；实际导入使用 discoverChromeProfile 自动选择最近使用的 Profile。 */
export function resolveChromeDefaultProfilePath(
  options: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    localAppData?: string;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Google", "Chrome", "Default");
  }
  if (platform === "win32") {
    return join(
      options.localAppData ?? process.env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
      "Default",
    );
  }
  return join(homeDir, ".config", "google-chrome", "Default");
}

function emptyImportResult(error?: ChromeBrowserDataImportError): ChromeBrowserDataImportResult {
  return {
    success: false,
    cookies: { imported: 0, skipped: 0, failed: 0 },
    localStorage: emptyChromeLocalStorageImportStats(),
    passwords: { imported: 0, skipped: 0, failed: 0 },
    ...(error ? { error } : {}),
  };
}

export async function importChromeBrowserData(options: {
  allowElevatedChromeDecryption?: boolean;
  chromeCookieDatabaseBackup?: ChromeCookieDatabaseBackup;
  chromeCookieHelper?: ChromeCookieHelper;
  chromeExecutableDiscovery?: () => Promise<string | null>;
  chromeExecutablePath?: string;
  chromePasswordStore?: LinuxChromePasswordStore;
  chromeProfileDiscovery?: () => Promise<ChromeProfileDiscoveryResult>;
  logger: BrowserDataLogger;
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader;
  profilePath?: string;
  platform?: NodeJS.Platform;
  targetSession?: BrowserSessionLike;
  /** On-disk profile dir of the embedded partition; required for the history stage. */
  targetProfileDir?: string;
  /** Dialog checkbox scopes; missing means all. */
  scopes?: Record<string, boolean>;
  windowsChromeAppBoundKeyReader?: WindowsChromeAppBoundKeyReader;
  localStorageImporter?: (options: {
    profilePath: string;
    targetSession: Electron.Session;
    logger: BrowserDataLogger;
    platform?: NodeJS.Platform;
    chromeExecutablePath?: string;
  }) => Promise<ChromeLocalStorageImportStats>;
}): Promise<ChromeBrowserDataImportResult> {
  const platform = options.platform ?? process.platform;
  let detectedChromeExecutablePath = options.chromeExecutablePath;
  if (!detectedChromeExecutablePath) {
    // Resolve the executable on every platform, not just non-win32: the
    // App-Bound cookie/password key reader and the LocalStorage helper both
    // need it to launch Chrome.
    detectedChromeExecutablePath =
      (await (
        options.chromeExecutableDiscovery ?? (() => resolveChromeExecutablePath({ platform }))
      )()) ?? undefined;
    if (!detectedChromeExecutablePath) {
      // 过去会先扫描默认 Profile，导致“Chrome 未安装”被误报为 Profile 缺失，
      // 也无法识别注册在非默认目录的浏览器。先完成可执行文件发现，失败时不访问源数据。
      return emptyImportResult("chrome_executable_not_found");
    }
  }

  // Profile targets: explicit path (tests / custom flows), or EVERY importable
  // profile of the main Chrome install. Single-profile discovery used to pick
  // last-used/Default, which is regularly the WRONG profile (measured live:
  // Default empty, Profile 1 holds all cookies and passwords). "Import
  // everything" merges all importable profiles.
  const profiles: ImportProfileTarget[] = options.profilePath
    ? [
        {
          ...(options.chromeExecutablePath ? { executablePath: options.chromeExecutablePath } : {}),
          ...(options.chromePasswordStore ? { passwordStore: options.chromePasswordStore } : {}),
          profileDirectory: "explicit-profile",
          profilePath: options.profilePath,
          historyModifiedAt: 0,
          userDataDir: dirname(options.profilePath),
        },
      ]
    : (await discoverChromeImportableProfiles({ platform })).map((profile) => ({
        ...(profile.executablePath ? { executablePath: profile.executablePath } : {}),
        ...(profile.passwordStore
          ? { passwordStore: profile.passwordStore as LinuxChromePasswordStore }
          : {}),
        profileDirectory: profile.profileDirectory,
        profilePath: profile.profilePath,
        historyModifiedAt: profile.historyModifiedAt,
        userDataDir: profile.userDataDir,
      }));
  if (profiles.length === 0) {
    // Fall back to the legacy single-profile discovery for its richer error
    // codes (not found / ambiguous) before declaring failure.
    const discovered = await (options.chromeProfileDiscovery ??
      (() => discoverChromeProfile({ platform })))();
    if (!discovered.success) return emptyImportResult(discovered.error);
    return emptyImportResult("chrome_profile_not_found");
  }
  const fallbackExecutable = profiles.find((profile) => profile.executablePath)?.executablePath;
  const chromeExecutablePath = options.chromeExecutablePath ?? fallbackExecutable ?? detectedChromeExecutablePath;

  const targetSession =
    options.targetSession ?? electronSession.fromPartition(EMBEDDED_BROWSER_PARTITION);
  const result: ChromeBrowserDataImportResult = {
    success: false,
    cookies: { imported: 0, skipped: 0, failed: 0 },
    localStorage: emptyChromeLocalStorageImportStats(),
    passwords: { imported: 0, skipped: 0, failed: 0 },
  };
  const issues = new Set<ChromeBrowserDataImportError>();
  const want = (scope: string): boolean => options.scopes?.[scope] !== false;

  for (const target of profiles) {
    options.logger.info("[browser-data] importing Chrome profile", {
      profile: target.profileDirectory,
    });

    // Cookies. A locked database (Chrome running) must degrade to an issue on
    // THIS profile, never kill the whole run — that single throw used to fail
    // every stage including the ones that work with Chrome open.
    if (want("cookies")) {
      try {
        const cookieImport = await importChromeCookies({
          allowElevatedChromeDecryption: options.allowElevatedChromeDecryption,
          databaseBackup: options.chromeCookieDatabaseBackup,
          chromeCookieHelper: options.chromeCookieHelper,
          chromeExecutablePath: target.executablePath ?? chromeExecutablePath,
          chromePasswordStore: target.passwordStore,
          logger: options.logger,
          macChromeSafeStorageSecretReader: options.macChromeSafeStorageSecretReader,
          platform,
          profilePath: target.profilePath,
          targetSession,
          windowsChromeAppBoundKeyReader: options.windowsChromeAppBoundKeyReader,
        });
        result.cookies.imported += cookieImport.stats.imported;
        result.cookies.skipped += cookieImport.stats.skipped;
        result.cookies.failed += cookieImport.stats.failed;
        for (const issue of cookieImport.issues) issues.add(issue);
      } catch (error) {
        if (error instanceof ChromeCookieAccessDeniedError) throw error;
        const lockIssue: ChromeBrowserDataImportError = isProfileLockError(error)
          ? "chrome_profile_locked"
          : "chrome_data_import_failed";
        issues.add(lockIssue);
        options.logger.warn("[browser-data] cookie stage failed for profile", {
          code: toSafeBrowserDataError(error).code,
          profile: target.profileDirectory,
        });
      }
    }

    // Site data (LocalStorage).
    if (want("siteData")) {
      const localStorageImporter = options.localStorageImporter ?? importChromeLocalStorage;
      const stats = await localStorageImporter({
        profilePath: target.profilePath,
        targetSession: targetSession as Electron.Session,
        logger: options.logger,
        platform,
        chromeExecutablePath: target.executablePath ?? chromeExecutablePath,
      });
      result.localStorage.originsImported += stats.originsImported;
      result.localStorage.entriesImported += stats.entriesImported;
      result.localStorage.originsSkipped += stats.originsSkipped;
      result.localStorage.originsFailed += stats.originsFailed;
      if (stats.error) issues.add(stats.error);
    }

    // Passwords. The stage itself never throws; it degrades to failed counts.
    if (want("passwords")) {
      const stats = await importChromePasswords({
        allowElevated: options.allowElevatedChromeDecryption === true,
        chromeExecutablePath: target.executablePath ?? chromeExecutablePath,
        logger: options.logger,
        platform,
        profilePath: target.profilePath,
        targetSession: targetSession as Electron.Session & {
          addPasswordRecord?: (record: {
            originUrl: string;
            signonRealm: string;
            username: string;
            password: string;
          }) => Promise<void>;
        },
        userDataDir: target.userDataDir,
        windowsChromeAppBoundKeyReader: options.windowsChromeAppBoundKeyReader,
      });
      result.passwords.imported += stats.imported;
      result.passwords.skipped += stats.skipped;
      result.passwords.failed += stats.failed;
    }
  }

  // History / Bookmarks / Preferences: file-level snapshot from the profile
  // with the freshest History (bookmarks/preferences live per profile; one
  // representative keeps the embedded partition coherent).
  const historyProfile = [...profiles].sort(
    (left, right) => right.historyModifiedAt - left.historyModifiedAt,
  )[0];
  if (want("history") && options.targetProfileDir && historyProfile) {
    options.logger.info("[browser-data] importing Chrome History/Bookmarks", {
      profile: historyProfile.profileDirectory,
    });
    result.history = await importChromeHistoryData({
      logger: options.logger,
      profilePath: historyProfile.profilePath,
      targetProfileDir: options.targetProfileDir,
    });
    if (result.history.error) issues.add(result.history.error);
  }

  try {
    await targetSession.cookies.flushStore();
  } catch {
    // Best effort; the partition flushes on its own cadence too.
  }

  result.success =
    result.cookies.imported > 0 ||
    result.localStorage.originsImported > 0 ||
    result.passwords.imported > 0 ||
    result.history?.visitsCopied === true ||
    result.history?.bookmarksCopied === true;
  if (!result.success) {
    result.error = [
      "chrome_cookie_elevation_required",
      "chrome_cookie_elevation_cancelled",
      "chrome_cookie_helper_verification_failed",
      "chrome_cookie_app_bound_decryption_failed",
      "chrome_cookie_protection_unsupported",
      "chrome_profile_locked",
    ].find((issue) => issues.has(issue as ChromeBrowserDataImportError)) as
      | ChromeBrowserDataImportError
      | undefined;
    result.error ??= result.localStorage.error ?? "chrome_browser_data_import_unavailable";
  }
  if (issues.size > 0) result.issues = [...issues];
  options.logger.info("[browser-data] Chrome import finished", {
    profileCount: profiles.length,
    importedCookies: result.cookies.imported,
    skippedCookies: result.cookies.skipped,
    failedCookies: result.cookies.failed,
    importedLocalStorageOrigins: result.localStorage.originsImported,
    importedLocalStorageEntries: result.localStorage.entriesImported,
    failedLocalStorageOrigins: result.localStorage.originsFailed,
    importedPasswords: result.passwords.imported,
    historyCopied: result.history?.visitsCopied ?? false,
    bookmarksCopied: result.history?.bookmarksCopied ?? false,
  });
  return result;
}

export async function clearEmbeddedBrowserData(options: {
  logger: BrowserDataLogger;
  mode: "cache" | "all";
  targetSession?: BrowserSessionLike;
}): Promise<EmbeddedBrowserDataClearResult> {
  const targetSession =
    options.targetSession ?? electronSession.fromPartition(EMBEDDED_BROWSER_PARTITION);
  try {
    await targetSession.clearCache();
    if (options.mode === "all") {
      await targetSession.clearStorageData();
      // 「全部清除」连站点权限同意记录一起清：登录态与权限授权同属用户可预期的清理范围。
      await clearEmbeddedBrowserSitePermissions();
    } else {
      // Plain cache clears must NOT delete LocalStorage/IndexedDB: they carry
      // the sign-in state this module exists to build.
      await targetSession.clearStorageData({ storages: CACHE_STORAGE_TYPES });
    }
    options.logger.info("[browser-data] embedded browser data cleared", { mode: options.mode });
    return { success: true };
  } catch {
    options.logger.warn("[browser-data] embedded browser data clear failed", {
      mode: options.mode,
    });
    return { success: false, error: "embedded_browser_clear_failed" };
  }
}
