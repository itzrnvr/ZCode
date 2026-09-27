// System Prompt settings section (fork).
//
// One catalog row per prompt section, each rendering exactly what its capability
// says (see SystemPromptSectionControls.tsx for the row control stories): an editor
// for text-backed sections, a named switch reference for sections the kill-switches
// above govern, and a Read-only badge with the reason for the rest. AGENTS.md
// resolution and the assembled prompt come from the CLI host, never from renderer-side
// reconstruction.
import { useMemo, useState } from "react";
import { TID_SETTINGS_SYSTEM_PROMPT_SWITCH, type AppSettings } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  AgentsMdResolutionCard,
  SystemPromptPreviewPanel,
} from "@/settings/SystemPromptPreviewPanel.js";
import {
  PromptSectionRow,
  SwitchRow,
  type SystemPromptSwitchKey,
} from "@/settings/SystemPromptSectionControls.js";
import { useSystemPromptPreview } from "@/settings/useSystemPromptPreview.js";
import {
  SYSTEM_PROMPT_GROUP_ORDER,
  SYSTEM_PROMPT_SECTION_CATALOG,
  type EditableSectionTextKey,
  type PromptSectionMeta,
} from "@/settings/systemPromptCatalog.js";

/** Open workspace a preview can target; `workspaceIdentity` keeps remote targets on their own host. */
export interface SystemPromptWorkspaceOption {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
}

interface SystemPromptSectionProps {
  settings: AppSettings | null;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
  /** Active workspace; the preview defaults to it. */
  workspacePath?: string;
  workspaceIdentity?: string;
  /** Other open workspaces, for the preview picker. */
  workspaces?: readonly SystemPromptWorkspaceOption[];
}

function workspaceKeyOf(option: SystemPromptWorkspaceOption | undefined): string {
  return option ? `${option.workspaceIdentity ?? ""}\u0000${option.workspacePath}` : "";
}

export function SystemPromptSection({
  settings,
  onUpdate,
  workspacePath,
  workspaceIdentity,
  workspaces,
}: SystemPromptSectionProps) {
  const { intl } = useZCodeIntl();

  const securityNoticeEnabled = settings?.systemPromptSecurityNoticeEnabled !== false;
  const autoMemoryEnabled = settings?.systemPromptAutoMemoryEnabled !== false;
  const agentsMdEnabled = settings?.systemPromptAgentsMdEnabled !== false;
  const securityNoticeText = settings?.systemPromptSecurityNoticeText ?? "";
  const customText = settings?.systemPromptCustomText ?? "";
  // 保持空 map 的引用稳定：否则每次渲染都会生成新的 overrides 对象，预览请求会无限重发。
  const sectionTexts = useMemo(
    () => settings?.systemPromptSectionTexts ?? {},
    [settings?.systemPromptSectionTexts],
  );
  const memoryEnabled = settings?.memoryEnabled === true;

  const toggle = (key: SystemPromptSwitchKey) => async (enabled: boolean) => {
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

  // Empty text is the clear signal the host reads; keep the dedicated text fields sparse.
  const saveText =
    (key: "systemPromptSecurityNoticeText" | "systemPromptCustomText") => async (value: string) => {
      await onUpdate({ [key]: value.trim() ? value : "" } as Partial<AppSettings>);
    };
  // Section overrides live in one map keyed by the core section key; deleting the key
  // restores the built-in text (the map is authoritative once present).
  const saveSectionText = (sectionKey: EditableSectionTextKey) => async (value: string) => {
    const next = { ...sectionTexts };
    if (value.trim()) {
      next[sectionKey] = value;
    } else {
      delete next[sectionKey];
    }
    await onUpdate({ systemPromptSectionTexts: next });
  };
  const saveOverrideFor = (section: PromptSectionMeta) => {
    if (section.edit?.kind === "section-text") {
      return saveSectionText(section.edit.sectionKey);
    }
    if (section.edit?.kind === "security-notice-text") {
      return saveText("systemPromptSecurityNoticeText");
    }
    if (section.edit?.kind === "custom-prompt-text") {
      return saveText("systemPromptCustomText");
    }
    return async () => undefined;
  };
  const overrideValueFor = (section: PromptSectionMeta): string => {
    if (section.edit?.kind === "section-text") {
      return sectionTexts[section.edit.sectionKey] ?? "";
    }
    if (section.edit?.kind === "security-notice-text") {
      return securityNoticeText;
    }
    if (section.edit?.kind === "custom-prompt-text") {
      return customText;
    }
    return "";
  };

  // Workspace picker: active workspace first, then the other open workspaces.
  const workspaceOptions = useMemo(() => {
    const options: SystemPromptWorkspaceOption[] = [];
    const seen = new Set<string>();
    const add = (option: SystemPromptWorkspaceOption) => {
      const key = workspaceKeyOf(option);
      if (seen.has(key)) return;
      seen.add(key);
      options.push(option);
    };
    if (workspacePath) {
      const active = workspaces?.find(
        (option) =>
          option.workspacePath === workspacePath &&
          (option.workspaceIdentity ?? "") === (workspaceIdentity ?? ""),
      );
      add(
        active ?? {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          label:
            workspacePath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? workspacePath,
        },
      );
    }
    for (const option of workspaces ?? []) {
      add(option);
    }
    return options;
  }, [workspacePath, workspaceIdentity, workspaces]);

  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(null);
  const selectedWorkspace =
    workspaceOptions.find((option) => workspaceKeyOf(option) === selectedWorkspaceKey) ??
    workspaceOptions[0];

  const previewOverrides = useMemo(
    () => ({
      securityNoticeEnabled,
      autoMemoryEnabled,
      agentsMdEnabled,
      ...(securityNoticeText.trim() ? { securityNoticeText } : {}),
      ...(customText.trim() ? { customText } : {}),
      ...(Object.keys(sectionTexts).length > 0 ? { sectionTexts } : {}),
      memoryEnabled,
    }),
    [
      securityNoticeEnabled,
      autoMemoryEnabled,
      agentsMdEnabled,
      securityNoticeText,
      customText,
      sectionTexts,
      memoryEnabled,
    ],
  );
  const preview = useSystemPromptPreview({
    workspacePath: selectedWorkspace?.workspacePath,
    workspaceIdentity: selectedWorkspace?.workspaceIdentity,
    overrides: previewOverrides,
    enabled: Boolean(selectedWorkspace),
  });

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

      {workspaceOptions.length > 0 ? (
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.systemPrompt.workspaceLabel" })}
            description={intl.formatMessage({ id: "settings.systemPrompt.workspaceHint" })}
            control={
              <Select
                value={selectedWorkspaceKey ?? workspaceKeyOf(selectedWorkspace)}
                onValueChange={setSelectedWorkspaceKey}
              >
                <SelectTrigger
                  size="lg"
                  className="w-[260px] min-w-0 justify-between"
                  data-testid={`${TID_SETTINGS_SYSTEM_PROMPT_SWITCH}:workspace`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workspaceOptions.map((option) => (
                    <SelectItem key={workspaceKeyOf(option)} value={workspaceKeyOf(option)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <div className="border-t border-border px-4 py-3 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.systemPrompt.workspaceScopeHint" })}
          </div>
        </SettingsGroupCard>
      ) : (
        <SettingsGroupCard>
          <div className="px-4 py-4 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.systemPrompt.workspaceMissing" })}
          </div>
        </SettingsGroupCard>
      )}

      {selectedWorkspace ? (
        <>
          <AgentsMdResolutionCard preview={preview} />
          <SystemPromptPreviewPanel preview={preview} workspaceLabel={selectedWorkspace.label} />
        </>
      ) : null}

      {SYSTEM_PROMPT_GROUP_ORDER.map((group) => {
        const rows = SYSTEM_PROMPT_SECTION_CATALOG.filter((section) => section.group === group);
        if (rows.length === 0) return null;
        return (
          <SettingsGroupCard key={group}>
            <div className="px-4 pb-1 pt-4 text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: `settings.systemPrompt.group.${group}` })}
            </div>
            {rows.map((section) => (
              <PromptSectionRow
                key={section.key}
                section={section}
                overrideValue={overrideValueFor(section)}
                onSave={saveOverrideFor(section)}
              />
            ))}
          </SettingsGroupCard>
        );
      })}
    </div>
  );
}
