import { useCallback, useState } from "react";
import { TID_SETTINGS_SYSTEM_PROMPT_SWITCH } from "@zcode/shared";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import type { AppSettings } from "@zcode/shared";

interface SystemPromptSectionProps {
  settings: AppSettings | null;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
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

export function SystemPromptSection({ settings, onUpdate }: SystemPromptSectionProps) {
  const { intl } = useZCodeIntl();

  const securityNoticeEnabled = settings?.systemPromptSecurityNoticeEnabled !== false;
  const autoMemoryEnabled = settings?.systemPromptAutoMemoryEnabled !== false;
  const agentsMdEnabled = settings?.systemPromptAgentsMdEnabled !== false;

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
    </div>
  );
}
