import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { Theme } from "@/useTheme.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow, ThemeSelect } from "@/settings/SettingsPageParts.js";
import { AppearanceColorRow, UI_COLOR_LABEL_IDS } from "@/settings/AppearanceColorRow.js";
import { AppearanceCodePreviewStrip } from "@/settings/AppearanceCodePreviewStrip.js";
import { AppearanceThemeCards } from "@/settings/AppearanceThemeCards.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { UI_COLOR_FIELDS, type UiColorField, type UiColors } from "@/lib/uiColors.js";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "@/lib/uiFontSize.js";

const MIN_CODE_FONT_SIZE_PX = 12;
const MAX_CODE_FONT_SIZE_PX = 20;

function FontSizeInput({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const nextValue = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.round(parsed)))
      : value;
    setDraft(String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  return (
    <div className="relative w-28">
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
        className="pr-8 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ui-lg text-foreground-subtle">
        px
      </span>
    </div>
  );
}

/** 设置分组：弱化的小标题压在卡片之上，与参考图的分组节奏一致。 */
function AppearanceGroup({ titleId, children }: { titleId: string; children: ReactNode }) {
  const { intl } = useZCodeIntl();

  return (
    <section className="min-w-0 space-y-3">
      <h3 className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: titleId })}
      </h3>
      {children}
    </section>
  );
}

export function AppearanceSectionContent({
  codePreviewSettings,
  setCodePreviewSettings,
  theme,
  setTheme,
  uiFontSizePx,
  setUiFontSizePx,
}: {
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (settings: Partial<CodePreviewSettings>) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const uiColors = useZCodeStore((state) => state.uiColors);
  const setUiColors = useZCodeStore((state) => state.setUiColors);
  const pointerCursors = useZCodeStore((state) => state.pointerCursors);
  const setPointerCursors = useZCodeStore((state) => state.setPointerCursors);
  const hasColorOverrides = UI_COLOR_FIELDS.some((field) => Boolean(uiColors[field]));

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
    <>
      <AppearanceGroup titleId="settings.appearance.themeGroupTitle">
        <AppearanceThemeCards theme={theme} onThemeChange={setTheme} />
        <AppearanceCodePreviewStrip settings={codePreviewSettings} />
      </AppearanceGroup>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.darkTheme" })}
          control={
            <ThemeSelect
              value={codePreviewSettings.darkTheme}
              onValueChange={(value) => setCodePreviewSettings({ darkTheme: value })}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.lightTheme" })}
          control={
            <ThemeSelect
              value={codePreviewSettings.lightTheme}
              onValueChange={(value) => setCodePreviewSettings({ lightTheme: value })}
            />
          }
        />
        {UI_COLOR_FIELDS.map((field) => (
          // 只按字段做 key：草稿由取色器内部的 value 同步处理，
          // 若把当前色也编进 key，每次取色都会重挂载并关掉弹出的取色器。
          <SettingsRow
            key={field}
            label={intl.formatMessage({ id: UI_COLOR_LABEL_IDS[field] })}
            control={
              <AppearanceColorRow
                field={field}
                value={uiColors[field]}
                onChange={(color) => updateColor(field, color)}
              />
            }
          />
        ))}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.uiFontSize" })}
          control={
            <FontSizeInput
              key={uiFontSizePx}
              min={MIN_UI_FONT_SIZE_PX}
              max={MAX_UI_FONT_SIZE_PX}
              value={uiFontSizePx}
              onChange={setUiFontSizePx}
              ariaLabel={intl.formatMessage({ id: "settings.uiFontSize" })}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.fontSize" })}
          control={
            <FontSizeInput
              key={codePreviewSettings.fontSizePx}
              min={MIN_CODE_FONT_SIZE_PX}
              max={MAX_CODE_FONT_SIZE_PX}
              value={codePreviewSettings.fontSizePx}
              onChange={(fontSizePx) => setCodePreviewSettings({ fontSizePx })}
              ariaLabel={intl.formatMessage({ id: "settings.fontSize" })}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.showLineNumbers" })}
          control={
            <Switch
              checked={codePreviewSettings.showLineNumbers}
              aria-label={intl.formatMessage({ id: "settings.showLineNumbers" })}
              onCheckedChange={(checked) => setCodePreviewSettings({ showLineNumbers: checked })}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.wrapLongLines" })}
          control={
            <Switch
              checked={codePreviewSettings.wrapLongLines}
              aria-label={intl.formatMessage({ id: "settings.wrapLongLines" })}
              onCheckedChange={(checked) => setCodePreviewSettings({ wrapLongLines: checked })}
            />
          }
        />
        <div className="flex items-center justify-end border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasColorOverrides}
            onClick={() => setUiColors({})}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.appearance.colors.resetAll" })}
          </Button>
        </div>
      </SettingsGroupCard>

      <AppearanceGroup titleId="settings.appearance.preferencesTitle">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.appearance.usePointerCursors" })}
            control={
              <Switch
                checked={pointerCursors}
                aria-label={intl.formatMessage({
                  id: "settings.appearance.usePointerCursors",
                })}
                onCheckedChange={setPointerCursors}
              />
            }
          />
        </SettingsGroupCard>
      </AppearanceGroup>
    </>
  );
}
