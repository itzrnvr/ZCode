// ============================================================
// Cross-window state broadcast: field registry + inbound dispatch
// ============================================================
//
// 抽出来的原因：store/index.ts 已贴到 oxlint max-lines 上限，而这段逻辑
// （频道常量、字段表、入站分发）与 store 的其它部分没有耦合，只是"把广播
// 负载映射回对应的 setter"。store 负责订阅/监听与生命周期，这里负责映射。

import type { BroadcastMessage } from "@zcode/services";
import type { Theme } from "@/useTheme.js";
import type { UiColors } from "@/lib/uiColors.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import { normalizePointerCursors } from "@/lib/pointerCursors.js";

/** 广播频道名前缀 */
export const STATE_CHANNEL_PREFIX = "state:";

const BROADCAST_FIELDS = [
  "theme",
  "locale",
  "uiFontSizePx",
  "uiColors",
  "pointerCursors",
  "interfaceMode",
] as const;

export type BroadcastField = (typeof BROADCAST_FIELDS)[number];

/** 出站：需要跨窗口同步的字段（数组顺序即声明顺序）。 */
export const BROADCAST_STATE_FIELDS = BROADCAST_FIELDS;

export function isBroadcastField(value: string): value is BroadcastField {
  return (BROADCAST_FIELDS as readonly string[]).includes(value);
}

/** store 侧入站分发依赖的最小接口面。 */
export interface BroadcastFieldSetters {
  setInterfaceMode: (mode: ReturnType<typeof normalizeInterfaceMode>) => void;
  setLocale: (locale: string) => void;
  setPointerCursors: (enabled: ReturnType<typeof normalizePointerCursors>) => void;
  setTheme: (theme: Theme) => void;
  setUiColors: (colors: UiColors) => void;
  setUiFontSizePx: (fontSizePx: number) => void;
}

/**
 * 把一条广播负载写回 store。调用方负责围绕它设置 `applyingBroadcast`，
 * 避免本地 set 触发再次广播形成回声。
 */
export function applyBroadcastField(
  setters: BroadcastFieldSetters,
  field: BroadcastField,
  payload: unknown,
): void {
  if (field === "theme" && typeof payload === "string") {
    setters.setTheme(payload as Theme);
    return;
  }
  if (field === "locale" && typeof payload === "string") {
    setters.setLocale(payload);
    return;
  }
  if (field === "interfaceMode" && (payload === "office" || payload === "coding")) {
    setters.setInterfaceMode(normalizeInterfaceMode(payload));
    return;
  }
  if (field === "uiFontSizePx" && typeof payload === "number") {
    setters.setUiFontSizePx(payload);
    return;
  }
  if (field === "uiColors") {
    setters.setUiColors((payload ?? {}) as UiColors);
    return;
  }
  if (field === "pointerCursors") {
    setters.setPointerCursors(normalizePointerCursors(payload));
  }
}

/** 入站消息的频道解析：非状态频道返回 null。 */
export function broadcastFieldOfMessage(msg: BroadcastMessage): BroadcastField | null {
  if (!msg.channel.startsWith(STATE_CHANNEL_PREFIX)) {
    return null;
  }
  const field = msg.channel.slice(STATE_CHANNEL_PREFIX.length);
  return isBroadcastField(field) ? field : null;
}
