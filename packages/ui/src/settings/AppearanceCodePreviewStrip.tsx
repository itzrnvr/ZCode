import type { CSSProperties } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getCodePreviewTheme,
  SETTINGS_PREVIEW_CODE_DARK,
  SETTINGS_PREVIEW_CODE_LIGHT,
} from "@/lib/codePreviewPreferences.js";
import { getThemeOptionLabel } from "@/settings/SettingsPageParts.js";
import type { CodePreviewSettings } from "@/store/index.js";

/**
 * 预览面板固定成目标主题的底色，避免跟随当前应用主题：
 * @pierre/diffs 会把代码背景映射到 card，所以这里同时固定 background/card/foreground。
 */
function previewSurfaceStyle(mode: "light" | "dark"): CSSProperties {
  return {
    "--color-background": mode === "light" ? "#f8f8f8" : "#161616",
    "--color-card": mode === "light" ? "#f8f8f8" : "#161616",
    "--color-foreground": mode === "light" ? "#0d0d0d" : "#ffffff",
  } as CSSProperties;
}

/**
 * 外观设置里的代码预览条：左右两块面板展示同一份配置的浅色/深色取值，
 * 配色完全复用用户的代码主题设置，因此调整下方主题行会立即反映到这里。
 */
export function AppearanceCodePreviewStrip({ settings }: { settings: CodePreviewSettings }) {
  const { intl } = useZCodeIntl();
  const previewHeightPx = Math.round(settings.fontSizePx * 6);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(["light", "dark"] as const).map((mode) => (
        <div key={mode} className="overflow-hidden rounded-xl border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <span className="text-ui-sm font-medium text-foreground-subtle">
              {intl.formatMessage({
                id: mode === "light" ? "settings.previewLight" : "settings.previewDark",
              })}
            </span>
            <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
              {getThemeOptionLabel(getCodePreviewTheme(mode, settings))}
            </span>
          </div>
          <div className="relative">
            {/* 左侧色条标记两侧面板：浅色面板红、深色面板绿，与参考图一致。 */}
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0 left-0 z-10 w-[3px]",
                mode === "light" ? "bg-destructive" : "bg-success",
              )}
            />
            <CodeBlock
              code={mode === "light" ? SETTINGS_PREVIEW_CODE_LIGHT : SETTINGS_PREVIEW_CODE_DARK}
              language="typescript"
              theme={getCodePreviewTheme(mode, settings)}
              showLineNumbers={settings.showLineNumbers}
              wrapLongLines={settings.wrapLongLines}
              fontSizePx={settings.fontSizePx}
              // 只展示几行，预览条保持“条”，不跟随字号撑成整块编辑器。
              className="overflow-hidden rounded-none border-0 bg-background"
              style={{
                ...previewSurfaceStyle(mode),
                // 容器默认 content-visibility: auto 会按 200px 占位，滚动到视口才塌回条高；
                // 预览条尺寸固定，直接关掉这个优化避免设置页滚动时跳动。
                contentVisibility: "visible",
                maxHeight: `${previewHeightPx}px`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
