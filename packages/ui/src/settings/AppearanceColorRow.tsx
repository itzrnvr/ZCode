import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ColorPicker } from "@/settings/ColorPicker.js";
import {
  normalizeUiColor,
  readUiColorToken,
  UI_COLOR_TOKENS,
  type UiColorField,
} from "@/lib/uiColors.js";

export const UI_COLOR_LABEL_IDS: Record<UiColorField, string> = {
  accent: "settings.appearance.colors.accent",
  background: "settings.appearance.colors.background",
  foreground: "settings.appearance.colors.foreground",
  sidebar: "settings.appearance.colors.sidebar",
  card: "settings.appearance.colors.card",
};

/** 每个 Token 的常用色板；取色器负责其余任意色。 */
export const UI_COLOR_PRESETS: Record<UiColorField, readonly string[]> = {
  accent: [
    "#3b82f6",
    "#6366f1",
    "#8b5cf6",
    "#ec4899",
    "#ef4444",
    "#f59e0b",
    "#10b981",
    "#14b8a6",
  ],
  background: ["#ffffff", "#f8fafc", "#f1f5f9", "#161616", "#1e293b", "#0f172a", "#000000"],
  foreground: ["#000000", "#0d0d0d", "#1f2937", "#334155", "#64748b", "#e5e7eb", "#ffffff"],
  sidebar: ["#ffffff", "#f8f8f8", "#f0f0f0", "#161616", "#202020", "#2b2b2b", "#0f172a"],
  card: ["#ffffff", "#fafafa", "#f5f5f5", "#1e1e1e", "#202020", "#2b2b2b", "#111827"],
};

/**
 * 单行颜色控制：色块即当前生效色（直接读 Token 变量，含主题默认值），
 * 点击展开取色器（SV 面板 + 色相 + 十六进制 + 吸管 + 预设 + 重置）。
 */
export function AppearanceColorRow({
  field,
  value,
  onChange,
}: {
  field: UiColorField;
  value: string | undefined;
  onChange: (color: string | undefined) => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [effective, setEffective] = useState(() => value ?? "");
  const label = intl.formatMessage({ id: UI_COLOR_LABEL_IDS[field] });

  // 没有覆盖值时取色器以主题解析色为起点：打开时读一次 Token 计算值。
  useEffect(() => {
    if (!open) {
      return;
    }
    setEffective(value ?? readUiColorToken(field));
  }, [field, open, value]);

  const pick = (color: string) => {
    setEffective(normalizeUiColor(color) ?? color);
    onChange(color);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage(
            { id: "settings.appearance.colors.selectPreset" },
            { name: label },
          )}
          className="flex h-7 max-w-full cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-2.5 transition-colors hover:border-border-hover"
        >
          <span
            aria-hidden="true"
            className="size-4 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: `var(${UI_COLOR_TOKENS[field]})` }}
          />
          <span className="truncate font-mono text-ui-xs text-foreground-subtle">
            {value ?? intl.formatMessage({ id: "settings.appearance.colors.themeDefault" })}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[252px] gap-2 p-2.5">
        <ColorPicker
          label={label}
          value={effective}
          presets={UI_COLOR_PRESETS[field]}
          onChange={pick}
          onReset={() => {
            setEffective(readUiColorToken(field));
            onChange(undefined);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
