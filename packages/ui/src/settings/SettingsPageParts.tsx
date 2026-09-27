import type { ReactNode } from "react";
import type { BundledTheme } from "shiki";
import { Card, CardContent } from "@/components/ui/card.js";
import { CODE_PREVIEW_THEME_OPTIONS } from "@/lib/codePreviewPreferences.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";

/**
 * Settings 与同级管理页在窗口框架内共享同一内容列。
 * Automations 曾在 shell 与页面内各自居中、加 padding，导致它与 Skills 等
 * Settings 功能的标题起点、顶部基线和内容宽度不一致。
 */
export const SETTINGS_FRAME_CONTENT_CLASSNAME =
  "mx-auto w-full max-w-4xl px-4 pb-8 pt-0 lg:px-8 lg:pb-10";

export function ThemeSelect({
  value,
  onValueChange,
}: {
  value: BundledTheme;
  onValueChange: (value: BundledTheme) => void;
}) {
  return (
    <Select value={value} onValueChange={(nextValue) => onValueChange(nextValue as BundledTheme)}>
      <SelectTrigger size="lg" className="w-64 min-w-0 justify-between">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CODE_PREVIEW_THEME_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  detail,
  controlLayout = "default",
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  detail?: ReactNode;
  controlLayout?: "default" | "wide";
}) {
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div
        className={cn(
          "grid items-center gap-4",
          controlLayout === "wide"
            ? "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px]"
            : "grid-cols-[minmax(0,1fr)_192px]",
        )}
      >
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-foreground">{label}</div>
          {description ? (
            <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</div>
          ) : null}
        </div>
        <div className="flex w-full flex-nowrap items-center justify-end gap-2">
          {controlLayout === "wide" ? detail : null}
          {control}
        </div>
      </div>
      {detail && controlLayout !== "wide" ? <div className="mt-3">{detail}</div> : null}
    </div>
  );
}

export function SettingsGroupCard({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none">
      <CardContent className="space-y-0 px-0">{children}</CardContent>
    </Card>
  );
}

export function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-surface px-2.5 py-1 text-ui-base font-medium text-foreground-subtle">
      {children}
    </span>
  );
}

export function getThemeOptionLabel(value: BundledTheme): string {
  return CODE_PREVIEW_THEME_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
