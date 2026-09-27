// Edit/retry live-model resolution.
// New file — no upstream merge conflict risk.
// Keeps editUserQuery/retryTurn on the CURRENT provider/model after the user
// switches mid-session, instead of replaying the stale pin recorded at TurnStarted.

import type { ModelSelection } from "@zcode/shared";
import type { V4SessionRecordView } from "./types.js";

/**
 * Prefer the live session selection for edit/retry reruns.
 *
 * LEGACY FALLBACK: a renderer that froze the Composer selection now sends it in
 * the editUserQuery/retryTurn payload, and the command handler consumes that
 * first (`payload.modelSelection ?? resolveEditRetryModelSelection(...)`).
 * This helper still covers older clients that dispatch target+text only.
 *
 * Data flow when the payload is absent:
 * - Handler resolves the canonical editTarget, whose intent.modelSelection is
 *   the session model captured at the original TurnStarted moment.
 * - Core freezes admittedModelSelection = intent ?? live, so the stale pin wins.
 * - Worse, applySubmissionExecutionState persists that stale pin back into the
 *   session, so the switch appears to "revert" (this bug report).
 *
 * Rules:
 * - Live selection present and different from the stale pin → run on live.
 * - Live selection absent → keep caller (usually preserves stale pin, same as before).
 * - Structural clone of live so the caller never aliases runtime's mutable object.
 */
export function resolveEditRetryModelSelection(
  record: V4SessionRecordView,
  staleSelection: ModelSelection | undefined,
): ModelSelection | undefined {
  const live = record.app.runtime?.getSessionModelSelection?.();
  if (!live) {
    return staleSelection;
  }
  if (
    staleSelection &&
    staleSelection.providerId === live.providerId &&
    staleSelection.modelId === live.modelId &&
    staleSelection.options?.reasoningLevel === live.options?.reasoningLevel
  ) {
    return staleSelection;
  }
  return {
    providerId: live.providerId,
    modelId: live.modelId,
    ...(live.options ? { options: { ...live.options } } : {}),
  };
}
