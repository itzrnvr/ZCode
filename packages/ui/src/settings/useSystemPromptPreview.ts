// Workspace system-prompt preview data hook.
//
// One host request feeds both the AGENTS.md resolution card and the assembled
// prompt panel: the CLI resolves instruction files (walk-up + user-global) and
// assembles the prompt with the same ContextBuilder the turns use.
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ZCodeWorkspaceSystemPromptPreviewOverrides,
  ZCodeWorkspaceSystemPromptPreviewResult,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

export interface SystemPromptPreviewTarget {
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface SystemPromptPreviewState {
  data: ZCodeWorkspaceSystemPromptPreviewResult | null;
  loading: boolean;
  error: unknown | null;
  refresh: () => void;
}

interface PreviewRequestState {
  key: string;
  data: ZCodeWorkspaceSystemPromptPreviewResult | null;
  error: unknown | null;
  inflight: boolean;
}

export function useSystemPromptPreview({
  workspacePath,
  workspaceIdentity,
  overrides,
  enabled,
}: SystemPromptPreviewTarget & {
  overrides?: ZCodeWorkspaceSystemPromptPreviewOverrides;
  enabled: boolean;
}): SystemPromptPreviewState {
  const { zcodeAgentService } = useServices();
  const [state, setState] = useState<PreviewRequestState>({
    key: "",
    data: null,
    error: null,
    inflight: false,
  });
  const [revision, setRevision] = useState(0);
  // overrides 由设置状态每次渲染重建；请求只认内容指纹，不认对象引用。
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  // overrides come from settings state; JSON keeps the effect key stable per content.
  const scopeKey = JSON.stringify([
    workspacePath ?? "",
    workspaceIdentity ?? "",
    overrides ?? null,
    revision,
  ]);

  useEffect(() => {
    if (!enabled || !workspacePath) {
      return;
    }
    let disposed = false;
    setState((previous) => ({ ...previous, inflight: true }));
    void (async () => {
      const requestOverrides = overridesRef.current;
      try {
        const data = await zcodeAgentService.readWorkspaceSystemPromptPreview({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(requestOverrides ? { overrides: requestOverrides } : {}),
        });
        if (!disposed) {
          setState({ key: scopeKey, data, error: null, inflight: false });
        }
      } catch (error) {
        // 只有同一 key 的上一次成功结果可以保留（手动刷新失败）；换 workspace 失败必须
        // 清空，否则旧内容会伪装成新目标的结果。
        if (!disposed) {
          setState((previous) => ({
            key: scopeKey,
            data: previous.key === scopeKey ? previous.data : null,
            error,
            inflight: false,
          }));
        }
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- overrides 以 scopeKey 的内容指纹参与依赖
  }, [enabled, scopeKey, workspacePath, workspaceIdentity, zcodeAgentService]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const matches = state.key === scopeKey;
  return {
    data: matches ? state.data : null,
    error: matches ? state.error : null,
    loading:
      enabled && Boolean(workspacePath) && (!matches || (state.inflight && state.data === null)),
    refresh,
  };
}
