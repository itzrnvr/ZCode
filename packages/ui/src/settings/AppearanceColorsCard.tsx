import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  normalizeUiColor,
  UI_COLOR_FIELDS,
  UI_COLOR_TOKENS,
  type UiColorField,
  type UiColors,
} from "@/lib/uiColors.js";

const COLOR_LABEL_IDS: Record<UiColorField, string> = {
  accent: "settings.appearance.colors.accent",
  background: "settings.appearance.colors.background",
  sidebar: "settings.appearance.colors.sidebar",
  card: "settings.appearance.colors.card",
};

/** 每个 Token 只给常用色板，避免设置页变成全功能取色器。 */
const COLOR_PRESETS: Record<UiColorField, readonly string[]> = {
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
  sidebar: ["#ffffff", "#f8f8f8", "#f0f0f0", "#161616", "#202020", "#2b2b2b", "#0f172a"],
  card: ["#ffffff", "#fafafa", "#f5f5f5", "#1e1e1e", "#202020", "#2b2b2b", "#111827"],
};

/**
 * 单行颜色控制：色板弹层 + 十六进制输入 + 重置。
 * 色块背景直接用 Token 变量渲染，因此始终展示当前生效色（含主题默认值），无需读取计算样式。
 */
function AppearanceColorRow({
  field,
  value,
  presets,
  onChange,
}: {
  field: UiColorField;
  value: string | undefined;
  presets: readonly string[];
  onChange: (color: string | undefined) => void;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(value ?? "");
  const [presetOpen, setPresetOpen] = useState(false);
  const label = intl.formatMessage({ id: COLOR_LABEL_IDS[field] });
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
    <SettingsRow
      label={label}
      control={
        <div className="flex items-center gap-1.5">
          <Popover open={presetOpen} onOpenChange={setPresetOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={intl.formatMessage(
                  { id: "settings.appearance.colors.selectPreset" },
                  { name: label },
                )}
                className="size-6 shrink-0 rounded-full border border-border transition-shadow hover:ring-2 hover:ring-brand"
                style={{ backgroundColor: `var(${UI_COLOR_TOKENS[field]})` }}
              />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto gap-2 p-2.5">
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
                      "size-6 rounded-full border border-border transition-shadow",
                      value === preset && "ring-2 ring-brand ring-offset-1 ring-offset-panel",
                    )}
                    style={{ backgroundColor: preset }}
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>
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
            className="w-24 font-mono"
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
      }
    />
  );
}

export function AppearanceColorsCard() {
  const { intl } = useZCodeIntl();
  const uiColors = useZCodeStore((state) => state.uiColors);
  const setUiColors = useZCodeStore((state) => state.setUiColors);
  const hasOverrides = UI_COLOR_FIELDS.some((field) => Boolean(uiColors[field]));

  const updateColor = (field: UiColorField, color: string | undefined) => {
    const nextColors: UiColors = { ...uiColors };
    if (color) {
      nextColors[field] = color;
    } else {
      delete nextColors[field];
    }

    // setter 是整体替换：重置字段也会随广播同步到其他窗口。
    setUiColors(nextColors);
  };

  return (
    <Card className="border border-border bg-card py-0 shadow-none">
      <CardContent className="space-y-0 px-0">
        {UI_COLOR_FIELDS.map((field) => (
          // key 带当前值：外部（广播 / 重置）改动后重建本地草稿，避免残留未提交输入。
          <AppearanceColorRow
            key={`${field}:${uiColors[field] ?? ""}`}
            field={field}
            value={uiColors[field]}
            presets={COLOR_PRESETS[field]}
            onChange={(color) => updateColor(field, color)}
          />
        ))}
        <div className="flex items-center justify-end border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasOverrides}
            onClick={() => setUiColors({})}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.appearance.colors.resetAll" })}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
