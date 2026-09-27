import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  normalizeUiColor,
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

/** 每个 Token 只给常用色板，避免设置页变成全功能取色器。 */
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
 * 点击展开色板 + 十六进制输入 + 重置，控制列保持一行宽。
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
  const [draft, setDraft] = useState(value ?? "");
  const [presetOpen, setPresetOpen] = useState(false);
  const label = intl.formatMessage({ id: UI_COLOR_LABEL_IDS[field] });
  const presets = UI_COLOR_PRESETS[field];
  const draftInvalid = draft.trim() !== "" && !normalizeUiColor(draft);

  const clear = () => {
    setDraft("");
    onChange(undefined);
  };

  const commit = () => {
    if (draft.trim() === "") {
      clear();
      return;
    }

    const color = normalizeUiColor(draft);
    if (!color) {
      // 非法输入直接丢弃，回退到当前生效值。
      setDraft(value ?? "");
      return;
    }

    setDraft(color);
    if (color !== value) {
      onChange(color);
    }
  };

  return (
    <Popover open={presetOpen} onOpenChange={setPresetOpen}>
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
      <PopoverContent align="end" className="w-auto gap-2.5 p-2.5">
        <PopoverTitle>
          {intl.formatMessage({ id: "settings.appearance.colors.presets" })}
        </PopoverTitle>
        <div
          role="group"
          aria-label={intl.formatMessage({ id: "settings.appearance.colors.presets" })}
          className="grid grid-cols-4 gap-1.5"
        >
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-label={preset}
              aria-pressed={value === preset}
              onClick={() => {
                setDraft(preset);
                onChange(preset);
                setPresetOpen(false);
              }}
              className={cn(
                "size-6 cursor-pointer rounded-full border border-border transition-shadow",
                value === preset && "ring-2 ring-brand ring-offset-1 ring-offset-panel",
              )}
              style={{ backgroundColor: preset }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            size="sm"
            spellCheck={false}
            autoComplete="off"
            placeholder={intl.formatMessage({ id: "settings.appearance.colors.hexPlaceholder" })}
            aria-label={label}
            aria-invalid={draftInvalid || undefined}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft(value ?? "");
              }
            }}
            className="w-28 font-mono"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!value}
            aria-label={intl.formatMessage(
              { id: "settings.appearance.colors.resetField" },
              { name: label },
            )}
            onClick={clear}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
