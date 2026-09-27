// Assembled system-prompt preview + AGENTS.md resolution, both fed by the CLI host.
//
// The payload comes from the real ContextBuilder run on the requesting workspace
// (see apps/zcode-cli/.../zcode-protocol/system-prompt-preview.ts): sections are
// shown in assembly order, and instruction files are the walk-up + user-global
// resolution the session itself uses. Nothing here reconstructs prompt text.
import { ChevronDown, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  AGENTS_MD_RESOLUTION_ORDER,
  findCatalogSectionByLiveSourceId,
  SYSTEM_PROMPT_SECTION_CATALOG,
} from "@/settings/systemPromptCatalog.js";
import type { SystemPromptPreviewState } from "@/settings/useSystemPromptPreview.js";

function PreviewStatus({ preview }: { preview: SystemPromptPreviewState }) {
  const { intl } = useZCodeIntl();
  if (preview.loading) {
    return (
      <div className="border-t border-border px-4 py-3 text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "settings.systemPrompt.previewLoading" })}
      </div>
    );
  }
  if (preview.error) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <span className="min-w-0 flex-1 text-ui-sm text-destructive">
          {intl.formatMessage(
            { id: "settings.systemPrompt.previewError" },
            {
              message:
                preview.error instanceof Error
                  ? preview.error.message
                  : String(preview.error),
            },
          )}
        </span>
        <Button variant="outline" size="sm" onClick={preview.refresh}>
          {intl.formatMessage({ id: "settings.systemPrompt.previewRefresh" })}
        </Button>
      </div>
    );
  }
  return null;
}


/** Workspace + user-global AGENTS.md, resolved by the host (walk-up to the git root). */
export function AgentsMdResolutionCard({ preview }: { preview: SystemPromptPreviewState }) {
  const { intl } = useZCodeIntl();
  const files = preview.data?.instructionFiles ?? [];
  return (
    <SettingsGroupCard>
      <div className="px-4 pb-3 pt-4">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.systemPrompt.agentsMdFilesTitle" })}
        </div>
        <div className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPrompt.agentsMdFilesHint" })}
        </div>
      </div>
      <PreviewStatus preview={preview} />
      {!preview.loading && !preview.error ? (
        files.length === 0 ? (
          <div className="border-t border-border px-4 py-3">
            <div className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.systemPrompt.agentsMdNone" })}
            </div>
            <ul className="mt-2 space-y-1">
              {AGENTS_MD_RESOLUTION_ORDER.map((entry) => (
                <li key={entry} className="font-mono text-ui-sm text-foreground-subtlest">
                  {entry}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          files.map((file) => (
            <div key={file.path} className="border-t border-border px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-mono text-ui-sm text-foreground">
                  {file.path}
                </span>
                <Badge variant="secondary">
                  {intl.formatMessage({
                    id:
                      file.scope === "user"
                        ? "settings.systemPrompt.agentsMdScope.user"
                        : "settings.systemPrompt.agentsMdScope.workspace",
                  })}
                </Badge>
                {file.truncated ? (
                  <Badge variant="outline">
                    {intl.formatMessage({ id: "settings.systemPrompt.agentsMdTruncated" })}
                  </Badge>
                ) : null}
              </div>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-2 py-2 font-mono text-ui-sm text-foreground-subtle">
                {file.content.slice(0, 600)}
              </pre>
            </div>
          ))
        )
      ) : null}
    </SettingsGroupCard>
  );
}

/** Collapsible assembled-prompt view: real section order, real separators, real text. */
export function SystemPromptPreviewPanel({
  preview,
  workspaceLabel,
}: {
  preview: SystemPromptPreviewState;
  workspaceLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const sections = preview.data?.sections ?? [];
  const sessionOnlySections = SYSTEM_PROMPT_SECTION_CATALOG.filter(
    (section) => section.sessionOnly === true,
  );
  return (
    <SettingsGroupCard>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="settings-system-prompt-preview-trigger"
            className="flex w-full items-start gap-3 px-4 py-4 text-left"
          >
            <ChevronDown className="mt-0.5 size-4 shrink-0 text-foreground-subtle transition-transform data-[state=open]:rotate-180" />
            <span className="min-w-0 flex-1">
              <span className="block text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.systemPrompt.previewTitle" })}
              </span>
              <span className="mt-1 block text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.systemPrompt.previewHint" })}
              </span>
            </span>
            <span className="shrink-0 text-ui-sm text-foreground-subtlest tabular-nums">
              <span className="mr-2 font-mono">{workspaceLabel}</span>
              {preview.data
                ? intl.formatMessage(
                    { id: "settings.systemPrompt.previewTotals" },
                    {
                      chars: String(preview.data.totalChars),
                      tokens: String(preview.data.totalTokens),
                    },
                  )
                : null}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <PreviewStatus preview={preview} />
          {!preview.loading && !preview.error ? (
            <>
              {sections.length === 0 ? (
                <div className="border-t border-border px-4 py-3 text-ui-sm text-foreground-subtlest">
                  {intl.formatMessage({ id: "settings.systemPrompt.previewEmpty" })}
                </div>
              ) : (
                sections.map((section, index) => {
                  const meta = findCatalogSectionByLiveSourceId(section.id);
                  return (
                    <div
                      key={`${section.id}:${index}`}
                      className="border-t border-border px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-ui-base font-medium text-foreground">
                          {meta?.name ?? section.title}
                        </span>
                        <Badge variant="secondary">
                          {intl.formatMessage({
                            id:
                              section.target === "meta_user"
                                ? "settings.systemPrompt.previewTarget.metaUser"
                                : "settings.systemPrompt.previewTarget.system",
                          })}
                        </Badge>
                        <Badge variant="outline">
                          {intl.formatMessage({
                            id:
                              section.cache === "stable"
                                ? "settings.systemPrompt.previewCache.stable"
                                : "settings.systemPrompt.previewCache.dynamic",
                          })}
                        </Badge>
                        <span className="ml-auto font-mono text-ui-sm text-foreground-subtlest tabular-nums">
                          {intl.formatMessage(
                            { id: "settings.systemPrompt.previewTotals" },
                            { chars: String(section.chars), tokens: String(section.tokens) },
                          )}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-ui-sm text-foreground-subtlest">
                        {meta?.sourceFile ?? section.id}
                      </div>
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
                        {section.text}
                      </pre>
                    </div>
                  );
                })
              )}
              {sessionOnlySections.length > 0 ? (
                <div className="border-t border-border px-4 py-3">
                  <div className="text-ui-sm font-medium text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.systemPrompt.previewSessionOnlyTitle" })}
                  </div>
                  <div className="mt-1 text-ui-sm text-foreground-subtlest">
                    {intl.formatMessage(
                      { id: "settings.systemPrompt.previewSessionOnlyHint" },
                      { sections: sessionOnlySections.map((section) => section.name).join(", ") },
                    )}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
      <div className="flex items-center justify-end border-t border-border px-4 py-2">
        <Button variant="ghost" size="sm" onClick={preview.refresh}>
          <RefreshCw />
          {intl.formatMessage({ id: "settings.systemPrompt.previewRefresh" })}
        </Button>
      </div>
    </SettingsGroupCard>
  );
}
