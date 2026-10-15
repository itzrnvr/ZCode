// Prompt override files: let users edit system-prompt section overrides in an
// external editor (VS Code et al). The renderer exports the effective text to a
// stable per-section file; a watcher here picks up external saves and writes
// them back into settings, then broadcasts SettingsChanged so every window
// refreshes its snapshot (same convention as the shortcut rebinding broadcast).
import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type { ISettingService } from "@zcode/services/setting/setting.js";

const OVERRIDE_DIR_NAME = "prompt-overrides";
const MAX_OVERRIDE_CHARS = 20000;

interface ExportPayload {
  fileKey: string;
  fileName: string;
  content: string;
}

/** fileKey → the settings patch the file content maps to. */
function patchForFileKey(
  fileKey: string,
  content: string,
  current: { systemPromptSectionTexts?: Record<string, string> },
): Partial<{
  systemPromptSectionTexts: Record<string, string>;
  systemPromptSecurityNoticeText: string;
  systemPromptCustomText: string;
}> | null {
  if (fileKey.startsWith("section-")) {
    const sectionKey = fileKey.slice("section-".length);
    const next = { ...(current.systemPromptSectionTexts ?? {}) };
    if (content.trim()) {
      next[sectionKey] = content;
    } else {
      // 空文件 = 清除覆盖，恢复内置文本（与设置页的「恢复默认」同语义）。
      delete next[sectionKey];
    }
    return { systemPromptSectionTexts: next };
  }
  if (fileKey === "security-notice") {
    return { systemPromptSecurityNoticeText: content };
  }
  if (fileKey === "custom-prompt") {
    return { systemPromptCustomText: content };
  }
  return null;
}

function safeName(fileKey: string): string | null {
  return /^[a-z0-9-]{1,64}$/i.test(fileKey) ? fileKey : null;
}

function safeFileName(fileName: string): string | null {
  return /^[a-z0-9-]{1,64}\.md$/i.test(fileName) ? fileName : null;
}

export function registerPromptOverrideIpc(options: {
  getSettingService: () => ISettingService | undefined;
  broadcastSettingsChanged: () => void;
  logger: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
  userDataPath: string;
}): void {
  const dir = join(options.userDataPath, OVERRIDE_DIR_NAME);
  // 自己导出文件也会触发 watcher；记录每次导出的内容，回声不写回设置。
  const lastExportedContent = new Map<string, string>();
  let watcher: FSWatcher | null = null;
  let watchTimer: NodeJS.Timeout | null = null;
  let watchPendingName = "";

  const applyExternalChange = async (fileName: string): Promise<void> => {
    const fileKey = fileName.replace(/\.md$/i, "");
    const filePath = join(dir, fileName);
    if (!existsSync(filePath)) return;
    const content = await readFile(filePath, "utf-8");
    if (content === lastExportedContent.get(fileKey)) return; // 导出回声
    if (content.length > MAX_OVERRIDE_CHARS) {
      options.logger.warn("[prompt-overrides] external edit exceeds 20000 chars, ignored", {
        fileKey,
        length: content.length,
      });
      return;
    }
    const settingService = options.getSettingService();
    if (!settingService) return;
    const settings = await settingService.get();
    const patch = patchForFileKey(fileKey, content, settings);
    if (!patch) return;
    await settingService.update(patch);
    lastExportedContent.set(fileKey, content);
    options.logger.info("[prompt-overrides] external edit applied", { fileKey });
    options.broadcastSettingsChanged();
  };

  const ensureWatcher = (): void => {
    if (watcher) return;
    try {
      watcher = watch(dir, { persistent: false }, (_event, fileName) => {
        const name = typeof fileName === "string" ? fileName : "";
        if (!name.endsWith(".md")) return;
        watchPendingName = name;
        clearTimeout(watchTimer);
        // VS Code 保存会连发多个事件；去抖 400ms 后按最后状态应用一次。
        watchTimer = setTimeout(() => {
          watchTimer = null;
          void applyExternalChange(watchPendingName);
        }, 400);
      });
    } catch (error) {
      options.logger.warn("[prompt-overrides] watch failed", error);
    }
  };

  ipcMain.handle(
    PlatformChannels.ExportPromptOverrideToFile,
    async (_event, value: unknown): Promise<{ path: string } | { success: false; error: string }> => {
      try {
        const payload = value as Partial<ExportPayload> | undefined;
        // fileName 携带 .md 扩展名；fileKey 必须与去掉扩展名后的 fileName 完全一致，
        // 防止两个输入各自合法却指向不同文件。
        const fileName = safeFileName(String(payload?.fileName ?? ""));
        const fileKey = safeName(String(payload?.fileKey ?? ""));
        const expectedFileKey = fileName ? fileName.replace(/\.md$/i, "") : null;
        if (!fileKey || !fileName || !expectedFileKey || fileKey !== expectedFileKey) {
          return { success: false, error: "invalid_file_key" };
        }
        const content = typeof payload?.content === "string" ? payload.content : "";
        if (content.length > MAX_OVERRIDE_CHARS) {
          return { success: false, error: "content_too_long" };
        }
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const filePath = join(dir, `${fileKey}.md`);
        await writeFile(filePath, content, "utf-8");
        lastExportedContent.set(fileKey, content);
        ensureWatcher();
        return { path: filePath };
      } catch (error) {
        options.logger.warn("[prompt-overrides] export failed", {
          message: error instanceof Error ? error.message : String(error),
          code: (error as NodeJS.ErrnoException | null)?.code ?? null,
          dir,
        });
        return { success: false, error: "export_failed" };
      }
    },
  );
}
