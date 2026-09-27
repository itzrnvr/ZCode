// Row-level controls for the System Prompt settings section.
//
// Kept apart from SystemPromptSection.tsx so the section file stays a container:
// one editor, one capability badge row, and the shared switch row live here.
import { useCallback, useEffect, useRef, useState } from "react";
import { TID_SETTINGS_SYSTEM_PROMPT_SWITCH } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import type { PromptSectionMeta } from "@/settings/systemPromptCatalog.js";

export type SystemPromptSwitchKey =
  | "systemPromptSecurityNoticeEnabled"
  | "systemPromptAutoMemoryEnabled"
  | "systemPromptAgentsMdEnabled";

export const SWITCH_LABEL_IDS: Record<SystemPromptSwitchKey, string> = {
  systemPromptSecurityNoticeEnabled: "settings.systemPrompt.securityNotice",
  systemPromptAutoMemoryEnabled: "settings.systemPrompt.autoMemory",
  systemPromptAgentsMdEnabled: "settings.systemPrompt.agentsMd",
};

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  testIdSuffix,
  ariaLabel,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (enabled: boolean) => Promise<void>;
  testIdSuffix: string;
  ariaLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const handleChange = useCallback(
    (enabled: boolean) => {
      if (busy) return;
      setBusy(true);
      void onChange(enabled).finally(() => setBusy(false));
    },
    [busy, onChange],
  );
  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <Switch
          aria-label={ariaLabel}
          checked={checked}
          disabled={busy}
          data-testid={`${TID_SETTINGS_SYSTEM_PROMPT_SWITCH}:${testIdSuffix}`}
          onCheckedChange={handleChange}
        />
      }
    />
  );
}

/**
 * Text editor for one overridable section.
 *
 * Storage contract (shared with the host): an empty value clears the override, so
 * the built-in text applies again. The textarea therefore shows the effective text
 * — override when present, built-in default otherwise — and only writes when the
 * user actually edits. Both actions exist because they serve different rows:
 * "Reset to default" for rows with a built-in text, "Clear override" for rows whose
 * empty state is the default (full-override prompt).
 */
function OverridableTextEditor({
  description,
  value,
  defaultValue,
  placeholder,
  hint,
  onSave,
  testIdSuffix,
  rows = 6,
}: {
  description: string;
  value: string;
  defaultValue?: string;
  placeholder?: string;
  hint: string;
  onSave: (value: string) => Promise<void>;
  testIdSuffix: string;
  rows?: number;
}) {
  const { intl } = useZCodeIntl();
  const effective = value.trim() ? value : (defaultValue ?? "");
  const [draft, setDraft] = useState(effective);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    setDraft(effective);
    setDirty(false);
  }, [effective]);
  const commit = useCallback(
    async (next: string) => {
      setSaving(true);
      try {
        await onSave(next);
        // 保存期间可能又输入了新内容；只有提交值仍是最新草稿才能清 dirty，
        // 否则新内容会被这次保存误标成已保存而不再触发防抖写入。
        if (draftRef.current === next) {
          setDirty(false);
        }
      } finally {
        setSaving(false);
      }
    },
    [onSave],
  );
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void commit(draft), 800);
    return () => clearTimeout(timer);
  }, [draft, dirty, commit]);
  const hasOverride = value.trim().length > 0;
  const reset = useCallback(async () => {
    setDraft(defaultValue ?? "");
    await commit("");
  }, [commit, defaultValue]);
  return (
    <div className="mt-2">
      <div className="mb-2 text-ui-sm text-foreground-subtle">{description}</div>
      <SettingsFormTextarea
        rows={rows}
        value={draft}
        placeholder={placeholder ?? defaultValue ?? ""}
        data-testid={`${TID_SETTINGS_SYSTEM_PROMPT_SWITCH}:${testIdSuffix}`}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
        }}
        // 未编辑就失焦不能写入：预填的是内置默认文本，写入会凭空产生一条等于默认值的覆盖。
        onBlur={() => {
          if (dirty) void commit(draft);
        }}
      />
      <div className="mt-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 text-ui-sm text-foreground-subtlest">
          {saving
            ? intl.formatMessage({ id: "settings.systemPrompt.editorSaving" })
            : intl.formatMessage({ id: "settings.systemPrompt.editorSaved" })}
          {hint ? ` ${hint}` : ""}
        </span>
        {defaultValue !== undefined ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!hasOverride}
            data-testid={`${TID_SETTINGS_SYSTEM_PROMPT_SWITCH}:reset-${testIdSuffix}`}
            onClick={() => void reset()}
          >
            {intl.formatMessage({ id: "settings.systemPrompt.resetToDefault" })}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!hasOverride}
            data-testid={`${TID_SETTINGS_SYSTEM_PROMPT_SWITCH}:clear-${testIdSuffix}`}
            onClick={() => {
              setDraft("");
              void commit("");
            }}
          >
            {intl.formatMessage({ id: "settings.systemPrompt.clearOverride" })}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Capability story for a row: what the user can do here, and why not more. */
function CapabilityBadges({
  section,
  switchLabel,
}: {
  section: PromptSectionMeta;
  switchLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const capabilityId = `settings.systemPrompt.capability.${section.capability}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={section.capability === "readonly" ? "outline" : "secondary"}>
        {intl.formatMessage({ id: capabilityId })}
      </Badge>
      {section.sessionOnly ? (
        <Badge variant="outline">
          {intl.formatMessage({ id: "settings.systemPrompt.sessionOnlyBadge" })}
        </Badge>
      ) : null}
      {switchLabel ? (
        <span className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.systemPrompt.switchReference" }, { name: switchLabel })}
        </span>
      ) : null}
    </div>
  );
}

export function PromptSectionRow({
  section,
  overrideValue,
  onSave,
}: {
  section: PromptSectionMeta;
  overrideValue: string;
  onSave: (value: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const switchLabel = section.switchKey
    ? intl.formatMessage({ id: SWITCH_LABEL_IDS[section.switchKey] })
    : undefined;
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div className="text-ui-base font-medium text-foreground">{section.name}</div>
      <div className="mb-1.5 text-ui-sm text-foreground-subtle">{section.description}</div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <CapabilityBadges section={section} switchLabel={switchLabel} />
        <span className="font-mono text-ui-sm text-foreground-subtlest">{section.sourceFile}</span>
      </div>
      <div className="text-ui-sm text-foreground-subtlest">
        {section.contentSource} · {section.injection}
      </div>
      <div className="text-ui-sm text-foreground-subtlest">{section.controlNote}</div>
      {section.capability === "editable" ? (
        <OverridableTextEditor
          description={intl.formatMessage({ id: "settings.systemPrompt.editorHint" })}
          value={overrideValue}
          defaultValue={section.defaultText}
          placeholder={
            section.defaultText === undefined
              ? intl.formatMessage({ id: "settings.systemPrompt.customTextPlaceholder" })
              : undefined
          }
          hint={intl.formatMessage({ id: "settings.systemPrompt.editorStorageHint" })}
          onSave={onSave}
          testIdSuffix={`section-${section.key}`}
          rows={section.key === "custom-prompt" ? 8 : 6}
        />
      ) : section.defaultText ? (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
          {section.defaultText}
        </pre>
      ) : null}
    </div>
  );
}
