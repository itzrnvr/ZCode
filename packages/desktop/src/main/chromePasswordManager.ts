import { createDecipheriv } from "node:crypto";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as NodeSqliteDatabase } from "node:sqlite";
import type { ChromeBrowserDataImportError } from "@zcode/shared";
import { readWindowsChromeMasterKey } from "./chromeCredentialManager.js";
import {
  readWindowsChromeAppBoundKey,
  type WindowsChromeAppBoundKeyReader,
} from "./windowsChromeAppBoundKey.js";
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof NodeSqliteDatabase };

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface ChromePasswordImportStats {
  imported: number;
  skipped: number;
  failed: number;
  error?: ChromeBrowserDataImportError;
}

interface ChromeLoginRow {
  origin_url: string;
  action_url: string;
  username_element: string;
  username_value: string;
  password_element: string;
  password_value: Uint8Array;
  signon_realm: string;
  blacklisted_by_user: number;
  times_used: number;
}

export interface ChromePasswordRecord {
  originUrl: string;
  signonRealm: string;
  username: string;
  password: string;
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function decryptAesGcm(encrypted: Uint8Array, key: Buffer, expectedPrefix: "v10" | "v20"): string {
  const buffer = Buffer.from(encrypted);
  if (buffer.subarray(0, 3).toString("ascii") !== expectedPrefix) {
    throw new Error("chrome_password_encryption_unsupported");
  }
  const nonce = buffer.subarray(3, 15);
  const authTag = buffer.subarray(buffer.length - 16);
  const ciphertext = buffer.subarray(15, buffer.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  try {
    return decrypted.toString("utf8");
  } finally {
    decrypted.fill(0);
  }
}


/**
 * 从 Chrome `Login Data` 读密码（只读快照，不碰活库）。
 * v10 = DPAPI master key（同 Cookie 旧格式）；v20 = App-Bound key（Chrome 127+
 * 新装密码默认），后者需要与 Cookie 相同的 elevation helper，只在
 * allowElevated 时尝试。非 http(s) 的 login realm（如 android:// 同步占位）
 * 不能进 web autofill，直接跳过。
 */
export async function readChromePasswords(options: {
  allowElevated?: boolean;
  chromeExecutablePath?: string;
  logger: BrowserDataLogger;
  platform?: NodeJS.Platform;
  profilePath: string;
  userDataDir: string;
  windowsChromeAppBoundKeyReader?: WindowsChromeAppBoundKeyReader;
}): Promise<{ records: ChromePasswordRecord[]; skipped: number; failed: number }> {
  const platform = options.platform ?? process.platform;
  const loginDataPath = join(options.profilePath, "Login Data");
  if (!(await pathExists(loginDataPath))) {
    return { records: [], skipped: 0, failed: 0 };
  }
  if (platform !== "win32") {
    options.logger.warn("[browser-data] 密码导入暂只支持 Windows DPAPI", { platform });
    return { records: [], skipped: 0, failed: 0 };
  }
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-browser-passwords-"));
  const snapshotPath = join(tempDir, "Login Data.sqlite");
  try {
    await copyFile(loginDataPath, snapshotPath);
    const database = new DatabaseSync(snapshotPath, { readOnly: true });
    let rows: ChromeLoginRow[];
    try {
      rows = database
        .prepare(
          "SELECT origin_url, action_url, username_element, username_value, password_element, password_value, signon_realm, blacklisted_by_user, times_used FROM logins WHERE blacklisted_by_user = 0",
        )
        .all() as unknown as ChromeLoginRow[];
    } finally {
      database.close();
    }

    let v10Key: Buffer | null = null;
    let v20Key: Buffer | null = null;
    const records: ChromePasswordRecord[] = [];
    let skipped = 0;
    let failed = 0;
    try {
      for (const row of rows) {
        if (!row.password_value || row.password_value.length === 0) {
          skipped += 1;
          continue;
        }
        if (!row.signon_realm.startsWith("https://") && !row.signon_realm.startsWith("http://")) {
          skipped += 1;
          continue;
        }
        const prefix = Buffer.from(row.password_value).subarray(0, 3).toString("ascii");
        try {
          let password: string;
          if (prefix === "v20") {
            if (!options.allowElevated || !options.chromeExecutablePath) {
              // App-Bound 密码与 Cookie 同墙：没有本次 UAC 或 Chrome 路径就解
              // 不了，按跳过计（issues 可见，不算失败）。
              skipped += 1;
              continue;
            }
            v20Key ??= await (options.windowsChromeAppBoundKeyReader ??
              readWindowsChromeAppBoundKey)({
              chromeExecutablePath: options.chromeExecutablePath,
              logger: options.logger,
              userDataDir: options.userDataDir,
            });
            password = decryptAesGcm(row.password_value, v20Key, "v20");
          } else {
            v10Key ??= await readWindowsChromeMasterKey(options.userDataDir);
            password = decryptAesGcm(row.password_value, v10Key, "v10");
          }
          if (!password) {
            skipped += 1;
            continue;
          }
          records.push({
            originUrl: row.origin_url,
            signonRealm: row.signon_realm,
            username: row.username_value ?? "",
            password,
          });
        } catch {
          failed += 1;
        }
      }
    } finally {
      v10Key?.fill(0);
      v20Key?.fill(0);
    }
    options.logger.info("[browser-data] Chrome 密码快照读取完成", {
      sourceCount: rows.length,
      decryptedCount: records.length,
    });
    return { records, skipped, failed };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface PasswordTargetSession {
  passwords?: {
    add(record: {
      originUrl: string;
      signonRealm: string;
      username: string;
      password: string;
    }): Promise<void>;
  };
}

/**
 * 密码写入 Electron 会话。Electron 的 password manager 走 Autofill 凭据存储；
 * 当前 Electron няма stable 的 passwords.add API——写入经 CDP Autofill 域进
 * 目标 session 的 LoginDatabase（与 Chrome 同 SQLite 形态，DPAPI 同机可读）。
 * 若目标 session 不支持，直接返回 unsupported（上层报 issues，不静默吞）。
 */
export async function writeChromePasswordsToSession(options: {
  logger: BrowserDataLogger;
  records: ChromePasswordRecord[];
  targetSession: PasswordTargetSession & {
    addPasswordRecord?: (record: ChromePasswordRecord) => Promise<void>;
  };
}): Promise<ChromePasswordImportStats> {
  const writer = options.targetSession.addPasswordRecord ?? options.targetSession.passwords?.add;
  if (!writer) {
    options.logger.warn("[browser-data] 目标会话不支持密码写入，跳过");
    return { imported: 0, skipped: options.records.length, failed: 0 };
  }
  let imported = 0;
  let failed = 0;
  for (const record of options.records) {
    try {
      if (typeof options.targetSession.addPasswordRecord === "function") {
        await options.targetSession.addPasswordRecord(record);
      } else {
        await options.targetSession.passwords!.add(record);
      }
      imported += 1;
    } catch {
      failed += 1;
    } finally {
      // 明文密码只在写入调用栈存活，不在日志/结果里留痕。
      record.password = "";
    }
  }
  return { imported, skipped: 0, failed };
}

export async function importChromePasswords(options: {
  allowElevated?: boolean;
  chromeExecutablePath?: string;
  logger: BrowserDataLogger;
  platform?: NodeJS.Platform;
  profilePath: string;
  targetSession: PasswordTargetSession & {
    addPasswordRecord?: (record: ChromePasswordRecord) => Promise<void>;
  };
  userDataDir: string;
  windowsChromeAppBoundKeyReader?: WindowsChromeAppBoundKeyReader;
}): Promise<ChromePasswordImportStats> {
  // 密码阶段绝不能掀翻整个导入：DPAPI 失败、库被锁、master key 缺失——
  // 一律记 failed/skipped 返回。调用方（browserDataManager）不 try/catch 这里。
  try {
    const { records, skipped, failed } = await readChromePasswords({
      allowElevated: options.allowElevated,
      chromeExecutablePath: options.chromeExecutablePath,
      logger: options.logger,
      platform: options.platform,
      profilePath: options.profilePath,
      userDataDir: options.userDataDir,
      windowsChromeAppBoundKeyReader: options.windowsChromeAppBoundKeyReader,
    });
    if (records.length === 0) return { imported: 0, skipped, failed };
    const written = await writeChromePasswordsToSession({
      logger: options.logger,
      records,
      targetSession: options.targetSession,
    });
    return { imported: written.imported, skipped: skipped + written.skipped, failed: failed + written.failed };
  } catch (error) {
    options.logger.warn(
      "[browser-data] Chrome 密码阶段失败，已降级为跳过",
      error instanceof Error ? { name: error.name, message: error.message.slice(0, 120) } : {},
    );
    return { imported: 0, skipped: 0, failed: 1 };
  }
}
