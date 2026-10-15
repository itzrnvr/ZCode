// "Open in editor" for system-prompt section overrides: exports the effective
// text to a stable per-section file (main watches saves and writes them back
// into settings), then opens it with the system default app or a picked editor.
// Mirrors ArtifactOpenAsFileButton's split-button pattern.
import { useCallback, useState } from "react";
import type { EditorInfo, IPlatformService } from "@zcode/shared";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

export interface PromptOverrideExportPayload {
  fileKey: string;
  fileName: string;
  content: string;
}

type ExportCapablePlatform = IPlatformService &
  Required<
    Pick<
      IPlatformService,
      "exportPromptOverrideToFile" | "openExternalFile" | "openInEditor" | "getInstalledEditors"
    >
  >;

function canExport(platform: IPlatformService | null): platform is ExportCapablePlatform {
  return (
    platform !== null &&
    platform.exportPromptOverrideToFile !== undefined &&
    platform.openExternalFile !== undefined &&
    platform.openInEditor !== undefined
  );
}

export function PromptOpenInEditorButton({
  payload,
  labelId,
}: {
  payload: PromptOverrideExportPayload;
  labelId: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [editors, setEditors] = useState<EditorInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canExport(platform)) return null;
  const { openExternalFile, openInEditor } = platform;

  const openWith = useCallback(
    async (
      action: string,
      open: (localPath: string) => Promise<{ success: boolean; error?: string }> | void,
    ) => {
      if (!canExport(platform)) return;
      setBusy(true);
      try {
        const exported = await platform.exportPromptOverrideToFile(payload);
        if ("success" in exported) {
          logger.warn("[system-prompt] 导出覆盖文件失败", { action, error: exported.error });
          return;
        }
        await open(exported.path);
      } catch (error) {
        logger.warn("[system-prompt] 在编辑器中打开失败", { action, error });
      } finally {
        setBusy(false);
      }
    },
    [payload, platform],
  );

  const loadEditors = () => {
    if (editors !== null || !canExport(platform)) return;
    void platform
      .getInstalledEditors()
      .then((installed) => setEditors(sortInstalledEditorsForOpenWith(installed)))
      .catch(() => setEditors([]));
  };

  if (!canExport(platform)) return null;
  const label = intl.formatMessage({ id: labelId });
  const chooseLabel = intl.formatMessage({ id: "appHeader.selectOpenApp" });

  return (
    <DropdownMenu onOpenChange={(open) => open && loadEditors()}>
      <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border bg-input transition-colors hover:border-border-hover">
        <Button
          className="h-7 rounded-none border-0 pr-1"
          data-testid={`prompt-open-in-editor-${payload.fileKey}`}
          disabled={busy}
          onClick={() => void openWith("default-app", (localPath) => openExternalFile(localPath))}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          {label}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={chooseLabel}
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            disabled={busy}
            size="sm"
            type="button"
            variant="ghost"
          >
            <span aria-hidden="true" className="text-[10px] leading-none">
              ▾
            </span>
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {editors === null ? null : (
          editors.map((editor) => (
            <DropdownMenuItem
              key={editor.id}
              onSelect={() => {
                persistLastSelectedEditorId(editor.id);
                void openWith(`editor:${editor.id}`, (localPath) =>
                  openInEditor(editor.id, localPath, { pathKind: "file" }),
                );
              }}
            >
              {editor.name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 已存在的文件（AGENTS.md 等）直接打开，无需导出步骤。 */
export function PromptOpenExistingFileButton({ path, labelId }: { path: string; labelId: string }) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [editors, setEditors] = useState<EditorInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  if (!platform?.openExternalFile || !platform.openInEditor) return null;
  const { openExternalFile, openInEditor, getInstalledEditors } = platform;
  const openWith = (
    action: string,
    open: (localPath: string) => Promise<{ success: boolean; error?: string }>,
  ): void => {
    setBusy(true);
    Promise.resolve(open(path))
      .then((result) => {
        if (!result.success) {
          logger.warn("[system-prompt] 打开文件失败", { action, error: result.error, path });
        }
      })
      .catch((error) => logger.warn("[system-prompt] 打开文件失败", { action, error, path }))
      .finally(() => setBusy(false));
  };
  const loadEditors = () => {
    if (editors !== null) return;
    void getInstalledEditors()
      .then((installed) => setEditors(sortInstalledEditorsForOpenWith(installed)))
      .catch(() => setEditors([]));
  };
  const label = intl.formatMessage({ id: labelId });

  return (
    <DropdownMenu onOpenChange={(open) => open && loadEditors()}>
      <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border bg-input transition-colors hover:border-border-hover">
        <Button
          className="h-7 rounded-none border-0 pr-1"
          data-testid={`prompt-open-file-${path}`}
          disabled={busy}
          onClick={() => openWith("default-app", (localPath) => openExternalFile(localPath))}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          {label}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            disabled={busy}
            size="sm"
            type="button"
            variant="ghost"
          >
            <span aria-hidden="true" className="text-[10px] leading-none">▾</span>
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {editors === null
          ? null
          : editors.map((editor) => (
              <DropdownMenuItem
                key={editor.id}
                onSelect={() => {
                  persistLastSelectedEditorId(editor.id);
                  openWith(`editor:${editor.id}`, (localPath) =>
                    openInEditor(editor.id, localPath, { pathKind: "file" }),
                  );
                }}
              >
                {editor.name}
              </DropdownMenuItem>
            ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
