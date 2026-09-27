import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

export const UI_COLORS_STORAGE_KEY = "zcode-ui-colors";

/**
 * 可自定义的颜色字段 -> 根节点 Token。
 * 覆盖值以内联变量写在 documentElement 上，优先级高于任何主题 class，
 * 因此切换主题后覆盖仍然生效，清空后立即回落到当前主题默认值。
 */
export const UI_COLOR_TOKENS = {
  accent: "--color-brand",
  background: "--color-background",
  foreground: "--color-foreground",
  sidebar: "--color-sidebar",
  card: "--color-card",
} as const;

export type UiColorField = keyof typeof UI_COLOR_TOKENS;

/** 只保存用户显式覆盖的字段，缺省字段跟随主题。 */
export type UiColors = Partial<Record<UiColorField, string>>;

export const UI_COLOR_FIELDS = Object.keys(UI_COLOR_TOKENS) as UiColorField[];

// 只接受 #RGB / #RRGGBB；其余写法（命名色、rgb()、渐变）一律视为非法输入被忽略。
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

export function normalizeUiColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return HEX_COLOR_PATTERN.test(normalized) ? normalized : undefined;
}

export function normalizeUiColors(value: unknown): UiColors {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const colors: UiColors = {};
  for (const field of UI_COLOR_FIELDS) {
    const color = normalizeUiColor(record[field]);
    if (color) {
      colors[field] = color;
    }
  }

  return colors;
}

export function loadUiColors(): UiColors {
  const rawValue = readSafeLocalStorage(UI_COLORS_STORAGE_KEY);
  if (!rawValue) {
    return {};
  }

  try {
    return normalizeUiColors(JSON.parse(rawValue));
  } catch {
    return {};
  }
}

/**
 * 归一化 + 持久化 + 立即应用到根节点；整体替换而非合并，
 * 这样清空（重置）字段也能写入存储并广播出去。
 */
export function writeUiColors(next: unknown): UiColors {
  const normalized = normalizeUiColors(next);
  writeSafeLocalStorage(UI_COLORS_STORAGE_KEY, JSON.stringify(normalized));
  applyUiColors(normalized);
  return normalized;
}

export function applyUiColors(colors: UiColors): void {
  const rootStyle = typeof document === "undefined" ? undefined : document.documentElement?.style;
  if (!rootStyle?.setProperty) {
    return;
  }

  const normalizedColors = normalizeUiColors(colors);
  for (const field of UI_COLOR_FIELDS) {
    const token = UI_COLOR_TOKENS[field];
    const color = normalizedColors[field];
    if (color) {
      rootStyle.setProperty(token, color);
      continue;
    }

    // 未覆盖或已重置的字段必须移除内联变量，否则主题默认色不会回来。
    rootStyle.removeProperty(token);
  }
}

export function subscribeToUiColorsStorageChanges(): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== UI_COLORS_STORAGE_KEY) {
      return;
    }

    applyUiColors(loadUiColors());
  };

  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
