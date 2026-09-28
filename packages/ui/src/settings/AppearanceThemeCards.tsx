import { resolveTheme, type Theme } from "@/useTheme.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 主题卡片里的应用缩略图：颜色写死，不跟随当前主题，
 * 否则三张卡片会退化成同一个明暗，用户看不出点击后会变成什么。
 */
interface ThemeChromePalette {
  shell: string;
  sidebar: string;
  sidebarBar: string;
  panel: string;
  panelBar: string;
}

const THEME_CHROME_PALETTES: Record<"light" | "dark", ThemeChromePalette> = {
  light: {
    shell: "#ededed",
    sidebar: "#e2e2e2",
    sidebarBar: "#cdcdcd",
    panel: "#fbfbfb",
    panelBar: "#cfcfcf",
  },
  dark: {
    shell: "#414141",
    sidebar: "#383838",
    sidebarBar: "#4f4f4f",
    panel: "#2f2f2f",
    panelBar: "#4d4d4d",
  },
};

/** 系统主题卡片按竖切比例展示浅色/深色两半。 */
const SYSTEM_LIGHT_SHARE_PERCENT = 34;

/** 纯 CSS 缩略图：侧边栏条 + 内容条，只表达明暗与层级，不模拟真实界面结构。 */
function ThemeChromeThumbnail({ palette }: { palette: ThemeChromePalette }) {
  return (
    <div className="absolute inset-0" style={{ backgroundColor: palette.shell }}>
      <div
        className="absolute inset-y-3 left-3 flex w-[18%] flex-col gap-1.5 rounded-md p-2"
        style={{ backgroundColor: palette.sidebar }}
      >
        <div
          className="h-1.5 w-full rounded-full"
          style={{ backgroundColor: palette.sidebarBar }}
        />
        <div
          className="h-1.5 w-2/3 rounded-full"
          style={{ backgroundColor: palette.sidebarBar }}
        />
      </div>
      <div className="absolute inset-y-3 right-3 flex w-[64%] flex-col gap-1.5">
        <div
          className="h-1.5 w-[52%] rounded-full"
          style={{ backgroundColor: palette.panelBar }}
        />
        <div
          className="h-1.5 w-[34%] rounded-full"
          style={{ backgroundColor: palette.panelBar }}
        />
        <div
          className="mt-1 flex min-h-0 flex-1 flex-col gap-1.5 rounded-md p-2.5"
          style={{ backgroundColor: palette.panel }}
        >
          <div
            className="h-1.5 w-[46%] rounded-full"
            style={{ backgroundColor: palette.panelBar }}
          />
          <div
            className="h-1.5 w-[78%] rounded-full"
            style={{ backgroundColor: palette.panelBar }}
          />
          <div
            className="h-1.5 w-[38%] rounded-full"
            style={{ backgroundColor: palette.panelBar }}
          />
        </div>
      </div>
    </div>
  );
}

function ThemeChromeMock({ theme }: { theme: Theme }) {
  if (theme === "system") {
    return (
      <div className="absolute inset-0">
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - SYSTEM_LIGHT_SHARE_PERCENT}% 0 0)` }}
        >
          <ThemeChromeThumbnail palette={THEME_CHROME_PALETTES.light} />
        </div>
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 0 0 ${SYSTEM_LIGHT_SHARE_PERCENT}%)` }}
        >
          <ThemeChromeThumbnail palette={THEME_CHROME_PALETTES.dark} />
        </div>
      </div>
    );
  }

  return <ThemeChromeThumbnail palette={THEME_CHROME_PALETTES[resolveTheme(theme)]} />;
}

/** 主题卡片的顺序与 THEME_MODES 一致，标签复用设置页已有的主题名文案。 */
const THEME_CARD_OPTIONS: ReadonlyArray<{ theme: Theme; labelId: string }> = [
  { theme: "system", labelId: "settings.themeMode.system" },
  { theme: "zai-light", labelId: "settings.themeMode.zai-light" },
  { theme: "zai-dark", labelId: "settings.themeMode.zai-dark" },
];

export function AppearanceThemeCards({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="grid grid-cols-3 gap-4">
      {THEME_CARD_OPTIONS.map((option) => {
        const isActive = theme === option.theme;

        return (
          <button
            key={option.theme}
            type="button"
            aria-pressed={isActive}
            onClick={() => onThemeChange(option.theme)}
            className="group flex min-w-0 cursor-pointer flex-col items-center gap-2.5 rounded-xl outline-none"
          >
            <span
              className={cn(
                "relative block aspect-[8/5] w-full overflow-hidden rounded-xl border border-border transition-shadow",
                isActive
                  ? "ring-2 ring-brand ring-offset-2 ring-offset-background"
                  : "group-hover:ring-1 group-hover:ring-border-hover",
              )}
            >
              <ThemeChromeMock theme={option.theme} />
            </span>
            <span
              className={cn(
                "text-ui-base transition-colors",
                isActive
                  ? "font-semibold text-foreground"
                  : "font-medium text-foreground-subtle group-hover:text-foreground",
              )}
            >
              {intl.formatMessage({ id: option.labelId })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
