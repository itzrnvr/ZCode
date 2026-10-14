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
  progress,
  profileIssues,
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
  /** 实时进度推流（关 Chrome 计数、逐 Profile/作用域）；running 期间渲染进度条。 */
  progress: { stage: string; profile?: string; scope?: string; detail?: string } | null;
  profileIssues: Array<{ profile: string; error: string }> | null;
  onToggleScope: (scope: ImportScopeId) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: (
    allowElevated: boolean,
    scopes: Record<ImportScopeId, boolean>,
    options: { closeChromeFirst: boolean },
  ) => void;
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
        {running && progress ? (
          <div
            data-import-progress="true"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            className="space-y-1.5 rounded-lg border border-border px-3 py-2 text-ui-sm"
          >
            <div className="flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin text-foreground-subtle" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage(
                  { id: "settings.browser.import.progressLine" },
                  {
                    stage: intl.formatMessage({
                      id:
                        progress.stage === "closing-chrome"
                          ? "settings.browser.import.progress.closingChrome"
                          : progress.stage === "profile-start"
                            ? "settings.browser.import.progress.profile"
                            : progress.stage === "profile-scope"
                              ? `settings.browser.import.scope.${progress.scope ?? "cookies"}`
                              : progress.stage === "history"
                                ? "settings.browser.import.scope.history"
                                : "settings.browser.import.progress.working",
                    }),
                    profile: progress.profile ?? "",
                    detail: progress.detail ?? "",
                  },
                )}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
            </div>
          </div>
        ) : null}
        {!running && profileIssues && profileIssues.length > 0 ? (
          <div
            data-import-profile-errors="true"
            className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive"
          >
            {profileIssues.map((issue) => (
              <div key={`${issue.profile}:${issue.error}`} className="flex items-start gap-2">
                <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {intl.formatMessage(
                    { id: "settings.browser.import.profileError" },
                    {
                      profile: issue.profile,
                      error: intl.formatMessage({
                        id:
                          issue.error === "chrome_profile_locked"
                            ? "settings.browser.import.profileLocked"
                            : issue.error === "chrome_executable_not_found"
                              ? "settings.browser.import.executableNotFound"
                              : issue.error === "chrome_cookie_access_denied"
                                ? "settings.browser.import.accessDenied"
                                : "settings.browser.import.failed",
                      }),
                    },
                  )}
                </span>
              </div>
            ))}
          </div>
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
                // chrome.exe 后台进程仍存活时，本轮确认先优雅关闭 Chrome
                //（UAC 由随后的 App-Bound 解密 helper 触发）。
                const closeChromeFirst = chromeProcessCount > 0;
                onConfirm(allowElevated, enabledScopes, { closeChromeFirst });
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
