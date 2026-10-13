import { useEffect, useState } from "react";
import { Check, LoaderCircle, TriangleAlertIcon } from "lucide-react";
import type { ChromeBrowserDataImportResult } from "@zcode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

export type ImportScopeId = "cookies" | "passwords" | "history" | "siteData";

export interface ImportScopeState {
  id: ImportScopeId;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
}

const SCOPE_ORDER: ImportScopeId[] = ["cookies", "passwords", "history", "siteData"];

function scopeStateFor(result: ChromeBrowserDataImportResult | null): ImportScopeState[] {
  if (!result) {
    return SCOPE_ORDER.map((id) => ({ id, status: "pending" as const }));
  }
  return [
    {
      id: "cookies" as const,
      status: result.cookies.imported > 0 ? ("done" as const) : ("failed" as const),
      detail: `${result.cookies.imported}`,
    },
    {
      id: "passwords" as const,
      status:
        result.passwords.imported > 0
          ? ("done" as const)
          : result.passwords.skipped > 0
            ? ("skipped" as const)
            : ("failed" as const),
      detail: `${result.passwords.imported}`,
    },
    {
      id: "history" as const,
      status:
        result.history?.visitsCopied === true || result.history?.bookmarksCopied === true
          ? ("done" as const)
          : ("skipped" as const),
    },
    {
      id: "siteData" as const,
      status:
        result.localStorage.originsImported > 0 ? ("done" as const) : ("failed" as const),
      detail: `${result.localStorage.entriesImported}`,
    },
  ];
}

function ScopeIcon({ status }: { status: ImportScopeState["status"] }) {
  if (status === "done") {
    return (
      <span
        aria-label="done"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground"
      >
        <Check aria-hidden="true" className="size-3" />
      </span>
    );
  }
  if (status === "running") {
    return <LoaderCircle aria-hidden="true" className="size-5 shrink-0 animate-spin text-primary" />;
  }
  if (status === "failed") {
    return (
      <span
        aria-label="failed"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-ui-sm font-bold"
      >
        !
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="size-5 shrink-0 rounded-full border border-border"
    />
  );
}

/**
 * Chrome full-import confirm + progress dialog. Scope rows are checkboxes
 * before the run (all on by default), status checkmarks with counts after.
 * A live chrome.exe process counter warns BEFORE starting: Chrome keeps the
 * profile databases locked (background mode keeps chrome.exe alive with no
 * windows) and cookies/passwords cannot be read while it runs.
 */
export function ChromeImportDialog({
  open,
  running,
  result,
  liveScopes,
  enabledScopes,
  chromeProcessCount,
  onToggleScope,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  running: boolean;
  result: ChromeBrowserDataImportResult | null;
  liveScopes: ImportScopeState[] | null;
  enabledScopes: Record<ImportScopeId, boolean>;
  chromeProcessCount: number;
  onToggleScope: (scope: ImportScopeId) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: (allowElevated: boolean, scopes: Record<ImportScopeId, boolean>) => void;
}) {
  const { intl } = useZCodeIntl();
  const [allowElevated, setAllowElevated] = useState(true);
  const scopes = liveScopes ?? scopeStateFor(result);
  const done = result !== null && !running;
  const selectable = !running && !done;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "settings.browser.import.dialogTitle" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.browser.import.dialogDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {selectable && chromeProcessCount > 0 ? (
          <div
            data-import-chrome-running={String(chromeProcessCount)}
            role="status"
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm"
          >
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              {intl.formatMessage(
                { id: "settings.browser.import.chromeRunning" },
                { count: chromeProcessCount },
              )}
            </span>
          </div>
        ) : null}
        <div className="space-y-2 py-2" role="list" aria-label="import scopes">
          {scopes.map((scope) =>
            selectable ? (
              <label
                key={scope.id}
                data-import-scope={scope.id}
                data-import-status={scope.status}
                data-import-enabled={enabledScopes[scope.id] ? "true" : "false"}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <input
                  type="checkbox"
                  checked={enabledScopes[scope.id]}
                  onChange={() => onToggleScope(scope.id)}
                  aria-label={intl.formatMessage({ id: `settings.browser.import.scope.${scope.id}` })}
                  className="size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-ui-base font-medium">
                    {intl.formatMessage({ id: `settings.browser.import.scope.${scope.id}` })}
                  </div>
                  <div className="truncate text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: `settings.browser.import.scope.${scope.id}.hint` })}
                    {scope.detail ? ` · ${scope.detail}` : ""}
                  </div>
                </div>
              </label>
            ) : (
              <div
                key={scope.id}
                role="listitem"
                data-import-scope={scope.id}
                data-import-status={scope.status}
                className={cn(
                  "flex items-center gap-3 rounded-lg border border-border px-3 py-2",
                  scope.status === "running" && "border-primary",
                )}
              >
                <ScopeIcon status={scope.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-ui-base font-medium">
                    {intl.formatMessage({ id: `settings.browser.import.scope.${scope.id}` })}
                  </div>
                  <div className="truncate text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: `settings.browser.import.scope.${scope.id}.hint` })}
                    {scope.detail ? ` · ${scope.detail}` : ""}
                  </div>
                </div>
              </div>
            ),
          )}
        </div>
        {!done ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-ui-sm">
            <input
              type="checkbox"
              checked={allowElevated}
              disabled={running}
              onChange={(event) => setAllowElevated(event.target.checked)}
              className="mt-0.5"
            />
            <span>{intl.formatMessage({ id: "settings.browser.import.adminConsent" })}</span>
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>
            {intl.formatMessage({ id: done ? "common.close" : "common.cancel" })}
          </AlertDialogCancel>
          {!done ? (
            <AlertDialogAction
              disabled={running}
              onClick={(event) => {
                event.preventDefault();
                onConfirm(allowElevated, enabledScopes);
              }}
            >
              {running ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({ id: "settings.browser.import.dialogConfirm" })}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
