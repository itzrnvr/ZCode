import { useCallback, useEffect, useState } from "react";
import { TID_SETTINGS_SYSTEM_PROMPT_SWITCH } from "@zcode/shared";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  AGENTS_MD_RESOLUTION_ORDER,
  SYSTEM_PROMPT_SECTION_CATALOG,
} from "@/settings/systemPromptCatalog.js";
import { useServices } from "@/hooks/useServices.js";
import type { AppSettings } from "@zcode/shared";

interface SystemPromptSectionProps {
  settings: AppSettings | null;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
  workspacePath?: string;
}

type SwitchKey =
  | "systemPromptSecurityNoticeEnabled"
  | "systemPromptAutoMemoryEnabled"
  | "systemPromptAgentsMdEnabled";

function SwitchRow({
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

function useDebouncedSave(
  initial: string,
  onSave: (value: string) => Promise<void>,
  delayMs = 800,
): [string, (value: string) => void, boolean, () => Promise<void>] {
  const [value, setValue] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setValue(initial);
    setDirty(false);
  }, [initial]);
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      setSaving(true);
      void onSave(value).finally(() => {
        setSaving(false);
        setDirty(false);
      });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [value, dirty, delayMs, onSave]);
  const saveNow = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(value);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [onSave, value]);
  return [
    value,
    (next: string) => {
      setValue(next);
      setDirty(true);
    },
    saving,
    saveNow,
  ];
}

function TextEditor({
  label,
  description,
  value,
  placeholder,
  onSave,
  testIdSuffix,
  rows = 6,
  footer,
}: {
  label: string;
  description: string;
  value: string;
  placeholder: string;
  onSave: (value: string) => Promise<void>;
  testIdSuffix: string;
  rows?: number;
  footer?: string;
}) {
  const [text, setText, saving, saveNow] = useDebouncedSave(value, onSave);
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div className="mb-1 text-ui-base font-medium text-foreground">{label}</div>
      <div className="mb-2 text-ui-sm text-foreground-subtle">{description}</div>
      <SettingsFormTextarea
        rows={rows}
        value={text}
        placeholder={placeholder}
        data-testid={`${TID_SETTINGS_SYSTEM_PROMPT_SWITCH}:${testIdSuffix}`}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void saveNow()}
      />
      <div className="mt-1 text-ui-sm text-foreground-subtlest">
        {saving ? "Saving…" : "Saved automatically on pause or blur. Empty restores the default."}
        {footer ? ` ${footer}` : ""}
      </div>
    </div>
  );
}

function AgentsMdFiles({ workspacePath }: { workspacePath?: string }) {
  const { fileService } = useServices();
  const [previews, setPreviews] = useState<Array<{ path: string; ok: boolean; snippet: string }>>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const candidates = [
    workspacePath ? `${workspacePath}/AGENTS.md` : null,
    "~/.zcode/AGENTS.md",
  ].filter((p): p is string => Boolean(p));
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const rows: Array<{ path: string; ok: boolean; snippet: string }> = [];
      for (const path of candidates) {
        try {
          const slice = await fileService.readTextFile({ path, length: 1200 });
          rows.push({ path, ok: true, snippet: slice.content.slice(0, 600) });
        } catch {
          rows.push({ path, ok: false, snippet: "Not found — create it to take effect." });
        }
      }
      if (!cancelled) {
        setPreviews(rows);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div className="mb-1 text-ui-base font-medium text-foreground">AGENTS.md files</div>
      <div className="mb-2 text-ui-sm text-foreground-subtle">
        Files on disk are the source of truth — edit them in your editor. Resolution order:{" "}
        {AGENTS_MD_RESOLUTION_ORDER.join(" → ")}
      </div>
      {loading ? (
        <div className="text-ui-sm text-foreground-subtlest">Reading files…</div>
      ) : (
        previews.map((row) => (
          <div key={row.path} className="mb-2 last:mb-0">
            <div className="font-mono text-ui-sm text-foreground">
              {row.path} {!row.ok && <span className="text-foreground-subtlest">(missing)</span>}
            </div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-2 py-2 font-mono text-ui-sm text-foreground-subtle">
              {row.snippet}
            </pre>
          </div>
        ))
      )}
    </div>
  );
}

export function SystemPromptSection({ settings, onUpdate, workspacePath }: SystemPromptSectionProps) {
  const { intl } = useZCodeIntl();

  const securityNoticeEnabled = settings?.systemPromptSecurityNoticeEnabled !== false;
  const autoMemoryEnabled = settings?.systemPromptAutoMemoryEnabled !== false;
  const agentsMdEnabled = settings?.systemPromptAgentsMdEnabled !== false;
  const securityNoticeText = settings?.systemPromptSecurityNoticeText ?? "";
  const customText = settings?.systemPromptCustomText ?? "";

  const toggle = (key: SwitchKey) => async (enabled: boolean) => {
    await runUserActionAsync({
      input: {
        featureId: "settings.systemPrompt",
        action: `toggle_${key}`,
        trigger: "switch",
      },
      operation: () => onUpdate({ [key]: enabled }),
      completed: {
        resultSource: "shared_settings",
        stateAfter: enabled ? "enabled" : "disabled",
      },
      failureStage: "settings_commit",
    });
  };

  const saveText =
    (
      key:
        | "systemPromptSecurityNoticeText"
        | "systemPromptCustomText"
        | "systemPromptSectionTexts",
      sectionKey?: string,
    ) =>
    async (value: string | Record<string, string>) => {
      await runUserActionAsync({
        input: {
          featureId: "settings.systemPrompt",
          action: `edit_${sectionKey ?? key}`,
          trigger: "keyboard",
        },
        operation: () => {
          if (key === "systemPromptSectionTexts" && typeof value === "string" && sectionKey) {
            const current = { ...(settings?.systemPromptSectionTexts ?? {}) };
            if (value.trim()) {
              current[sectionKey] = value;
            } else {
              delete current[sectionKey];
            }
            return onUpdate({ systemPromptSectionTexts: current });
          }
          return onUpdate({ [key]: value } as Partial<AppSettings>);
        },
        completed: { resultSource: "shared_settings" },
        failureStage: "settings_commit",
      });
    };

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <div className="px-4 pb-1 pt-4 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPrompt.description" })}
        </div>
        <SwitchRow
          label={intl.formatMessage({ id: "settings.systemPrompt.securityNotice" })}
          description={intl.formatMessage({ id: "settings.systemPrompt.securityNoticeHint" })}
          checked={securityNoticeEnabled}
          onChange={toggle("systemPromptSecurityNoticeEnabled")}
          testIdSuffix="security-notice"
          ariaLabel={intl.formatMessage({ id: "settings.systemPrompt.securityNotice" })}
        />
        <SwitchRow
          label={intl.formatMessage({ id: "settings.systemPrompt.autoMemory" })}
          description={intl.formatMessage({ id: "settings.systemPrompt.autoMemoryHint" })}
          checked={autoMemoryEnabled}
          onChange={toggle("systemPromptAutoMemoryEnabled")}
          testIdSuffix="auto-memory"
          ariaLabel={intl.formatMessage({ id: "settings.systemPrompt.autoMemory" })}
        />
        <SwitchRow
          label={intl.formatMessage({ id: "settings.systemPrompt.agentsMd" })}
          description={intl.formatMessage({ id: "settings.systemPrompt.agentsMdHint" })}
          checked={agentsMdEnabled}
          onChange={toggle("systemPromptAgentsMdEnabled")}
          testIdSuffix="agents-md"
          ariaLabel={intl.formatMessage({ id: "settings.systemPrompt.agentsMd" })}
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <div className="px-4 pb-1 pt-4 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.systemPrompt.editorsTitle" })}
        </div>
        <TextEditor
          label={intl.formatMessage({ id: "settings.systemPrompt.noticeText" })}
          description={intl.formatMessage({ id: "settings.systemPrompt.noticeTextHint" })}
          value={securityNoticeText}
          placeholder={intl.formatMessage({ id: "settings.systemPrompt.noticeTextPlaceholder" })}
          onSave={saveText("systemPromptSecurityNoticeText")}
          testIdSuffix="notice-text"
          rows={5}
        />
        <TextEditor
          label={intl.formatMessage({ id: "settings.systemPrompt.customText" })}
          description={intl.formatMessage({ id: "settings.systemPrompt.customTextHint" })}
          value={customText}
          placeholder={intl.formatMessage({ id: "settings.systemPrompt.customTextPlaceholder" })}
          onSave={saveText("systemPromptCustomText")}
          testIdSuffix="custom-text"
          rows={8}
          footer="Warning: a non-empty value replaces the stable body and skips the dynamic stack."
        />
        <AgentsMdFiles workspacePath={workspacePath} />
      </SettingsGroupCard>
      <SettingsGroupCard>
        <div className="px-4 pb-1 pt-4 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.systemPrompt.catalogTitle" })}
        </div>
        {SYSTEM_PROMPT_SECTION_CATALOG.map((section) => {
          const sectionOverride =
            section.control === "editor" && section.defaultText
              ? (settings?.systemPromptSectionTexts?.[section.key] ?? "")
              : null;
          return (
            <div key={section.key} className="border-t border-border px-4 py-3 first:border-t-0">
              <div className="text-ui-base font-medium text-foreground">{section.name}</div>
              <div className="mb-1 text-ui-sm text-foreground-subtle">{section.description}</div>
              <div className="font-mono text-ui-sm text-foreground-subtlest">
                {section.sourceFile}
              </div>
              <div className="mb-2 text-ui-sm text-foreground-subtlest">
                {section.contentSource} · {section.injection} · {section.control}
              </div>
              {section.control === "editor" && section.defaultText ? (
                <TextEditor
                  label={`${section.name} text`}
                  description="Non-empty replaces the built-in text verbatim. Empty restores the default."
                  value={sectionOverride ?? ""}
                  placeholder={section.defaultText.slice(0, 120)}
                  onSave={saveText("systemPromptSectionTexts", section.key)}
                  testIdSuffix={`section-${section.key}`}
                  rows={6}
                />
              ) : section.defaultText ? (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-2 py-2 font-mono text-ui-sm text-foreground-subtle">
                  {section.defaultText.slice(0, 800)}
                </pre>
              ) : null}
            </div>
          );
        })}
      </SettingsGroupCard>
    </div>
  );
}
