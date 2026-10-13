import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  buildStandardChromeInstallations,
  parseRunningChromeInstallations,
  type ChromeInstallationCandidate,
} from "./chromeInstallationCandidates.js";
import { readRunningChromeProcessCommandLines } from "./chromeExecutableDiscovery.js";

export interface ChromeImportableProfile {
  browser: "chrome" | "chromium" | "edge" | "brave";
  executablePath?: string;
  passwordStore?: string;
  profileDirectory: string;
  profilePath: string;
  /** History 文件的修改时间（ms）；全量导入用它挑书签/历史的代表 Profile。 */
  historyModifiedAt: number;
  userDataDir: string;
}

interface ChromeLocalStateProfileInfo {
  profile?: {
    info_cache?: Record<string, { name?: string }>;
    last_used?: string;
  };
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function listProfileDirectories(userDataDir: string): Promise<string[]> {
  let localState: ChromeLocalStateProfileInfo = {};
  try {
    localState = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf8")) as ChromeLocalStateProfileInfo;
  } catch {
    // Local State 不可读时退回目录扫描。
  }
  const names = new Set<string>(Object.keys(localState.profile?.info_cache ?? {}));
  names.add("Default");
  // 目录扫描兜底：Profile 1 / Profile 2 …（info_cache 缺项时仍能找到）。
// readdir 已在顶部静态导入。
  try {
    for (const entry of await readdir(userDataDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name)) {
        names.add(entry.name);
      }
    }
  } catch {
    // userDataDir 不可读：names 保持 info_cache + Default。
  }
  return [...names].sort();
}

async function hasImportableData(profilePath: string): Promise<boolean> {
  for (const candidate of [
    join(profilePath, "Network", "Cookies"),
    join(profilePath, "Cookies"),
    join(profilePath, "Login Data"),
    join(profilePath, "Local Storage", "leveldb"),
    join(profilePath, "History"),
  ]) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

async function historyModifiedAt(profilePath: string): Promise<number> {
  try {
    return (await stat(join(profilePath, "History"))).mtimeMs;
  } catch {
    return 0;
  }
}

function dedupeInstallations(installations: ChromeInstallationCandidate[]): ChromeInstallationCandidate[] {
  const seen = new Set<string>();
  const result: ChromeInstallationCandidate[] = [];
  for (const installation of installations) {
    const userDataDir = installation.userDataDir.trim();
    if (!userDataDir || seen.has(userDataDir)) continue;
    seen.add(userDataDir);
    result.push({ ...installation, userDataDir });
  }
  return result;
}

/** 枚举一个 Chrome 安装下所有可导入 Profile；找不到任何数据时返回空数组。 */
export async function discoverChromeImportableProfiles(options: {
  platform?: NodeJS.Platform;
}): Promise<ChromeImportableProfile[]> {
  const platform = options.platform ?? process.platform;
  const standardInstallations = buildStandardChromeInstallations({ platform });
  const commandLines = await readRunningChromeProcessCommandLines(platform);
  const runningInstallations = parseRunningChromeInstallations(commandLines, []);
  const installations = dedupeInstallations([...runningInstallations, ...standardInstallations]);

  for (const installation of installations) {
    if (!(await pathExists(installation.userDataDir))) continue;
    const profiles: ChromeImportableProfile[] = [];
    let executablePath = installation.executablePath;
    for (const directory of await listProfileDirectories(installation.userDataDir)) {
      const profilePath = join(installation.userDataDir, directory);
      if (!(await hasImportableData(profilePath))) continue;
      if (!executablePath) {
        // 逐个 candidate 找存在的可执行文件（resolveFirstExistingPath 在
        // chromeProfileDiscovery 内部，这里就地等价实现，避免导出私有函数）。
        for (const candidate of installation.executablePaths) {
          if (await pathExists(candidate)) {
            executablePath = candidate;
            break;
          }
        }
      }
      profiles.push({
        browser: installation.browser,
        ...(executablePath ? { executablePath } : {}),
        ...(installation.passwordStore ? { passwordStore: installation.passwordStore } : {}),
        profileDirectory: directory,
        profilePath,
        historyModifiedAt: await historyModifiedAt(profilePath),
        userDataDir: installation.userDataDir,
      });
    }
    if (profiles.length > 0) return profiles;
  }
  return [];
}
