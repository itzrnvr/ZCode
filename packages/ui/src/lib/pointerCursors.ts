import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

export const POINTER_CURSORS_STORAGE_KEY = "zcode-pointer-cursors";

/** 关闭时写在根节点的标记，styles.css 依据它把可点击元素的光标回落到默认箭头。 */
const POINTER_CURSORS_ATTRIBUTE = "data-pointer-cursors";
const POINTER_CURSORS_DISABLED_VALUE = "off";

/** 默认开启：与既有行为一致，未设置过的用户不会看到光标变化。 */
const DEFAULT_POINTER_CURSORS = true;

export function normalizePointerCursors(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "false") {
    return false;
  }

  if (value === "true") {
    return true;
  }

  return DEFAULT_POINTER_CURSORS;
}

export function loadPointerCursors(): boolean {
  const rawValue = readSafeLocalStorage(POINTER_CURSORS_STORAGE_KEY);
  return rawValue === null ? DEFAULT_POINTER_CURSORS : normalizePointerCursors(rawValue);
}

/** 归一化 + 持久化 + 立即应用；返回最终生效的取值。 */
export function writePointerCursors(next: unknown): boolean {
  const normalized = normalizePointerCursors(next);
  writeSafeLocalStorage(POINTER_CURSORS_STORAGE_KEY, String(normalized));
  applyPointerCursors(normalized);
  return normalized;
}

export function applyPointerCursors(enabled: boolean): void {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  if (!root?.setAttribute || !root.removeAttribute) {
    return;
  }

  if (normalizePointerCursors(enabled)) {
    root.removeAttribute(POINTER_CURSORS_ATTRIBUTE);
    return;
  }

  root.setAttribute(POINTER_CURSORS_ATTRIBUTE, POINTER_CURSORS_DISABLED_VALUE);
}

export function subscribeToPointerCursorsStorageChanges(): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== POINTER_CURSORS_STORAGE_KEY) {
      return;
    }

    applyPointerCursors(loadPointerCursors());
  };

  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
